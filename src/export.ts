// Export JSON pour le dashboard (data/export/*.json). Le dashboard ne lit JAMAIS la DB
// en mode export — il lit ces fichiers (ou la DB directement si DASHBOARD_LIVE=true).

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { db } from "./db.js";
import { config, labMode } from "./config.js";
import { getPortfolioSummary, getOpenPositions } from "./paper.js";
import { getRules, getRuleChanges } from "./rules.js";
import { bucketStats } from "./tuner.js";

// --- Prix SOL/USD temps réel (API CoinGecko, cache 60 s, fallback stale) ---
let solPriceCache: { price: number | null; fetchedAt: number } = { price: null, fetchedAt: 0 };
// Jupiter /price/v2 renvoie 404 (endpoint changé, 2026-08) → CoinGecko (1 req/min max avec le cache).

async function fetchSolPriceUsd(): Promise<number | null> {
  // Source 1 — CoinGecko. ⚠️ 29/09/2026 : 403 Cloudflare systématique depuis
  // Node/undici (curl passe, pas le fetch natif) → prix SOL null => dry-runs
  // L4-B bloqués « Prix SOL indisponible » + real-monitor retombe sur 93$.
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(8000) }
    );
    if (res.ok) {
      const data = (await res.json()) as { solana?: { usd?: number } };
      const price = Number(data.solana?.usd);
      if (Number.isFinite(price) && price > 0) return price;
    }
  } catch {
    /* fallback ci-dessous */
  }
  // Source 2 (fallback ajoute 29/09) — DeFi Llama, meme unite USD, 200 OK
  // quand CoinGecko 403 (verifie 29/09 14:15 : 120.07$ confidence 0.99).
  try {
    const res = await fetch(
      "https://coins.llama.fi/prices/current/coingecko:solana",
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { coins?: Record<string, { price?: number }> };
    const price = Number(data.coins?.["coingecko:solana"]?.price);
    return Number.isFinite(price) && price > 0 ? price : null;
  } catch {
    return null;
  }
}

/** Prix SOL/USD : frais si le cache a < 60 s, sinon stale (≤ 1 h), sinon null. */
export async function getSolPriceUsd(): Promise<number | null> {
  const now = Date.now();
  if (solPriceCache.price !== null && now - solPriceCache.fetchedAt < 60_000) {
    return solPriceCache.price;
  }
  const fresh = await fetchSolPriceUsd();
  if (fresh !== null) {
    solPriceCache = { price: fresh, fetchedAt: now };
    return fresh;
  }
  if (solPriceCache.price !== null && now - solPriceCache.fetchedAt < 3_600_000) {
    return solPriceCache.price; // stale toléré 1 h
  }
  return null;
}

/** Nom d'affichage : l'API renvoie parfois des noms vides ou "-SOL" (pool
 * sans nom) — fallback sur les symboles token_x-token_y (leçon 2026-08-23 :
 * opportunité « -SOL » = CYBERLEEK). */
function displayName(name: unknown, x: unknown, y: unknown): string {
  const n = String(name ?? "").trim();
  if (n && !n.startsWith("-")) return n;
  return `${String(x ?? "X")}-${String(y ?? "Y")}`;
}

