// Backtest de la config « trader pro » (25/10) — divergence MACD + entrée Fib.
// PAPER / LECTURE SEULE : aucune dépendance au bot (ni db, ni wallet, ni RPC).
// Bougies Binance (ou CSV) → signaux → ordres simulés avec frais → stats.
//
// Règles reçues (texte du trader, codées telles quelles, interprétations notées) :
//   1. Divergence MACD(12,26,9) obligatoire sur 30s-5m :
//        short = prix HH + MACD LH ; long = prix LL + MACD HL.
//   2. Taille +1 par confirmation : divergence RSI(14), divergence de volume.
//   3. Entrée Fib (short) : low entre les 2 highs = 1, nouveau high = 0 ;
//      entrée 1 tick sous le 23,6 ; SL 1 tick au-dessus du 0. Symétrique en long.
//   4. Objectifs sur le Fib du swing PLUS LARGE : TP1 38,2, TP2 ~66 %.
//      SL au break-even seulement en profit (= après TP1).
//   5. S/R du timeframe supérieur pour le contexte. Éviter l'ouverture.
// Interprétations (le texte ne les précise pas) :
//   - pivots = swing high/low à PIVOT barres de chaque côté, confirmés PIVOT
//     barres après coup (aucun regard vers le futur) ;
//   - « swing plus large » = extrême opposé sur MAJOR_LOOKBACK barres ;
//   - divergence de volume = volume du 2e pivot < volume du 1er ;
//   - S/R HTF = pivots du timeframe ×HTF_MULT déjà confirmés, tolérance en ATR ;
//   - « éviter l'ouverture » = fenêtres UTC (ouverture US 13:00-15:00 pour
//     couvrir l'heure d'été/hiver, ouverture daily 23:45-00:15).
// Exécution volontairement PESSIMISTE : dans une bougie qui touche à la fois
// le SL et un TP, le SL passe en premier ; un stop qui gappe est servi au
// pire prix ; frais + slippage à chaque exécution.
//
// Usage :
//   npx tsx scripts/pro-config-backtest.ts --symbol=SOLUSDT --days=180 --tf=1m,3m,5m
//   npx tsx scripts/pro-config-backtest.ts --base=1s --days=14 --tf=30s,1m   (30 s via bougies 1s spot)
//   npx tsx scripts/pro-config-backtest.ts --csv=data/sol-1m.csv --csv-tf=1m
//   npx tsx scripts/pro-config-backtest.ts --synthetic   (contrôle : marche aléatoire → doit perdre ~les frais)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = path.resolve(__dirname, "..", "data", "klines"); // data/ est gitignoré

// ── Arguments ───────────────────────────────────────────────────────────────
const argv = new Map<string, string>();
for (const a of process.argv.slice(2)) {
  const m = a.match(/^--([^=]+)(?:=(.*))?$/);
  if (m) argv.set(m[1], m[2] ?? "true");
}
const arg = (k: string, def: string) => argv.get(k) ?? def;
const numArg = (k: string, def: number) => {
  const v = Number(argv.get(k));
  return Number.isFinite(v) ? v : def;
};

const P = {
  symbol: arg("symbol", "SOLUSDT"),
  market: arg("market", "futures"), // futures (perps, proche de Jupiter Perps) | spot
  base: arg("base", "1m"), // bougie source : 1m, ou 1s (spot seulement) pour le 30 s
  days: numArg("days", 180),
  tfs: arg("tf", "1m,3m,5m").split(",").map((s) => s.trim()),
  csv: argv.get("csv"),
  csvTf: arg("csv-tf", "1m"),
  synthetic: argv.has("synthetic"),
  seed: numArg("seed", 42),
  // Coûts PAR EXÉCUTION (entrée et chaque sortie), en points de base.
  // Défaut 6 bps ≈ frais d'ouverture/fermeture Jupiter Perps ; spot DEX
  // memecoin = 30-100 bps de frais + slippage (à passer explicitement).
  feeBps: numArg("fee-bps", 6),
  slipBps: numArg("slip-bps", 2),
  tick: numArg("tick", 0.01),
  riskPct: numArg("risk-pct", 0.5), // % du capital risqué PAR unité de taille (1 à 3 unités)
  maxLeverage: numArg("max-lev", 5), // plafond notionnel / capital
  pivot: numArg("pivot", 3),
  minGap: numArg("min-gap", 5),
  maxGap: numArg("max-gap", 60),
  entryExpiry: numArg("entry-expiry", 20),
  maxHold: numArg("max-hold", 240),
  majorLookback: numArg("major-lookback", 120),
  macdSrc: arg("macd-src", "line"), // line | hist
  htfSr: arg("htf-sr", "both"), // on | off | both (compare)
  htfMult: numArg("htf-mult", 12),
  srTolAtr: numArg("sr-tol-atr", 0.5),
  avoid: arg("avoid", "13:00-15:00,23:45-00:15"), // "" pour désactiver
  out: argv.get("out"),
};