export async function exportData(): Promise<string> {
  const dir = path.join(config.dataDir, "export");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();
  const solPriceUsd = await getSolPriceUsd();
  const lastScan = db
    .prepare(
      `SELECT * FROM pool_scans WHERE scanned_at = (SELECT MAX(scanned_at) FROM pool_scans) ORDER BY score DESC`
    )
    .all() as Record<string, unknown>[];

  const opportunities = lastScan
    .filter((r) => (r.score as number) > 0)
    .slice(0, 50)
    .map((r) => ({
      pool_address: r.pool_address,
      name: displayName(r.name, r.token_x_symbol, r.token_y_symbol),
      tvl: r.tvl,
      volume_24h: r.volume_24h,
      volume_1h: r.volume_1h,
      volume_30m: r.volume_30m,
      fee_apr_24h: r.fee_apr_24h,
      fee_tvl_ratio_24h: r.fee_tvl_ratio_24h,
      fee_tvl_ratio_30m: r.fee_tvl_ratio_30m,
      dynamic_fee_pct: r.dynamic_fee_pct,
      pool_age_days: r.pool_age_days,
      bin_step: r.bin_step,
      current_price: r.current_price,
      vol_24h: r.vol_24h,
      score: r.score,
      signals: safeJson(r.signals as string),
      strategy_hint: safeJson(r.strategy_hint as string),
    }));

  const positions = getOpenPositions().map((p) => {
    const fees = (p.fees_earned_usd ?? 0) + (p.fees_claimed_usd ?? 0);
    const daysOpen = Math.max(0.1, (now - p.opened_at) / 86_400_000);
    // KPI "fees %/jour" (benchmark Djedje20x : 1.03% daily) : rendement quotidien
    // moyen en frais sur le dépôt, depuis l'ouverture.
    const feesPctDay = p.deposit_usd > 0 ? (fees / p.deposit_usd / daysOpen) * 100 : 0;
    return {
      id: p.id,
      opened_at: p.opened_at,
      pool_address: p.pool_address,
      // ⚠️ displayName aussi ici (fix 2026-08-25) : la position réelle
      // CYBERLEEK s'affichait « -SOL » — le fallback n'était appliqué qu'aux
      // opportunités, pas aux positions réelles.
      name: displayName(p.name, p.token_x_symbol, p.token_y_symbol),
      strategy: p.strategy,
      deposit_usd: p.deposit_usd,
      value_usd: p.last_value_usd,
      fees,
      fees_pct_day: feesPctDay,
      il_usd: p.last_il_usd,
      net_pnl: p.last_value_usd - p.deposit_usd + fees,
      min_bin_id: p.min_bin_id,
      max_bin_id: p.max_bin_id,
      entry_price: p.entry_price,
      rebalance_count: p.rebalance_count,
    };
  });

  const closedPositions = (db
    .prepare(
      `SELECT id, name, strategy, deposit_usd, last_value_usd, fees_earned_usd, fees_claimed_usd,
              closed_at, close_reason, rebalance_count FROM paper_positions WHERE status='closed' ORDER BY closed_at DESC LIMIT 50`
    )
    .all() as Record<string, unknown>[]).map((p) => ({
    id: p.id,
    name: p.name,
    strategy: p.strategy,
    deposit_usd: p.deposit_usd,
    value_usd: p.last_value_usd,
    fees: Number(p.fees_earned_usd ?? 0) + Number(p.fees_claimed_usd ?? 0),
    net_pnl:
      Number(p.last_value_usd ?? 0) - Number(p.deposit_usd ?? 0) +
      Number(p.fees_earned_usd ?? 0) + Number(p.fees_claimed_usd ?? 0),
    closed_at: p.closed_at,
    close_reason: p.close_reason,
  }));

  const snapshots = (db
    .prepare(
      `SELECT taken_at, position_id, value_usd, fees_usd, net_pnl_usd FROM pnl_snapshots
       WHERE taken_at > ? ORDER BY taken_at ASC LIMIT 2000`
    )
    .all(now - 7 * 86_400_000) as Record<string, unknown>[]).map((s) => ({
    t: s.taken_at,
    pos: s.position_id,
    v: s.value_usd,
    f: s.fees_usd,
    p: s.net_pnl_usd,
  }));

  // Journal : 48h, sans le bruit des scans/monitors (toutes les 15 min),
  // limité aux événements à valeur (open, close, rebalance, claim, stop, review, tune).
  const events = (db
    .prepare(
      `SELECT created_at, position_id, pool_address, type, message FROM events
       WHERE created_at > ? AND type NOT IN ('scan', 'monitor')
       ORDER BY created_at DESC LIMIT 40`
    )
    .all(now - 48 * 3_600_000) as Record<string, unknown>[]).map((e) => ({
    t: e.created_at,
    type: e.type,
    msg: e.message,
  }));

  // Activité réelle du bot (pour le bandeau de statut "up / périmé / down")
  const lastScanAt = db.prepare("SELECT MAX(scanned_at) m FROM pool_scans").get() as {
    m: number | null;
  };
  const lastMarkAt = db.prepare("SELECT MAX(taken_at) m FROM pnl_snapshots").get() as {
    m: number | null;
  };
  const lastMonitorAt = db
    .prepare("SELECT MAX(created_at) m FROM events WHERE type = 'monitor'")
    .get() as { m: number | null };

  // Radar early (GMGN : « voir tôt ≠ entrer tôt ») : pools jeunes en activité
  // mais exclus des filtres d'entrée — section dashboard, jamais ouverts en auto.
  const earlyWatch = lastScan
    .filter((r) => (r.signals as string).includes("radar early"))
    .slice(0, 20)
    .map((r) => ({
      pool_address: r.pool_address,
      name: displayName(r.name, r.token_x_symbol, r.token_y_symbol),
      tvl: r.tvl,
      volume_30m: r.volume_30m,
      volume_24h: r.volume_24h,
      fee_tvl_ratio_30m: r.fee_tvl_ratio_30m,
      fee_tvl_ratio_24h: r.fee_tvl_ratio_24h,
      pool_age_days: r.pool_age_days,
      bin_step: r.bin_step,
      current_price: r.current_price,
      signals: safeJson(r.signals as string),
    }));

  // Pilote RÉEL (positions ouvertes + dernier mark chacune) — le dashboard
  // principal ne montrait que le paper ; le réel vivait sur pool.html (page
  // dédiée, supprimée le 2026-08-24) + Telegram + rapport.
  // Ajouté 2026-08-23 (demande David).
  const realRows = (db
    .prepare(
      `SELECT rp.id, rp.name, rp.token_x_symbol, rp.token_y_symbol, rp.strategy, rp.pool_address, rp.deposit_usd, rp.amount_y, rp.invested_sol,
              rp.min_bin_id, rp.max_bin_id, rp.position_pubkey, rp.opened_at, rp.pilot,
              rm.value_usd, rm.net_pnl_usd, rm.in_range, rm.taken_at
       FROM real_positions rp
       LEFT JOIN real_marks rm ON rm.id = (
         SELECT id FROM real_marks WHERE position_id = rp.id ORDER BY id DESC LIMIT 1)
       WHERE rp.status = 'open'
       ORDER BY rp.id`
    )
    .all() as Record<string, unknown>[]);
  // PnL + fees DEPUIS LE DÉBUT (demande David 27/08) : toutes les positions
  // (ouvertes + fermées), réalisé + latent. net du dernier mark (inclut les
  // fees) ; fallback last_value − deposit pour les positions sans mark (ex.
  // kill-switch test STONK). Fees = en attente (dernier mark) + claims AUTO
  // (montant parsé du message, format stable « claim AUTO 30.67$ de fees »).
  const allTimeRows = db
    .prepare(
      `SELECT rp.id, rp.status, rp.deposit_usd, rp.last_value_usd, rp.closed_at, rp.close_reason,
              rm.net_pnl_usd, rm.fees_usd
       FROM real_positions rp
       LEFT JOIN real_marks rm ON rm.id = (
         SELECT id FROM real_marks WHERE position_id = rp.id ORDER BY id DESC LIMIT 1)`
    )
    .all() as Record<string, unknown>[];
  let pnlAll = 0;
  let pnlRealized = 0;
  let feesPending = 0;
  for (const r of allTimeRows) {
    const net =
      r.net_pnl_usd != null
        ? Number(r.net_pnl_usd) - Number(r.fees_usd ?? 0) // valeur PURE — net_pnl inclut les fees en attente, les ajouter à feesAllTimeUsd double-compterait (vérifié 27/08)
        : (Number(r.last_value_usd ?? 0) - Number(r.deposit_usd ?? 0));
    pnlAll += net;
    if (r.status === "closed") pnlRealized += net;
    feesPending += Number(r.fees_usd ?? 0);
  }
  let feesClaimed = 0;
  for (const c of db.prepare(`SELECT message FROM events WHERE type='real-claim'`).all() as {
    message: string;
  }[]) {
    const m = (c.message ?? "").match(/([0-9]+\.[0-9]+)\$/);
    if (m) feesClaimed += parseFloat(m[1]);
  }
  const allTime = {
    pnlAllTimeUsd: pnlAll,
    pnlRealizedUsd: pnlRealized,
    feesAllTimeUsd: feesPending + feesClaimed,
    // Profit global (demande David 27/08) : valeur pure + fees — identité
    // exacte depuis le fix d3dcda5 (net_pnl hors pending).
    profitAllTimeUsd: pnlAll + feesPending + feesClaimed,
  };

  // Progression PnL/fees par période (demande David 27/08 : 1D, 1W, 1M, 1Y,
  // YTD, ALL). Équité cumulée à t = Σ du dernier mark ≤ t par position
  // (fallback last_value−deposit au closed_at pour les positions sans mark,
  // ex. STONK) ; fees cumulées à t = Σ fees du dernier mark ≤ t + claims ≤ t.
  // Période = cumul(now) − cumul(t).
  // ⚠️ PnL = net_pnl_usd − fees_usd du mark (valeur PURE, hors fees en
  // attente) : net_pnl inclut déjà les fees claimables (real-monitor
  // netPnlSol = valueSol + feesSol − refSol) — les additionner à la colonne
  // fees double-compterait la variation du pending (vérifié 27/08 sur la DB :
  // 1D affichait −144$ au lieu de −301$, ALL −41$ au lieu de −494$).
  const marksAll = db
    .prepare(
      `SELECT position_id, taken_at, net_pnl_usd, fees_usd FROM real_marks ORDER BY position_id, taken_at`
    )
    .all() as { position_id: number; taken_at: number; net_pnl_usd: number; fees_usd: number }[];
  const marksByPos = new Map<number, { taken_at: number; net_pnl_usd: number; fees_usd: number }[]>();
  for (const m of marksAll) {
    let arr = marksByPos.get(m.position_id);
    if (!arr) {
      arr = [];
      marksByPos.set(m.position_id, arr);
    }
    arr.push(m);
  }
  const claimsAll = db
    .prepare(`SELECT position_id, created_at, message FROM events WHERE type='real-claim'`)
    .all() as { position_id: number; created_at: number; message: string }[];
  const claimAmt = (msg: string) => {
    const m = (msg ?? "").match(/([0-9]+\.[0-9]+)\$/);
    return m ? parseFloat(m[1]) : 0;
  };
  const equityAt = (t: number) => {
    let eq = 0;
    for (const p of allTimeRows) {
      const serie = marksByPos.get(Number(p.id)) ?? [];
      let net = 0;
      for (let i = serie.length - 1; i >= 0; i--) {
        if (serie[i].taken_at <= t) {
          net = serie[i].net_pnl_usd - serie[i].fees_usd; // valeur PURE (voir commentaire ci-dessus)
          break;
        }
      }
      if (serie.length === 0 && t >= (Number(p.closed_at) || now)) {
        net = Number(p.last_value_usd ?? 0) - Number(p.deposit_usd ?? 0);
      }
      eq += net;
    }
    return eq;
  };
  const feesAt = (t: number) => {
    let f = 0;
    for (const p of allTimeRows) {
      const serie = marksByPos.get(Number(p.id)) ?? [];
      for (let i = serie.length - 1; i >= 0; i--) {
        if (serie[i].taken_at <= t) {
          f += serie[i].fees_usd;
          break;
        }
      }
    }
    for (const c of claimsAll) if (c.created_at <= t) f += claimAmt(c.message);
    return f;
  };
  const eqNowV = equityAt(now);
  const feesNowV = feesAt(now);
  // Décomposition par période (demande David 06/09) : du delta période, isoler
  // la part des positions FERMÉES dans la fenêtre. Le tableau des pools ne
  // montre que les ouvertes ; sans cette ligne le 1D semble « incohérent »
  // quand une value-stop (-55 $ fone 05/09) tombe dans la fenêtre.
  // contribution close = pure(final) − pure(dernier mark ≤ t) ; fees = même
  // logique + claims ≤ now hors window. Positions ouvertes → contribution nulle.
  const closedContrib = (t: number) => {
    let pnl = 0;
    let fees = 0;
    let n = 0;
    for (const p of allTimeRows) {
      if (p.status !== "closed") continue;
      const closedAt = Number(p.closed_at) || 0;
      if (closedAt < t || closedAt > now) continue; // fermée DANS la fenêtre
      n++;
      const serie = marksByPos.get(Number(p.id)) ?? [];
      // dernier mark STRICTEMENT avant la fenêtre (≈ état compté dans cumul(t))
      let prevPure = 0;
      let prevFees = 0;
      for (let i = serie.length - 1; i >= 0; i--) {
        if (serie[i].taken_at <= t) {
          prevPure = serie[i].net_pnl_usd - serie[i].fees_usd;
          prevFees = serie[i].fees_usd;
          break;
        }
      }
      const last = serie[serie.length - 1];
      const finPure =
        last != null
          ? last.net_pnl_usd - last.fees_usd
          : Number(p.last_value_usd ?? 0) - Number(p.deposit_usd ?? 0);
      const finFees = last != null ? last.fees_usd : 0;
      pnl += finPure - prevPure;
      fees += finFees - prevFees;
    }
    return { pnl, fees, n };
  };
  const DAY_MS = 86_400_000;
  type Prog = {
    pnl: number;
    fees: number;
    profit: number;
    closedN?: number;
    closedPnl?: number;
    closedFees?: number;
  };
  const progression: Record<string, Prog> = {};
  for (const [k, back] of [
    ["1D", 1],
    ["1W", 7],
    ["1M", 30],
    ["1Y", 365],
  ] as [string, number][]) {
    const t = now - back * DAY_MS;
    const pnl = eqNowV - equityAt(t);
    const fees = feesNowV - feesAt(t);
    const cc = closedContrib(t);
    progression[k] = {
      pnl,
      fees,
      profit: pnl + fees,
      closedN: cc.n,
      closedPnl: cc.pnl,
      closedFees: cc.fees,
    };
  }
  const ytdStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  const ytdPnl = eqNowV - equityAt(ytdStart);
  const ytdFees = feesNowV - feesAt(ytdStart);
  progression.YTD = { pnl: ytdPnl, fees: ytdFees, profit: ytdPnl + ytdFees };
  progression.ALL = { pnl: eqNowV, fees: feesNowV, profit: eqNowV + feesNowV };

  // --- Wallet & garde de solde (live RPC, dégradation silencieuse si down) ---
  // En LAB : JAMAIS de lecture wallet — le lab affiche ses PAPER positions ;
  // lire le solde du pilote réel exposerait l'adresse réelle sur le port 4002
  // et pollue Helius d'un getBalance par refresh (fix 03/10).
  let walletFreeSol: number | null = null;
  // LAB : le capital TOTAL est déclaré (constante = libre + déployé de la prod
  // au relevé) ; le libre en découle après le calcul du déployé, plus bas.
  const labCapital = labMode && config.labPaperCapitalSol > 0 ? config.labPaperCapitalSol : null;
  if (!labCapital)
    try {
    const solana = require("@solana/web3.js") as {
      Connection: new (url: string, c: string) => {
        getBalance: (k: unknown) => Promise<number>;
      };
      PublicKey: new (s: string) => unknown;
    };
    const conn = new solana.Connection(config.rpcUrl, "confirmed");
    walletFreeSol = await Promise.race([
      conn.getBalance(new solana.PublicKey(config.walletAddress)),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("getBalance timeout")), 8000)),
    ]).then((b) => b / 1e9);
  } catch {
    walletFreeSol = null; // RPC indisponible → le dashboard affiche sans solde libre
  }
  // SOL-équivalent déployé : amount_y est la devise Y du pool (SOL sur X-SOL,
  // USDC sur X-USDC — incident wNEAR 29/09). Pour le pilote, invested_sol est
  // LA référence (sortie réelle du wallet) ; sinon conversion ÷prixSOL si stable.
  const solEquiY = (p: Record<string, any>): number => {
    if (p.pilot && Number(p.invested_sol) > 0) return Number(p.invested_sol);
    const y = Number(p.amount_y ?? 0);
    const sym = String(p.token_y_symbol ?? "").toUpperCase();
    if ((sym === "USDC" || sym === "USDT") && solPriceUsd && solPriceUsd > 0) return y / solPriceUsd;
    return y;
  };
  const deployedMeme = realRows.reduce((a, p) => a + (p.pilot ? 0 : solEquiY(p)), 0);
  const deployedTrend = realRows.reduce((a, p) => a + (p.pilot ? solEquiY(p) : 0), 0);
  const deployedSol = deployedMeme + deployedTrend;
  // LAB (option B 06/10) : capital TOTAL constant → le libre suit le déployé.
  // Sans ça le total du lab grossit avec son book papier et ne peut JAMAIS
  // coïncider avec la prod (constaté : 88,82 SOL au lieu de 51,74).
  const totalSol = labCapital !== null
    ? labCapital
    : (walletFreeSol !== null ? walletFreeSol + deployedSol : null);
  if (labCapital !== null && totalSol !== null) walletFreeSol = Math.max(0, totalSol - deployedSol);
  // Manches book hybride (01/09) : guardPct = manche MEMES (open-paper),
  // bornée à 0.8×(1−share)×total — ≥ 1 = manche memes figée (la machine ne
  // peut plus ouvrir tant que des closes ne libèrent pas de la place).
  const capitalBook = totalSol !== null ? totalSol * (1 - config.trendSleeveShare) : null;
  const guardPct = capitalBook !== null && capitalBook > 0 ? deployedMeme / (0.8 * capitalBook) : null;

  // --- Value-stop 24h (doctrine « gagner petit et souvent », filet −15 %) ---
  const vsSince = now - 24 * 3600 * 1000;
  const vsRows = db
    .prepare(
      `SELECT name, pool_address, deposit_usd, last_value_usd, entry_price, closed_at
       FROM real_positions
       WHERE status='closed' AND close_reason='value-stop' AND closed_at >= ?
       ORDER BY closed_at`
    )
    .all(vsSince) as {
    name: string;
    pool_address: string;
    deposit_usd: number;
    last_value_usd: number | null;
    entry_price: number;
    closed_at: number;
  }[];
  const vsAvgLossPct = vsRows.length
    ? vsRows.reduce((s, p) => s + ((p.last_value_usd ?? 0) - p.deposit_usd) / p.deposit_usd, 0) / vsRows.length
    : 0;
  const valueStop = {
    count: vsRows.length,
    closes: vsRows.map((p) => {
      const pnl = (p.last_value_usd ?? 0) - p.deposit_usd;
      let rebound = false;
      if (p.entry_price > 0) {
        const mx = db
          .prepare("SELECT MAX(current_price) m FROM pool_scans WHERE pool_address=? AND scanned_at>?")
          .get(p.pool_address, p.closed_at) as { m: number | null } | undefined;
        rebound = !!(mx && mx.m != null && mx.m > p.entry_price);
      }
      return { name: p.name, pnl, pct: p.deposit_usd ? pnl / p.deposit_usd : 0, closedAt: p.closed_at, rebound };
    }),
    avgLossPct: vsAvgLossPct,
    // Verdict du filet (même critère que valuestop-report.cjs) : perte
    // moyenne ≤ 30 % du dépôt = le filet borne. Échantillon < 3 → pas de verdict.
    verdict: vsRows.length >= 3 ? (vsAvgLossPct <= -0.3 ? "lache" : "borne") : "pas-de-verdict",
  };

  // --- Pilote L4-B (2026-08-29) : positions balancées (spot/curve) sur tokens
  // établis en tendance, isolées du book via pilot=1. Pur + fees SÉPARÉS du
  // book (contrainte David 29/08 : les specs L4 ne doivent pas être au
  // détriment de la collecte — on mesure les deux côtés indépendamment).
  const pilotRows = db
    .prepare(
      `SELECT rp.id, rp.name, rp.strategy, rp.deposit_usd, rp.amount_y, rp.invested_sol, rp.status,
              rp.token_x_symbol, rp.token_y_symbol, rm.net_pnl_usd, rm.fees_usd
       FROM real_positions rp
       LEFT JOIN real_marks rm ON rm.id = (
         SELECT id FROM real_marks WHERE position_id = rp.id ORDER BY id DESC LIMIT 1)
       WHERE rp.pilot = 1
       ORDER BY rp.id`
    )
    .all() as Record<string, unknown>[];
  const pilot = {
    count: pilotRows.length,
    open: pilotRows.filter((r) => r.status === "open").length,
    // SOL réellement en position aujourd'hui : status='open' uniquement, et
    // invested_sol quand il existe (sortie wallet réelle ; amount_y peut être du
    // USDC sur un pool stable — incident wNEAR 29/09).
    deployedSol: pilotRows
      .filter((r) => r.status === "open")
      .reduce(
        (a, r) =>
          a +
          (Number(r.invested_sol ?? 0) > 0
            ? Number(r.invested_sol)
            : String(r.token_y_symbol ?? "").toUpperCase().match(/USDC|USDT/) && solPriceUsd
              ? Number(r.amount_y ?? 0) / solPriceUsd
              : Number(r.amount_y ?? 0)),
        0
      ),
    purUsd: pilotRows.reduce((a, r) => a + (Number(r.net_pnl_usd ?? 0) - Number(r.fees_usd ?? 0)), 0),
    feesUsd: pilotRows.reduce((a, r) => a + Number(r.fees_usd ?? 0), 0),
    positions: pilotRows.map((r) => ({
      id: r.id,
      name: displayName(String(r.name), String(r.token_x_symbol ?? ""), String(r.token_y_symbol ?? "")),
      strategy: r.strategy,
      status: r.status,
      deposit_usd: r.deposit_usd,
      amount_y_sol: r.amount_y,
      net_pnl_usd: r.net_pnl_usd ?? null,
      fees_usd: r.fees_usd ?? null,
    })),
  };

  // Début de l'historique réel (1er mark ou 1re position) — permet au
  // dashboard de masquer les périodes 1M/1Y/YTD sans couverture réelle.
  const histRow = db
    .prepare(
      `SELECT MIN(t) t FROM (
         SELECT MIN(opened_at) t FROM real_positions
         UNION ALL SELECT MIN(taken_at) FROM real_marks)`
    )
    .get() as { t: number | null };

  const real = {
    positions: realRows.map((p) => {
      // Flux temps réel (ws-pool-monitor, 2026-08-25) : activité 60 min
      // + dernier bin connu + fraîcheur — phase 1 INFO, aucun exit branché.
      const rt = db
        .prepare(
          `SELECT COUNT(*) n, MAX(active_bin_id) bin, MAX(ts) last FROM pool_events_rt WHERE pool_address = ? AND ts > ?`
        )
        .get(p.pool_address, now - 3_600_000) as { n: number; bin: number | null; last: number | null };
      return {
        id: p.id,
        // displayName (fix 2026-08-25) : la position CYBERLEEK s'affichait
        // « -SOL » — fallback token_x-token_y quand l'API renvoie un nom vide.
        name: displayName(p.name, p.token_x_symbol, p.token_y_symbol),
        strategy: p.strategy,
        pool_address: p.pool_address,
        deposit_usd: p.deposit_usd,
        amount_y_sol: p.amount_y,
        min_bin_id: p.min_bin_id,
        max_bin_id: p.max_bin_id,
        position_pubkey: p.position_pubkey,
        opened_at: p.opened_at,
        value_usd: p.value_usd ?? null,
        net_pnl_usd: p.net_pnl_usd ?? null,
        in_range: p.in_range ?? null,
        mark_taken_at: p.taken_at ?? null,
        rt_events_60m: rt.n ?? 0,
        rt_bin: rt.bin ?? null,
        rt_last_event_ms: rt.last ?? null,
      };
    }),
    summary: {
      open: realRows.length,
      thesarFloorSol: config.walletThesarFloorSol,
      investedUsd: realRows.reduce((a, p) => a + Number(p.deposit_usd ?? 0), 0),
      valueUsd: realRows.reduce((a, p) => a + Number(p.value_usd ?? 0), 0),
      netPnlUsd: realRows.reduce((a, p) => a + Number(p.net_pnl_usd ?? 0), 0),
      deployedSol,
      walletFreeSol,
      totalSol,
      guardPct,
      // Manches book hybride (01/09) : état de la manche tendance (L4-B).
      trendSleeve: {
        share: config.trendSleeveShare,
        budgetSol: totalSol !== null ? totalSol * config.trendSleeveShare : null,
        deployedSol: deployedTrend,
        guardPct:
          totalSol !== null && totalSol > 0
            ? deployedTrend / (0.8 * totalSol * config.trendSleeveShare)
            : null,
      },
      valueStop,
      pilot,
      realHistoryStartMs: histRow.t ?? null,
      ...allTime,
      progression,
    },
  };

  const payload = {
    generated_at: now,
    lab: labMode, // le front (index.html) adapte son badge : « Réel · machine »
    // serait un mensonge sur le port du lab paper (fix 03/10).
    summary: getPortfolioSummary(),
    real,
    sol_price_usd: solPriceUsd,
    last_activity: {
      last_scan_at: lastScanAt.m ?? null,
      last_mark_at: lastMarkAt.m ?? null,
      last_monitor_at: lastMonitorAt.m ?? null,
      dashboard_started_at: now - Math.round(process.uptime() * 1000),
      monitor_interval_min: config.monitorIntervalMin,
    },
    learning: buildLearningExport(),
    opportunities,
    early_watch: earlyWatch,
    positions,
    closed_positions: closedPositions,
    snapshots,
    events,
  };

  const out = path.join(dir, "dashboard.json");
  fs.writeFileSync(out, JSON.stringify(payload));
  return out;
}

function safeJson(s: string): unknown {
  try {
    return s ? JSON.parse(s) : null;
  } catch {
    return null;
  }
}

/** Données "apprentissage" : règles courantes, historique, buckets d'évidence. */
function buildLearningExport() {
  const rules = getRules();

  const reviews = db
    .prepare(
      `SELECT fee_tvl_ratio_24h, vol_24h, strategy, net_pnl_pct, fees_usd, in_range_pct, review_type, reviewed_at
       FROM outcome_reviews ORDER BY reviewed_at DESC LIMIT 500`
    )
    .all() as {
    fee_tvl_ratio_24h: number | null;
    vol_24h: number | null;
    strategy: string;
    net_pnl_pct: number;
    fees_usd: number;
    in_range_pct: number | null;
    review_type: string;
    reviewed_at: number;
  }[];

  const feeBands = bucketStats(
    (r) => {
      if (r.fee_tvl_ratio_24h === null) return "inconnu";
      if (r.fee_tvl_ratio_24h < 0.05) return "bas (<5%)";
      if (r.fee_tvl_ratio_24h < 0.2) return "moyen (5-20%)";
      return "élevé (>20%)";
    },
    reviews
  );
  const volBands = bucketStats(
    (r) => {
      if (r.vol_24h === null) return "inconnu";
      // Fix 25/10 : seuils ÷√24 exacts, labels en σ daily réel.
      if (r.vol_24h < 0.1 / Math.sqrt(24)) return "bas (<2%)";
      if (r.vol_24h < 0.3 / Math.sqrt(24)) return "moyen (2-6%)";
      return "élevé (>6%)";
    },
    reviews
  );

  return {
    rules: {
      version: rules.version,
      createdAt: rules.createdAt,
      reason: rules.reason ?? null,
      wApr: rules.wApr,
      wVolStability: rules.wVolStability,
      wTvl: rules.wTvl,
      farmBonus: rules.farmBonus,
      volPenalty: rules.volPenalty,
      minFeeTvlRatio24h: rules.minFeeTvlRatio24h,
      rebalanceThreshold: rules.rebalanceThreshold,
      strategyByVol: rules.strategyByVol,
    },
    rule_changes: getRuleChanges(25),
    reviews: {
      total: reviews.length,
      fee_bands: feeBands,
      vol_bands: volBands,
    },
  };
}