// ── Bougies ─────────────────────────────────────────────────────────────────
interface Candle {
  t: number; // ouverture, ms UTC
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

function tfMs(tf: string): number {
  const m = tf.match(/^(\d+)([smhd])$/);
  if (!m) throw new Error(`timeframe invalide : ${tf}`);
  const n = Number(m[1]);
  return n * { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "s" | "m" | "h" | "d"];
}

async function fetchBinance(symbol: string, interval: string, days: number, market: string): Promise<Candle[]> {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const cacheFile = path.join(CACHE_DIR, `${market}-${symbol}-${interval}-${days}d.json`);
  if (fs.existsSync(cacheFile) && Date.now() - fs.statSync(cacheFile).mtimeMs < 6 * 3_600_000) {
    return JSON.parse(fs.readFileSync(cacheFile, "utf8")) as Candle[];
  }
  if (market === "futures" && interval === "1s") throw new Error("bougies 1s : --market=spot uniquement");
  const baseUrl =
    market === "futures"
      ? "https://fapi.binance.com/fapi/v1/klines"
      : "https://data-api.binance.vision/api/v3/klines";
  const limit = market === "futures" ? 1500 : 1000;
  const step = tfMs(interval);
  const end = Date.now();
  let start = end - days * 86_400_000;
  const out: Candle[] = [];
  while (start < end) {
    const url = `${baseUrl}?symbol=${symbol}&interval=${interval}&startTime=${start}&limit=${limit}`;
    let rows: unknown[][] | null = null;
    for (let attempt = 0; attempt < 5 && !rows; attempt++) {
      try {
        const res = await fetch(url);
        if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
        if (!res.ok) throw new Error(`HTTP ${res.status} : ${await res.text()}`);
        rows = (await res.json()) as unknown[][];
      } catch (err) {
        if (attempt === 4) throw err;
        await new Promise((r) => setTimeout(r, 1_000 * 2 ** attempt));
      }
    }
    if (!rows || rows.length === 0) break;
    for (const r of rows) {
      out.push({ t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]) });
    }
    start = Number(rows[rows.length - 1][0]) + step;
    process.stderr.write(`\r[binance] ${interval} ${out.length} bougies…`);
    await new Promise((r) => setTimeout(r, 120));
  }
  process.stderr.write("\n");
  // La dernière bougie est en cours de formation → retirée.
  const closed = out.filter((c) => c.t + step <= end);
  fs.writeFileSync(cacheFile, JSON.stringify(closed));
  return closed;
}

function readCsv(file: string): Candle[] {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  const out: Candle[] = [];
  for (const line of lines) {
    const f = line.split(/[,;\t]/).map((s) => s.trim());
    const t = Number(f[0]);
    if (!Number.isFinite(t)) continue; // en-tête
    out.push({ t: t < 1e12 ? t * 1000 : t, o: +f[1], h: +f[2], l: +f[3], c: +f[4], v: +f[5] });
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Marche aléatoire log-normale (σ journalière ~4 %, profil SOL) : contrôle anti-biais. */
function syntheticCandles(days: number, seed: number): Candle[] {
  let s = seed >>> 0;
  const rnd = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return (s + 0.5) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const n = days * 1440;
  const sigma1m = 0.04 / Math.sqrt(1440);
  const out: Candle[] = [];
  let price = 150;
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < n; i++) {
    // 6 sous-pas par minute pour des mèches réalistes
    const o = price;
    let h = o;
    let l = o;
    for (let k = 0; k < 6; k++) {
      price *= Math.exp(gauss() * sigma1m / Math.sqrt(6));
      h = Math.max(h, price);
      l = Math.min(l, price);
    }
    const r = (x: number) => Math.round(x * 100) / 100;
    out.push({ t: t0 + i * 60_000, o: r(o), h: r(h), l: r(l), c: r(price), v: Math.exp(gauss() * 0.6) * 1000 });
  }
  return out;
}

function aggregate(base: Candle[], ms: number): Candle[] {
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (const c of base) {
    const bucket = Math.floor(c.t / ms) * ms;
    if (!cur || cur.t !== bucket) {
      if (cur) out.push(cur);
      cur = { t: bucket, o: c.o, h: c.h, l: c.l, c: c.c, v: c.v };
    } else {
      cur.h = Math.max(cur.h, c.h);
      cur.l = Math.min(cur.l, c.l);
      cur.c = c.c;
      cur.v += c.v;
    }
  }
  if (cur) out.push(cur);
  return out;
}

// ── Indicateurs ─────────────────────────────────────────────────────────────
function ema(xs: number[], n: number): number[] {
  const k = 2 / (n + 1);
  const out: number[] = new Array(xs.length);
  let e = xs[0];
  for (let i = 0; i < xs.length; i++) {
    e = i === 0 ? xs[0] : xs[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

function macd(closes: number[]): { line: number[]; hist: number[] } {
  const e12 = ema(closes, 12);
  const e26 = ema(closes, 26);
  const line = closes.map((_, i) => e12[i] - e26[i]);
  const signal = ema(line, 9);
  return { line, hist: line.map((x, i) => x - signal[i]) };
}

function rsiSeries(closes: number[], n = 14): number[] {
  const out: number[] = new Array(closes.length).fill(50);
  let g = 0;
  let l = 0;
  for (let i = 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const gain = Math.max(0, d);
    const loss = Math.max(0, -d);
    if (i <= n) {
      g += gain / n;
      l += loss / n;
    } else {
      g = (g * (n - 1) + gain) / n;
      l = (l * (n - 1) + loss) / n;
    }
    out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return out;
}

function atrSeries(cs: Candle[], n = 14): number[] {
  const out: number[] = new Array(cs.length).fill(0);
  let a = 0;
  for (let i = 0; i < cs.length; i++) {
    const tr = i === 0 ? cs[i].h - cs[i].l : Math.max(cs[i].h - cs[i].l, Math.abs(cs[i].h - cs[i - 1].c), Math.abs(cs[i].l - cs[i - 1].c));
    a = i === 0 ? tr : (a * (n - 1) + tr) / n;
    out[i] = a;
  }
  return out;
}

/** Pivots : extrême strict à gauche, ≥ à droite sur `k` barres. Confirmé à i + k. */
function pivots(cs: Candle[], k: number, kind: "high" | "low"): number[] {
  const idx: number[] = [];
  const val = (i: number) => (kind === "high" ? cs[i].h : -cs[i].l);
  for (let i = k; i < cs.length - k; i++) {
    let ok = true;
    for (let j = i - k; j < i && ok; j++) if (val(j) >= val(i)) ok = false;
    for (let j = i + 1; j <= i + k && ok; j++) if (val(j) > val(i)) ok = false;
    if (ok) idx.push(i);
  }
  return idx;
}

// ── Contexte : S/R du timeframe supérieur, fenêtres d'ouverture ─────────────
interface SrLevel {
  price: number;
  confirmedAt: number; // ms : instant où le pivot HTF devient connu
}

function htfLevels(cs: Candle[], ms: number, mult: number, k: number) {
  const htfMs = ms * mult;
  const htf = aggregate(cs, htfMs);
  const atr = atrSeries(htf);
  const mk = (kind: "high" | "low"): SrLevel[] =>
    pivots(htf, k, kind).map((i) => ({
      price: kind === "high" ? htf[i].h : htf[i].l,
      confirmedAt: htf[i + k].t + htfMs, // clôture de la barre de confirmation
    }));
  return { highs: mk("high"), lows: mk("low"), htf, atr, htfMs };
}

function nearSr(levels: SrLevel[], price: number, now: number, tol: number, maxLevels = 10): boolean {
  let seen = 0;
  for (let i = levels.length - 1; i >= 0 && seen < maxLevels; i--) {
    if (levels[i].confirmedAt > now) continue;
    seen++;
    if (Math.abs(levels[i].price - price) <= tol) return true;
  }
  return false;
}

const avoidWindows = P.avoid
  ? P.avoid.split(",").map((w) => {
      const [a, b] = w.split("-").map((hm) => {
        const [h, m] = hm.split(":").map(Number);
        return h * 60 + m;
      });
      return { a, b };
    })
  : [];

function inAvoidWindow(t: number): boolean {
  const d = new Date(t);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  return avoidWindows.some(({ a, b }) => (a <= b ? m >= a && m < b : m >= a || m < b));
}

// ── Signaux ─────────────────────────────────────────────────────────────────
interface Setup {
  side: "long" | "short";
  confirmIdx: number; // barre à la clôture de laquelle le signal est connu
  entry: number;
  sl: number;
  tp1: number;
  tp2: number;
  units: number; // 1 + divergence RSI + divergence volume
}

function findSetups(cs: Candle[], ms: number, useHtf: boolean): Setup[] {
  const closes = cs.map((c) => c.c);
  const m = macd(closes);
  const osc = P.macdSrc === "hist" ? m.hist : m.line;
  const rsi = rsiSeries(closes, 14);
  const k = P.pivot;
  const ctx = useHtf ? htfLevels(cs, ms, P.htfMult, 3) : null;
  // ATR de la dernière barre HTF CLOSE à l'instant t (recherche binaire : les
  // trous de données Binance décalent les index, pas les timestamps).
  const htfAtrAt = (t: number) => {
    if (!ctx) return 0;
    let lo = 0;
    let hi = ctx.htf.length - 1;
    let j = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (ctx.htf[mid].t + ctx.htfMs <= t) {
        j = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return j >= 0 ? ctx.atr[j] : 0;
  };
  const volAround = (i: number) => cs[i - 1].v + cs[i].v + (cs[i + 1]?.v ?? 0);
  const setups: Setup[] = [];

  for (const kind of ["high", "low"] as const) {
    const piv = pivots(cs, k, kind);
    for (let n = 1; n < piv.length; n++) {
      const i1 = piv[n - 1];
      const i2 = piv[n];
      const gap = i2 - i1;
      if (gap < P.minGap || gap > P.maxGap) continue;
      const c = i2 + k; // confirmation
      if (c >= cs.length - 1 || i2 < 60) continue; // 60 barres de chauffe MACD
      const t = cs[c].t + ms; // clôture de la barre de confirmation
      if (inAvoidWindow(t)) continue;

      if (kind === "high") {
        // SHORT : prix HH + MACD LH
        if (!(cs[i2].h > cs[i1].h && osc[i2] < osc[i1])) continue;
        const hi = cs[i2].h;
        let lowBetween = Infinity;
        for (let j = i1; j <= i2; j++) lowBetween = Math.min(lowBetween, cs[j].l);
        let majorLow = Infinity;
        for (let j = Math.max(0, i2 - P.majorLookback); j <= i2; j++) majorLow = Math.min(majorLow, cs[j].l);
        const entry = hi - 0.236 * (hi - lowBetween) - P.tick;
        const sl = hi + P.tick;
        const tp1 = hi - 0.382 * (hi - majorLow);
        const tp2 = hi - 0.66 * (hi - majorLow);
        if (!(tp1 < entry - P.tick && entry < sl)) continue;
        if (ctx && !nearSr(ctx.highs, hi, t, P.srTolAtr * htfAtrAt(t))) continue;
        const units = 1 + (rsi[i2] < rsi[i1] ? 1 : 0) + (volAround(i2) < volAround(i1) ? 1 : 0);
        setups.push({ side: "short", confirmIdx: c, entry, sl, tp1, tp2, units });
      } else {
        // LONG : prix LL + MACD HL
        if (!(cs[i2].l < cs[i1].l && osc[i2] > osc[i1])) continue;
        const lo = cs[i2].l;
        let highBetween = -Infinity;
        for (let j = i1; j <= i2; j++) highBetween = Math.max(highBetween, cs[j].h);
        let majorHigh = -Infinity;
        for (let j = Math.max(0, i2 - P.majorLookback); j <= i2; j++) majorHigh = Math.max(majorHigh, cs[j].h);
        const entry = lo + 0.236 * (highBetween - lo) + P.tick;
        const sl = lo - P.tick;
        const tp1 = lo + 0.382 * (majorHigh - lo);
        const tp2 = lo + 0.66 * (majorHigh - lo);
        if (!(tp1 > entry + P.tick && entry > sl)) continue;
        if (ctx && !nearSr(ctx.lows, lo, t, P.srTolAtr * htfAtrAt(t))) continue;
        const units = 1 + (rsi[i2] > rsi[i1] ? 1 : 0) + (volAround(i2) < volAround(i1) ? 1 : 0);
        setups.push({ side: "long", confirmIdx: c, entry, sl, tp1, tp2, units });
      }
    }
  }
  return setups.sort((a, b) => a.confirmIdx - b.confirmIdx);
}

// ── Simulation des ordres ───────────────────────────────────────────────────
interface Trade {
  side: "long" | "short";
  openT: number;
  closeT: number;
  units: number;
  stopBps: number; // distance entrée→SL en bps du prix
  pnlPct: number; // net, en % du capital initial
  grossPct: number; // hors frais/slippage
  costPct: number;
  r: number; // net, en multiples du risque prévu
  exit: string;
}

function simulate(cs: Candle[], setups: Setup[]): Trade[] {
  const trades: Trade[] = [];
  const costRate = (P.feeBps + P.slipBps) / 10_000;
  let busyUntil = -1; // une seule position/ordre à la fois

  for (const s of setups) {
    if (s.confirmIdx <= busyUntil) continue;
    const dir = s.side === "long" ? 1 : -1;
    const risk = Math.abs(s.entry - s.sl);
    // Taille : riskPct % du capital par unité, plafonnée par le levier max.
    let notional = (s.units * P.riskPct) / 100 / (risk / s.entry); // en fraction du capital
    notional = Math.min(notional, P.maxLeverage);
    const plannedRiskPct = notional * (risk / s.entry) * 100;

    // 1) Attente du remplissage. Ordre stop si le marché est « avant » le
    //    niveau à l'armement, limite sinon (repli vers le niveau).
    const armClose = cs[s.confirmIdx].c;
    const isStop = dir === 1 ? armClose < s.entry : armClose > s.entry;
    let fillIdx = -1;
    let fillPx = 0;
    let lastIdx = s.confirmIdx;
    for (let b = s.confirmIdx + 1; b < cs.length && b <= s.confirmIdx + P.entryExpiry; b++) {
      const c = cs[b];
      lastIdx = b;
      const touched = isStop
        ? dir === 1 ? c.h >= s.entry : c.l <= s.entry
        : dir === 1 ? c.l <= s.entry : c.h >= s.entry;
      if (touched) {
        fillIdx = b;
        // stop qui gappe → servi à l'ouverture (pire) ; limite → au niveau.
        fillPx = isStop ? (dir === 1 ? Math.max(c.o, s.entry) : Math.min(c.o, s.entry)) : s.entry;
        break;
      }
      // invalidation : le 0 du Fib est cassé avant l'entrée
      if (dir === 1 ? c.l <= s.sl : c.h >= s.sl) break;
    }
    if (fillIdx < 0) {
      busyUntil = lastIdx;
      continue;
    }

    // 2) Gestion : moitié à TP1 (puis SL au BE), moitié à TP2. SL d'abord.
    let open = 1; // fraction restante
    let sl = s.sl;
    let gross = 0; // en fraction du notionnel
    let costs = costRate; // entrée
    let exit = "";
    let b = fillIdx;
    const move = (px: number) => (dir * (px - fillPx)) / fillPx;
    for (; b < cs.length && open > 0; b++) {
      const c = cs[b];
      const hitSl = dir === 1 ? c.l <= sl : c.h >= sl;
      if (hitSl) {
        const px = b === fillIdx ? sl : dir === 1 ? Math.min(c.o, sl) : Math.max(c.o, sl);
        gross += open * move(px);
        costs += open * costRate;
        exit = exit ? `${exit}+${sl === s.sl ? "SL" : "BE"}` : sl === s.sl ? "SL" : "BE";
        open = 0;
        break;
      }
      if (open === 1 && (dir === 1 ? c.h >= s.tp1 : c.l <= s.tp1)) {
        gross += 0.5 * move(s.tp1);
        costs += 0.5 * costRate;
        open = 0.5;
        sl = fillPx; // break-even, uniquement une fois en profit
        exit = "TP1";
        // même bougie : on suppose le pire (retour au BE) si le BE est touché
        if (dir === 1 ? c.l <= sl : c.h >= sl) {
          gross += 0.5 * move(sl);
          costs += 0.5 * costRate;
          open = 0;
          exit = "TP1+BE";
          break;
        }
      }
      if (open === 0.5 && (dir === 1 ? c.h >= s.tp2 : c.l <= s.tp2)) {
        gross += 0.5 * move(s.tp2);
        costs += 0.5 * costRate;
        open = 0;
        exit = "TP1+TP2";
        break;
      }
      if (b - fillIdx >= P.maxHold) {
        gross += open * move(c.c);
        costs += open * costRate;
        exit = exit ? `${exit}+TIME` : "TIME";
        open = 0;
        break;
      }
    }
    if (open > 0) continue; // fin des données : trade non clos, ignoré
    busyUntil = b;
    const grossPct = gross * notional * 100;
    const costPct = costs * notional * 100;
    const pnlPct = grossPct - costPct;
    trades.push({
      side: s.side,
      openT: cs[fillIdx].t,
      closeT: cs[Math.min(b, cs.length - 1)].t,
      units: s.units,
      stopBps: (risk / s.entry) * 10_000,
      pnlPct,
      grossPct,
      costPct,
      r: pnlPct / plannedRiskPct,
      exit,
    });
  }
  return trades;
}

// ── Statistiques ────────────────────────────────────────────────────────────
interface Stats {
  trades: number;
  winRate: number;
  avgR: number;
  profitFactor: number;
  totalPct: number;
  grossPct: number;
  costPct: number;
  maxDdPct: number;
  medianStopBps: number;
  days: number;
  greenDaysPct: number; // jours calendaires avec PnL > 0
  redDaysPct: number;
  worstDayPct: number;
  longestRedStreak: number; // jours de trading consécutifs négatifs
  perDayPct: number;
}

function stats(trades: Trade[], t0: number, t1: number): Stats {
  const n = trades.length;
  const wins = trades.filter((t) => t.pnlPct > 0);
  const gw = wins.reduce((a, t) => a + t.pnlPct, 0);
  const gl = -trades.filter((t) => t.pnlPct <= 0).reduce((a, t) => a + t.pnlPct, 0);
  let eq = 0;
  let peak = 0;
  let dd = 0;
  for (const t of trades) {
    eq += t.pnlPct;
    peak = Math.max(peak, eq);
    dd = Math.max(dd, peak - eq);
  }
  const byDay = new Map<number, number>();
  for (const t of trades) {
    const d = Math.floor(t.closeT / 86_400_000);
    byDay.set(d, (byDay.get(d) ?? 0) + t.pnlPct);
  }
  const days = Math.max(1, Math.round((t1 - t0) / 86_400_000));
  const dayVals = [...byDay.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
  let streak = 0;
  let longest = 0;
  for (const v of dayVals) {
    streak = v < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
  }
  const stops = trades.map((t) => t.stopBps).sort((a, b) => a - b);
  const total = trades.reduce((a, t) => a + t.pnlPct, 0);
  return {
    trades: n,
    winRate: n ? wins.length / n : 0,
    avgR: n ? trades.reduce((a, t) => a + t.r, 0) / n : 0,
    profitFactor: gl > 0 ? gw / gl : gw > 0 ? Infinity : 0,
    totalPct: total,
    grossPct: trades.reduce((a, t) => a + t.grossPct, 0),
    costPct: trades.reduce((a, t) => a + t.costPct, 0),
    maxDdPct: dd,
    medianStopBps: stops.length ? stops[Math.floor(stops.length / 2)] : 0,
    days,
    greenDaysPct: (dayVals.filter((v) => v > 0).length / days) * 100,
    redDaysPct: (dayVals.filter((v) => v < 0).length / days) * 100,
    worstDayPct: dayVals.length ? Math.min(...dayVals) : 0,
    longestRedStreak: longest,
    perDayPct: total / days,
  };
}

function fmt(s: Stats): string {
  const f = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : "∞");
  return [
    `trades ${s.trades}`,
    `gagnants ${f(s.winRate * 100, 0)} %`,
    `R moyen ${f(s.avgR)}`,
    `PF ${f(s.profitFactor)}`,
    `total ${f(s.totalPct)} % (brut ${f(s.grossPct)} %, frais ${f(s.costPct)} %)`,
    `par jour ${f(s.perDayPct, 3)} %`,
    `DD max ${f(s.maxDdPct)} %`,
    `stop médian ${f(s.medianStopBps, 0)} bps`,
    `jours verts ${f(s.greenDaysPct, 0)} % / rouges ${f(s.redDaysPct, 0)} %`,
    `pire jour ${f(s.worstDayPct)} %`,
    `série rouge max ${s.longestRedStreak} j`,
  ].join(" · ");
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  let base: Candle[];
  let baseTf: string;
  let source: string;
  if (P.synthetic) {
    base = syntheticCandles(P.days, P.seed);
    baseTf = "1m";
    source = `synthétique (marche aléatoire σ 4 %/j, seed ${P.seed})`;
  } else if (P.csv) {
    base = readCsv(P.csv);
    baseTf = P.csvTf;
    source = `CSV ${P.csv}`;
  } else {
    baseTf = P.base;
    base = await fetchBinance(P.symbol, P.base, P.days, P.base === "1s" ? "spot" : P.market);
    source = `Binance ${P.base === "1s" ? "spot" : P.market} ${P.symbol}`;
  }
  if (base.length < 500) throw new Error(`pas assez de bougies (${base.length})`);
  const t0 = base[0].t;
  const t1 = base[base.length - 1].t;
  console.log(`Source : ${source} · ${base.length} bougies ${baseTf} · ${new Date(t0).toISOString().slice(0, 10)} → ${new Date(t1).toISOString().slice(0, 10)}`);
  console.log(`Coûts : ${P.feeBps} bps frais + ${P.slipBps} bps slippage PAR exécution · risque ${P.riskPct} %/unité (1-3 unités) · levier max ${P.maxLeverage}×`);
  console.log(`Fenêtres évitées (UTC) : ${P.avoid || "aucune"} · pivots ${P.pivot} barres · MACD ${P.macdSrc}\n`);

  const results: Record<string, unknown>[] = [];
  const htfModes = P.htfSr === "both" ? [false, true] : [P.htfSr === "on"];
  for (const tf of P.tfs) {
    const ms = tfMs(tf);
    if (ms < tfMs(baseTf)) {
      console.log(`${tf} : ignoré (bougie source ${baseTf} trop grosse — utiliser --base=1s)`);
      continue;
    }
    const cs = ms === tfMs(baseTf) ? base : aggregate(base, ms);
    const mid = cs[Math.floor(cs.length / 2)].t;
    for (const useHtf of htfModes) {
      const trades = simulate(cs, findSetups(cs, ms, useHtf));
      const label = `${tf.padEnd(3)} ${useHtf ? "avec S/R HTF" : "sans S/R HTF"}`;
      const all = stats(trades, t0, t1);
      const h1 = stats(trades.filter((t) => t.openT < mid), t0, mid);
      const h2 = stats(trades.filter((t) => t.openT >= mid), mid, t1);
      console.log(`■ ${label}\n  TOUT     ${fmt(all)}\n  1re moit ${fmt(h1)}\n  2e moit  ${fmt(h2)}`);
      const exits = new Map<string, number>();
      for (const t of trades) exits.set(t.exit, (exits.get(t.exit) ?? 0) + 1);
      console.log(`  sorties  ${[...exits.entries()].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${v}`).join(" · ")}\n`);
      results.push({ tf, htfSr: useHtf, all, firstHalf: h1, secondHalf: h2, exits: Object.fromEntries(exits) });
    }
  }
  if (P.out) {
    fs.writeFileSync(P.out, JSON.stringify({ params: P, source, results }, null, 2));
    console.log(`JSON → ${P.out}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
