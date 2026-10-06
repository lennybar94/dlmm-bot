// Moteur PAPER : positions simulées, frais simulés, IL concentré, triggers.
// Aucune transaction réelle n'est possible ici — PAPER ONLY par construction.

import { db, logEvent, blacklistToken, isBlacklistableToken } from "./db.js";
import { config, labMode } from "./config.js";
import { fetchPool } from "./api.js";
import { STRATEGY_PRESETS, binIdFromPrice, depositForPool } from "./strategies.js";
import { coolingOffState, inFeeSurge } from "./volume.js";
import { getRules } from "./rules.js";
import { reviewPositionOnClose } from "./review.js";
import type { MarkResult, OpportunityScore, PaperPositionRow, StrategyName } from "./types.js";

// cache prix SOL pour le miroir lab (markPosition) — évite l'import circulaire export↔paper
const mirrorSolPriceCache = { price: 0, at: 0 };

/** Prix d'un bin : base^binId avec base = 1 + bin_step/10000. */
export function binPrice(binId: number, binStep: number): number {
  return Math.pow(1 + binStep / 10_000, binId);
}

/**
 * Estimation du prix du token quote (Y) en USD via le TVL du pool :
 * tvl ≈ (x_amount × price + y_amount) × yUsd → yUsd = tvl / (x×p + y).
 * Fallback 1.0 (pools USDC) — à défaut d'oracle, c'est une approximation honnête.
 */
export function estimateYUsd(pool: {
  tvl: number;
  token_x_amount: number;
  token_y_amount: number;
  current_price: number;
}): number {
  const denom = pool.token_x_amount * pool.current_price + pool.token_y_amount;
  if (!denom || denom <= 0) return 1;
  const yUsd = pool.tvl / denom;
  return yUsd > 0.01 && yUsd < 100_000 ? yUsd : 1;
}

interface LiquidityState {
  L: number;
  pa: number;
  pb: number;
  x0: number; // dépôt X (unités token) — sur la courbe
  y0: number; // dépôt Y (unités token) — sur la courbe
}

/**
 * Construit l'état de liquidité (approximation Uniswap v3 d'un range discret DLMM).
 * Le dépôt (x0, y0) est projeté SUR la courbe : L est dérivé du dépôt total,
 * puis x0/y0 en découlent — cohérent (V(P0) = dépôt, IL(P0) = 0).
 */
export function buildLiquidity(opts: {
  depositY: number; // dépôt total en unités Y
  price: number;
  minBinId: number;
  maxBinId: number;
  binStep: number;
  oneSided?: "none" | "x" | "y";
}): LiquidityState {
  const { depositY, price: p0, binStep } = opts;
  const pa = binPrice(opts.minBinId, binStep);
  const pb = binPrice(opts.maxBinId, binStep);
  if (!(pa < pb) || p0 <= 0) throw new Error("range invalide");

  const sp0 = Math.sqrt(p0);
  const spa = Math.sqrt(pa);
  const spb = Math.sqrt(pb);

  let L: number;
  let x0: number;
  let y0: number;
  if (opts.oneSided === "x") {
    // tout en X (position au-dessus du range) : x = L(1/√Pa − 1/√Pb)
    x0 = depositY / p0;
    y0 = 0;
    L = x0 > 0 ? (x0 * spa * spb) / (spb - spa) : 0;
  } else if (opts.oneSided === "y") {
    // tout en Y (position en dessous du range) : y = L(√Pb − √Pa)
    x0 = 0;
    y0 = depositY;
    L = depositY / (spb - spa);
  } else {
    // balancé : L = dépôt / facteur de valeur au prix courant
    const factor = 2 * sp0 - p0 / spb - spa;
    if (factor <= 0) throw new Error("prix hors range");
    L = depositY / factor;
    // Projection sur la courbe
    x0 = L * (1 / sp0 - 1 / spb);
    y0 = L * (sp0 - spa);
  }
  return { L, pa, pb, x0, y0 };
}

/** Valeur (en unités Y) de la position à un prix P. */
export function valueInY(state: LiquidityState, price: number): number {
  const { L, pa, pb } = state;
  if (L <= 0) return 0;
  const sp = Math.sqrt(price);
  const spa = Math.sqrt(pa);
  const spb = Math.sqrt(pb);
  if (price < pa) return L * price * (1 / spa - 1 / spb);
  if (price > pb) return L * (spb - spa);
  return L * (2 * sp - price / spb - spa);
}

/** Valeur "hold" (sans provision de liquidité) : x0×P + y0, en unités Y. */
export function holdValue(state: LiquidityState, price: number): number {
  return state.x0 * price + state.y0;
}

/** IL en unités Y (négatif = perte vs hold). */
export function impermanentLoss(state: LiquidityState, price: number): number {
  return valueInY(state, price) - holdValue(state, price);
}

export interface OpenResult {
  positionId: number;
  amountX: number;
  amountY: number;
  minBinId: number;
  maxBinId: number;
  entryPrice: number;
}

/** Ouvre une position paper sur une opportunité scorée. */
export function openPaperPosition(opp: OpportunityScore, depositUsd?: number): OpenResult {
  const p = opp.pool;
  const hint = opp.strategyHint;
  const preset = STRATEGY_PRESETS[hint.strategy] ?? STRATEGY_PRESETS["spot-spread"];
  const yUsd = estimateYUsd(p);
  const entryPrice = p.current_price;
  // Sizing par classe (playbook satsmonkes — « la taille est inverse à la
  // volatilité et inverse au gap de conviction ») : exploratoire petit (pool
  // jeune/pump.fun = tuition), conviction moyen (établi), majors gros (gros
  // TVL + gros volume). Dépôt explicite ou fixe si SATS_SIZING_ENABLED=false.
  const depositUsdFinal = depositUsd ?? depositForPool(p);
  const depositY = depositUsdFinal / yUsd;

  const activeBinId = binIdFromPrice(entryPrice, p.bin_step);
  // Le hint vient du SCAN (prix du scan) ; open-paper re-fetch le détail API juste
  // avant d'ouvrir. Si le prix a bougé entre les deux, un range ancré sur l'ancien
  // prix place la position HORS range dès l'ouverture (artefact de PnL vu au lab
  // 04/10 : #3/#4/#7/#16/#18/#27/#28/#36/#39/#40 nées avec entry > bin max).
  // Règle : recalage sur le prix live quand l'entry tombe hors [min..max], et
  // recentrage des spot quand le centre du hint est décalé de >50 % du demi-span.
  let minBinId = hint.minBinId ?? activeBinId - 10;
  let maxBinId = hint.maxBinId ?? activeBinId + 10;
  if (activeBinId > maxBinId || activeBinId < minBinId) {
    const shift = activeBinId - Math.round((minBinId + maxBinId) / 2);
    minBinId += shift;
    maxBinId += shift;
    logEvent(
      "open",
      `⚠️ ${p.name} : bins du hint [${hint.minBinId}..${hint.maxBinId}] hors du prix live (bin ${activeBinId}) — range recalé [${minBinId}..${maxBinId}]`,
      { poolAddress: p.address }
    );
  } else if (preset.oneSided === "none") {
    const center = Math.round((minBinId + maxBinId) / 2);
    const halfSpan = Math.max(1, Math.round((maxBinId - minBinId) / 2));
    if (Math.abs(activeBinId - center) > halfSpan * 0.5) {
      const shift = activeBinId - center;
      minBinId += shift;
      maxBinId += shift;
      logEvent(
        "open",
        `⚠️ ${p.name} : centre du hint décalé (${center} vs bin ${activeBinId}) — range recentré [${minBinId}..${maxBinId}]`,
        { poolAddress: p.address }
      );
    }
  }
  const liq = buildLiquidity({
    depositY,
    price: entryPrice,
    minBinId,
    maxBinId,
    binStep: p.bin_step,
    oneSided: preset.oneSided,
  });
  const amountX = liq.x0;
  const amountY = liq.y0;

  // Garde anti-récidive (artefact seed du lab 03/10, vu 04/10) : la valeur sur la
  // courbe au prix d'entrée doit égaler le dépôt (±5 %). Sinon la position démarre
  // mécaniquement « en gain » et fausse tout le PnL. Rejet avec log — jamais une
  // insertion incohérente.
  const valueAtEntryY = valueInY(liq, entryPrice);
  if (!(valueAtEntryY > 0) || Math.abs(valueAtEntryY - depositY) / depositY >= 0.05) {
    logEvent(
      "open",
      `⛔ REJET ouverture ${p.name} (${hint.strategy}) : valueY@entry ${valueAtEntryY.toFixed(4)} vs dépôt ${depositY.toFixed(4)} (écart ${((valueAtEntryY / depositY - 1) * 100).toFixed(1)}% ≥ 5%) — courbe incohérente avec les bins`,
      { poolAddress: p.address }
    );
    return { positionId: 0, amountX: 0, amountY: 0, minBinId, maxBinId, entryPrice };
  }

  const info = db
    .prepare(
      `INSERT INTO paper_positions
       (opened_at, pool_address, name, strategy, deposit_usd, min_bin_id, max_bin_id, bin_step,
        entry_price, entry_active_bin, token_x_symbol, token_y_symbol, amount_x, amount_y,
        fees_earned_usd, fees_claimed_usd, status, last_mark_price, last_value_usd, last_il_usd,
        rebalance_count, day_start_price, last_mark_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 'open', ?, ?, ?, 0, ?, ?)`
    )
    .run(
      Date.now(),
      p.address,
      p.name,
      hint.strategy,
      depositUsdFinal,
      minBinId,
      maxBinId,
      p.bin_step,
      entryPrice,
      activeBinId,
      p.token_x.symbol,
      p.token_y.symbol,
      amountX,
      amountY,
      entryPrice,
      depositUsdFinal,
      0,
      entryPrice,
      Date.now()
    );

  const positionId = Number(info.lastInsertRowid);
  logEvent(
    "open",
    `Position paper ouverte : ${p.name} — ${hint.strategy}, ${depositUsdFinal}$ (${amountX.toFixed(4)} ${p.token_x.symbol} / ${amountY.toFixed(2)} ${p.token_y.symbol}), bins [${minBinId}..${maxBinId}]`,
    { positionId, poolAddress: p.address }
  );
  return { positionId, amountX, amountY, minBinId, maxBinId, entryPrice };
}

export function getOpenPositions(): PaperPositionRow[] {
  return db
    .prepare("SELECT * FROM paper_positions WHERE status = 'open' ORDER BY opened_at ASC")
    .all() as PaperPositionRow[];
}

export function getPosition(id: number): PaperPositionRow | undefined {
  return db.prepare("SELECT * FROM paper_positions WHERE id = ?").get(id) as
    | PaperPositionRow
    | undefined;
}

export interface PositionValue {
  valueY: number;
  holdY: number;
  ilY: number;
  inRange: boolean;
  drift: number; // 0..1 (1 = sorti du range)
}

/** Évalue une position à un prix donné. */
export function evaluatePosition(pos: PaperPositionRow, price: number): PositionValue {
  // Les montants stockés (x0, y0) sont sur la courbe → on en dérive L.
  const p0 = pos.entry_price;
  const pa = binPrice(pos.min_bin_id, pos.bin_step);
  const pb = binPrice(pos.max_bin_id, pos.bin_step);
  const sp0 = Math.sqrt(p0);
  const spa = Math.sqrt(pa);
  const spb = Math.sqrt(pb);
  let L = 0;
  if (pos.amount_y > 0 && pos.amount_x > 0) L = pos.amount_y / (sp0 - spa);
  else if (pos.amount_y > 0) L = pos.amount_y / (spb - spa); // Y-only
  else if (pos.amount_x > 0) L = (pos.amount_x * spa * spb) / (spb - spa); // X-only
  const state: LiquidityState = { L, pa, pb, x0: pos.amount_x, y0: pos.amount_y };
  const valueY = valueInY(state, price);
  const holdY = holdValue(state, price);
  const ilY = valueY - holdY;
  const activeBin = binIdFromPrice(price, pos.bin_step);
  const inRange = activeBin >= pos.min_bin_id && activeBin <= pos.max_bin_id;
  const centerBin = (pos.min_bin_id + pos.max_bin_id) / 2;
  const halfSpan = Math.max(1, (pos.max_bin_id - pos.min_bin_id) / 2);
  const drift = Math.min(1, Math.abs(activeBin - centerBin) / halfSpan);
  return { valueY, holdY, ilY, inRange, drift };
}

/** Série des prix des derniers marks (bougies ~15 min, monitor) — pour Bollinger. */
function recentMarkPrices(positionId: number, n: number): number[] {
  const rows = db
    .prepare(
      `SELECT price FROM pnl_snapshots WHERE position_id = ? AND taken_at < ? ORDER BY taken_at DESC LIMIT ?`
    )
    .all(positionId, Date.now(), n) as { price: number | null }[];
  return rows
    .map((r) => r.price)
    .filter((p): p is number => typeof p === "number" && p > 0)
    .reverse();
}

/**
 * Série de prix dans une FENÊTRE TEMPORELLE, décimée à targetN points —
 * indépendante de la cadence des marks. Au monitor 15 min historique, une
 * fenêtre de N×15 min contient ~N marks → comportement identique à
 * recentMarkPrices(N). Avec le monitor accéléré (60 s sur les pools chaudes,
 * RocketScan 2026-08-23), la même fenêtre contient ~15× plus de marks → on
 * décime pour préserver la sémantique temporelle du Bollinger (20 points ≈ 5 h)
 * et du flip (6 points ≈ 90 min) au lieu de compresser la fenêtre.
 */
function recentMarkPricesSince(positionId: number, windowMs: number, targetN: number): number[] {
  const since = Date.now() - windowMs;
  const rows = db
    .prepare(
      `SELECT price FROM pnl_snapshots WHERE position_id = ? AND taken_at >= ? ORDER BY taken_at DESC`
    )
    .all(positionId, since) as { price: number | null }[];
  const prices = rows
    .map((r) => r.price)
    .filter((p): p is number => typeof p === "number" && p > 0)
    .reverse();
  if (prices.length <= targetN) return prices;
  const step = prices.length / targetN;
  const out: number[] = [];
  for (let i = 0; i < prices.length && out.length < targetN; i = Math.round(i + step)) {
    out.push(prices[i]);
  }
  return out;
}

/** Mark-to-market : valeur, frais simulés, IL, triggers (stop, rebalance). */
export async function markPosition(pos: PaperPositionRow): Promise<MarkResult> {
  const pool = await fetchPool(pos.pool_address);
  const price = pool.current_price;
  const yUsd = estimateYUsd(pool);
  const ev = evaluatePosition(pos, price);

  const valueUsd = ev.valueY * yUsd;
  const holdUsd = ev.holdY * yUsd;
  const ilUsd = ev.ilY * yUsd;

  // Frais simulés : part du pool encaissée par la position, proportionnelle au temps en range.
  const lastMarkAt = pos.last_mark_at ?? pos.opened_at;
  const hours = Math.max(0.016, (Date.now() - lastMarkAt) / 3_600_000);
  const feeRatio1h = pool.fee_tvl_ratio_1h / 100; // % TVL / heure
  const inRangeFactor = ev.inRange ? 1 : 0;
  const feesUsd = valueUsd * feeRatio1h * hours * inRangeFactor;
  const fees = (pos.fees_earned_usd ?? 0) + feesUsd;

  const netPnlUsd = valueUsd - pos.deposit_usd + fees + (pos.fees_claimed_usd ?? 0);

  const now = Date.now();
  db.prepare(
    `UPDATE paper_positions SET last_mark_price = ?, last_value_usd = ?, last_il_usd = ?, fees_earned_usd = ?, last_mark_at = ?
     WHERE id = ?`
  ).run(price, valueUsd, ilUsd, fees, now, pos.id);
  db.prepare(
    `INSERT INTO pnl_snapshots (taken_at, position_id, price, value_usd, fees_usd, il_usd, net_pnl_usd, in_range)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(now, pos.id, price, valueUsd, fees, ilUsd, netPnlUsd, ev.inRange ? 1 : 0);
  // Miroir LAB → section « Pilote » (go David 06/10) : le dashboard du lab
  // doit être IDENTIQUE à celui de la prod (mêmes KPIs, progression 1D/1W,
  // value-stop, tableau), juste en paper. Le front lit real_positions/real_marks
  // pour cette section ; on y duplique les positions papier au fil des marks
  // (upsert par position_id = id paper). Clé publique fictive préfixée PAPER-.
  if (labMode) {
    // prix SOL pour convertir le dépôt en « invested_sol » miroir (cache local,
    // pas d'import circulaire avec export.ts qui importe paper.js)
    let solPx = mirrorSolPriceCache.price;
    if (Date.now() - mirrorSolPriceCache.at > 60_000) {
      try {
        const r = await fetch("https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112", { signal: AbortSignal.timeout(5_000) });
        const j = (await r.json()) as any;
        const p = Number(j?.results?.["So11111111111111111111111111111111111111112"]?.usdPrice ?? 0);
        if (p > 0) { mirrorSolPriceCache.price = p; mirrorSolPriceCache.at = Date.now(); }
      } catch { /* prix stale OK */ }
      solPx = mirrorSolPriceCache.price;
    }
    const existing = db
        .prepare(`SELECT id FROM real_positions WHERE position_pubkey = ?`)
        .get(`PAPER-${pos.id}`) as { id: number } | undefined;
    let rpId = existing?.id;
    if (!rpId) {
      const info = db
        .prepare(
          `INSERT INTO real_positions
           (opened_at, pool_address, name, strategy, deposit_usd, position_pubkey, sig,
            min_bin_id, max_bin_id, bin_step, entry_price, token_x_symbol, token_y_symbol,
            amount_x, amount_y, status, invested_sol)
           VALUES (?, ?, ?, ?, ?, ?, 'paper', ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
        )
        .run(
          pos.opened_at, pos.pool_address, pos.name, pos.strategy, pos.deposit_usd,
          `PAPER-${pos.id}`, pos.min_bin_id, pos.max_bin_id, pos.bin_step, pos.entry_price,
          pos.token_x_symbol, pos.token_y_symbol, pos.amount_x, pos.amount_y,
          solPx > 0 ? pos.deposit_usd / solPx : pos.amount_y
        );
      rpId = Number(info.lastInsertRowid);
    } else if (pos.status === "closed") {
      db.prepare(`UPDATE real_positions SET status='closed', closed_at=?, close_reason=? WHERE id=?`)
        .run(pos.closed_at ?? Date.now(), pos.close_reason ?? "paper-close", rpId);
    }
    db.prepare(
      `INSERT INTO real_marks (taken_at, position_id, price, value_usd, fees_usd, net_pnl_usd, in_range)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(now, rpId, price, valueUsd, fees, netPnlUsd, ev.inRange ? 1 : 0);
    // last_value_usd du miroir : le bloc « Value-stop 24 h » et le PnL du dashboard
    // lisent real_positions.last_value_usd (en prod, real-monitor l'écrit). Sans
    // cette ligne les closes lab sortaient avec last_value_usd NULL → « perte moy
    // 0.0 % » et des $NaN. Même valeur que le dernier mark (convention prod).
    db.prepare(`UPDATE real_positions SET last_value_usd = ?, last_mark_at = ? WHERE id = ?`)
      .run(valueUsd, now, rpId);
  }

  // --- Triggers ---
  const isDip = pos.strategy === "bidask-dip";
  const isFlip = pos.strategy === "bidask-flip";
  // Exit commun aux deux états d'une échelle anti-dump (accumulation ET
  // distribution) : recovery-exit. (Le Bollinger est réservé au bidask-flip —
  // retrait 2026-08-18, voir le bloc Bollinger plus bas.)
  const isDipLike = isDip || isFlip;
  const isQuick = pos.strategy === "topblast" || pos.strategy === "resurrect";
  // Garde « surtension » (playbook gud, 2026-08-24, revue 2026-08-24) : tenir
  // la position pendant que le dynamic fee imprime — MAIS SEULEMENT si elle
  // est IN RANGE (les fees s'accumulent). Hors range = 0 fee : rien à
  // protéger, et retenir une position OOR reproduirait le piège omo #7/#8
  // (close recovery à breakeven APRÈS le passage en token). Données : les
  // surges durent ≤ 20 min avec volume 10× (CATE, 48h) — la garde est un
  // délai court, pas un hold forcé.
  const surgeHold = isDip && inFeeSurge(pool) && ev.inRange;
  // Hard stop : chute > maxDailyDrop entre le prix de début de journée et maintenant.
  // bidask-dip : l'échelle EST le stop (achat de la chute jusqu'à -75%) → stop
  // élargi à -85% (protection rug seulement), pas de stop quotidien.
  // bidask-flip : stop standard 0.4 — le flip est une position de distribution,
  // un re-dump violent doit la sortir vite (le check flip-failed OOR ci-dessous
  // attrape le cas structurel).
  const dayPrice = pos.day_start_price ?? pos.entry_price;
  const dayDrop = (dayPrice - price) / dayPrice;
  const stopThreshold = isDip ? 0.85 : config.hardStopDailyDrop;
  if (dayDrop > stopThreshold) {
    closePosition(pos.id, "hard-stop", `Chute de ${(dayDrop * 100).toFixed(1)}% depuis le début de journée`);
    return { price, value_usd: valueUsd, fees_usd: fees, il_usd: ilUsd, net_pnl_usd: netPnlUsd, in_range: ev.inRange };
  }
  // Value stop-loss (garde-fou CYBERLEEK/GTA6, miroir réel 2026-08-27 ; révisé
  // NET le 29/08) : le hard-stop prix ne coupe que la mort du token. Close si
  // la PERTE NETTE (valeur + fees − dépôt) dépasse le seuil — les fees
  // protègent un fee-harvester in-range (doctrine fees +++).
  const lossRatio = pos.deposit_usd > 0 ? -netPnlUsd / pos.deposit_usd : 0;
  if (lossRatio > config.valueStopLoss) {
    closePosition(pos.id, "value-stop", `Perte nette ${(lossRatio * 100).toFixed(1)}% (net ${netPnlUsd.toFixed(0)}$)`);
    return { price, value_usd: valueUsd, fees_usd: fees, il_usd: ilUsd, net_pnl_usd: netPnlUsd, in_range: ev.inRange };
  }
  // Flip échoué (playbook satsmonkes, setup 4) : le prix retombe sous le bas de
  // la range de distribution → le re-dump est en cours, la position est tout en
  // token qui se déprécie SANS fees (hors range). On sort avant la casse.
  if (isFlip) {
    const minPrice = binPrice(pos.min_bin_id, pos.bin_step);
    if (price < minPrice) {
      closePosition(
        pos.id,
        "flip-failed",
        `prix ${price.toPrecision(6)} < min de la range de distribution ${minPrice.toPrecision(6)} — re-dump, flip annulé`
      );
      return { price, value_usd: valueUsd, fees_usd: fees, il_usd: ilUsd, net_pnl_usd: netPnlUsd, in_range: ev.inRange };
    }
  }
  // Playbook quick in & out (Tikz1070) : « fast in and fast out ». Si le spike
  // de volume s'essouffle (vol 30m < 50% du seuil d'entrée), on sort — les fees
  // du spike sont déjà encaissées, la suite n'est plus le jeu de Tikz
  // (« small clean fees, no drama »).
  if (isQuick && pool.volume_30m < config.quickMinVolume30m * config.quickVolumeFadeFactor) {
    closePosition(
      pos.id,
      "quick-out-volume-fade",
      `vol 30m ${(pool.volume_30m / 1000).toFixed(0)}k$ < ${((config.quickMinVolume30m * config.quickVolumeFadeFactor) / 1000).toFixed(0)}k$ (spike essoufflé)`
    );
    return { price, value_usd: valueUsd, fees_usd: fees, il_usd: ilUsd, net_pnl_usd: netPnlUsd, in_range: ev.inRange };
  }
  // Exit « cooling off » (RocketScan, 2026-08-23) : le post sort quand le
  // momentum refroidit (colonne running → cooling off). Proxy = déclin du
  // DELTA de volume entre observations (pool_scans 5 min + accel 60 s) : le
  // volume de l'intervalle courant < COOLING_RATIO × pic des
  // COOLING_LOOKBACK_MIN dernières minutes. Complément du quick-out-volume-fade
  // (fenêtre fixe 30m de l'API) : le delta réagit dès l'intervalle qui
  // refroidit. topblast : sans garde (« fast in fast out ») ; bidask-dip :
  // garde anti-verrouillage de perte (leçon Bollinger 2026-08-18 : ne pas
  // vendre au creux) — on ne sort que si la perte < COOLING_MAX_LOSS_BIDASK.
  // bidask-flip : exclu — le Bollinger EST l'exit de la reprise.
  // Garde « surtension de dynamic fee » (playbook gud, 2026-08-24) : sur
  // l'échelle anti-dump, quand le dynamic fee explose (dump violent = la
  // fenêtre où les fees paient l'IL), on NE SORT PAS sur momentum refroidi —
  // le post gud a tenu sa position pendant tout le dump (0 rebalance, +3.82%
  // sur un -50%, 24h fees/TVL 67%). topblast : non concerné (pas d'IL,
  // « fast in fast out »). surgeHold = tenir uniquement si IN RANGE (revue
  // 2026-08-24) : OOR = 0 fee, rien à protéger.
  if (isQuick || !surgeHold) {
    const cool = coolingOffState(pos.pool_address);
    if (cool && cool.ratio < config.coolingRatio) {
      const lossRatio = pos.deposit_usd > 0 ? (pos.deposit_usd - (valueUsd + fees)) / pos.deposit_usd : 0;
      if (!isDip || lossRatio < config.coolingMaxLossBidask) {
        closePosition(
          pos.id,
          "cooling-off",
          `momentum refroidi : intervalle courant ${(cool.current / 1000).toFixed(0)}k$/min = ${(cool.ratio * 100).toFixed(0)}% du pic ${(cool.peak / 1000).toFixed(0)}k$/min sur ${cool.windowMin.toFixed(0)}min (RocketScan)`
        );
        return { price, value_usd: valueUsd, fees_usd: fees, il_usd: ilUsd, net_pnl_usd: netPnlUsd, in_range: ev.inRange };
      }
    }
  }
  // Rebalance : drift trop important → ré-ouvrir centré (friction 0.3%).
  // Seuil dynamique : appris par le tuner (règles versionnées).
  // bidask-dip ET bidask-flip : JAMAIS de rebalance (range volontairement
  // unidirectionnel — le recentrage détruirait l'échelle anti-dump OU la
  // mécanique de distribution du flip : le prix qui monte dans la range de
  // distribution ne doit pas déclencher de recentrage+friction).
  // topblast : range volontairement SERRÉ (10-15 bins) — pas de rebalance non
  // plus ; on PULL la liquidité dès que le prix sort du range (Tikz :
  // « i like pulling my liquidity in that situation, either reduces IL or sets
  // up a BA flip » — salarycat : pull → re-entry plus bas).
  if (isQuick) {
    if (!ev.inRange) {
      closePosition(
        pos.id,
        "quick-out-oor-pull",
        `prix ${price.toPrecision(6)} hors range [${pos.min_bin_id}..${pos.max_bin_id}] — pull (style Tikz)`
      );
      return { price, value_usd: valueUsd, fees_usd: fees, il_usd: ilUsd, net_pnl_usd: netPnlUsd, in_range: ev.inRange };
    }
  } else if (!isDipLike && ev.drift > getRules().rebalanceThreshold) {
    rebalancePosition(pos.id, price, ev.valueY * yUsd);
  }
  // Exit "quand c'est vert" (playbook LP Army / Djedje20x) : on sort dès que le
  // PnL net redevient ≥ 0, fees INCLUSES — "sortir en gain au moindre rebond
  // grâce aux fees accumulés" (value + fees ≥ dépôt, même si value seule est
  // encore sous l'eau). S'applique aux échelles anti-dump qui ont attrapé le
  // rebond. Condition "sous l'eau au mark précédent" (fees incluses) pour ne
  // pas sortir à l'ouverture.
  const prevNetUnderwater = (pos.last_value_usd ?? 0) + (pos.fees_earned_usd ?? 0) + (pos.fees_claimed_usd ?? 0) < pos.deposit_usd - config.recoveryEpsUsd;
  // Garde « surtension » (gud, 2026-08-24) : pas de recovery-exit au breakeven
  // pendant que le dynamic fee imprime (le post était up +20 SOL mid-dump et a
  // tenu). Limitée au bidask-dip : le flip distribue (le Bollinger reste son
  // exit), le topblast sort vite par construction. surgeHold = in RANGE seul
  // (revue 2026-08-24) : une position OOR ne gagne plus de fees.
  if (isDipLike && prevNetUnderwater && valueUsd + fees >= pos.deposit_usd && !surgeHold) {
    closePosition(pos.id, "recovery-exit", `PnL net ≥ 0 au rebond : value ${valueUsd.toFixed(2)}$ + fees ${fees.toFixed(2)}$ ≥ ${pos.deposit_usd}$ (fees incluses)`);
    return { price, value_usd: valueUsd, fees_usd: fees, il_usd: ilUsd, net_pnl_usd: netPnlUsd, in_range: ev.inRange };
  }
  // Exit Bollinger (Tiagogo : cassure de la Bollinger haute en 15 min → sortie).
  // RESTREINT au bidask-flip (retrait 2026-08-18, audit playbooks) : pour
  // l'échelle d'achat (bidask-dip), le Bollinger fermait des positions à perte
  // au pic d'un pump (-137$ sur 15 closes) — recovery-exit les ferme en gain.
  // Pour le flip, « vendre le pic » EST la distribution : le Bollinger devient
  // l'exit naturel de la reprise. Bougies ~15 min reconstruites depuis les
  // marks du bot (monitor 15 min) : on sort quand le prix casse mean + k·σ.
  if (isFlip && config.bollingerExitEnabled) {
    // Fenêtre temporelle décimée (cadence-indépendante — le monitor accéléré
    // 60 s marque les pools chaudes : 20 points ≈ 5 h, pas 20 min).
    const prices = recentMarkPricesSince(pos.id, config.bollingerPeriod * 15 * 60_000, config.bollingerPeriod);
    if (prices.length >= config.bollingerMinSamples) {
      const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
      const variance =
        prices.reduce((a, b) => a + (b - mean) ** 2, 0) / prices.length;
      const std = Math.sqrt(variance);
      const upper = mean + config.bollingerStd * std;
      if (std > 0 && price > upper) {
        closePosition(
          pos.id,
          "bollinger-exit",
          `Prix ${price.toPrecision(6)} > bande haute ${upper.toPrecision(6)} (mean ${mean.toPrecision(6)} + ${config.bollingerStd}σ sur ${prices.length} marks)`
        );
        return { price, value_usd: valueUsd, fees_usd: fees, il_usd: ilUsd, net_pnl_usd: netPnlUsd, in_range: ev.inRange };
      }
    }
  }
  // Signal / exécution « flip » (playbook satsmonkes, setup 4) : la bidask-dip
  // est un moteur d'accumulation ; quand la structure montre les premiers signes
  // de retournement (« price stopping making new lows, volume drying up on the
  // down candles, first attempt at a higher low »), on INVERSE la range
  // au-dessus du prix pour distribuer à la reprise (fees des deux côtés).
  // SATS_FLIP_EXECUTE=true → flipPosition exécute le cycle en paper (mesurable,
  // réversible) ; sinon event « flip-candidate » seul (décision humaine).
  // Le flip exige un bag partiel (≥ SATS_FLIP_MIN_TOKEN_SHARE) : flipper une
  // position encore 100% quote = un achat directionnel, pas un LP.
  if (isDip && config.satsFlipSignalEnabled && ev.inRange) {
    const since = Date.now() - config.satsFlipCooldownHours * 3_600_000;
    const already = db
      .prepare(
        "SELECT COUNT(*) n FROM events WHERE type IN ('flip-candidate', 'flip') AND position_id = ? AND created_at > ?"
      )
      .get(pos.id, since) as { n: number };
    const prices = recentMarkPricesSince(pos.id, config.satsFlipLookback * 15 * 60_000, config.satsFlipLookback);
    if (already.n === 0 && prices.length >= config.satsFlipLookback) {
      // Fenêtre coupée en deux : la moitié récente ne refait pas de nouveau low
      // (min récents > min précédents = higher low) et le prix rebondit au-dessus.
      const half = Math.floor(prices.length / 2);
      const prior = prices.slice(0, half);
      const recent = prices.slice(half);
      const minPrior = Math.min(...prior);
      const minRecent = Math.min(...recent);
      const tokenShare = ev.valueY > 0 ? (pos.amount_x * price) / ev.valueY : 0;
      if (minRecent > minPrior && price > minRecent) {
        if (config.satsFlipExecute && tokenShare >= config.satsFlipMinTokenShare) {
          flipPosition(pos.id, price, ev.valueY);
        } else {
          logEvent(
            "flip-candidate",
            `↕ ${pos.name} : structure en retournement — higher low (min ${minRecent.toPrecision(6)} > ${minPrior.toPrecision(6)} sur ${prices.length} marks), prix ${price.toPrecision(6)} au-dessus du low — candidat flip (satsmonkes)${tokenShare < config.satsFlipMinTokenShare ? `, bag ${(tokenShare * 100).toFixed(0)}% en token < ${(config.satsFlipMinTokenShare * 100).toFixed(0)}% requis` : ""}`,
            { positionId: pos.id, poolAddress: pos.pool_address }
          );
        }
      }
    }
  }
  // Claim : seuil de frais atteint → claim paper.
  if (fees >= config.minClaimUsd) {
    db.prepare(
      "UPDATE paper_positions SET fees_claimed_usd = fees_claimed_usd + ?, fees_earned_usd = 0 WHERE id = ?"
    ).run(fees, pos.id);
    logEvent("claim", `Claim paper de ${fees.toFixed(2)}$ de frais sur ${pos.name}`, {
      positionId: pos.id,
      poolAddress: pos.pool_address,
    });
  }

  return { price, value_usd: valueUsd, fees_usd: fees, il_usd: ilUsd, net_pnl_usd: netPnlUsd, in_range: ev.inRange };
}

/** Ferme une position (paper) + review d'outcome immédiate. */
export function closePosition(id: number, reason: string, detail = ""): void {
  const pos = getPosition(id);
  if (!pos) return;
  db.prepare(
    "UPDATE paper_positions SET status = 'closed', closed_at = ?, close_reason = ? WHERE id = ?"
  ).run(Date.now(), reason, id);
  logEvent("close", `Position fermée (${reason}) : ${pos.name}${detail ? " — " + detail : ""}`, {
    positionId: id,
    poolAddress: pos.pool_address,
  });
  reviewPositionOnClose({ ...pos, status: "closed", close_reason: reason, closed_at: Date.now() });

  // Miroir LAB/DASHBOARD (fix 06/10) : markPosition duplique les positions papier
  // dans real_positions/real_marks pour que la section « Pilote » du dashboard lab
  // soit identique à la prod. Mais la fermeture ne se propageait QUE si la position
  // était re-marquée ensuite — or markAll ne marque que les OUVERTES : les closes
  // restaient « open » dans le miroir → value-stop 24h à 0, PnL cumulé faussé
  // (les closes continuaient d'être valorisées au marché). Fermeture ici, au moment
  // du close, comme le fait real-monitor en prod.
  // Le close réel (src/real.ts) n'utilise JAMAIS cette table en lab (realMode=false).
  try {
    const mir = db
      .prepare(`SELECT id FROM real_positions WHERE position_pubkey = ?`)
      .get(`PAPER-${id}`) as { id: number } | undefined;
    if (mir) {
      db.prepare(`UPDATE real_positions SET status='closed', closed_at=?, close_reason=? WHERE id=?`)
        .run(pos.closed_at ?? Date.now(), reason, mir.id);
    }
  } catch { /* miroir absent (mode prod réel) → rien à faire */ }

  // Blacklist post-close (playbook gud, 2026-08-24) : « dead chart = dead
  // position » — si le volume 24h du pool est sous le seuil à la fermeture,
  // le token est blacklisté POST_CLOSE_BLACKLIST_HOURS : on ne ré-entre pas
  // sur un chart mort (leçon omo : 6 ré-ouvertures sur le même token en 24h).
  if (config.postCloseBlacklistEnabled) {
    const scan = db
      .prepare(`SELECT volume_24h FROM pool_scans WHERE pool_address = ? ORDER BY scanned_at DESC LIMIT 1`)
      .get(pos.pool_address) as { volume_24h: number | null } | undefined;
    if (scan?.volume_24h != null && scan.volume_24h < config.postCloseVolMin24h) {
      const tokenKey = (pos.token_x_symbol ?? pos.name ?? "?").toLowerCase();
      // Quotes réservées exclues (revue 2026-08-24) : « sol » est le token_x
      // le plus fréquent (SOL-USDC…) — blacklister une quote bloquerait tout.
      if (isBlacklistableToken(tokenKey)) {
        blacklistToken(
          tokenKey,
          config.postCloseBlacklistHours,
          `close ${reason} — vol 24h ${(scan.volume_24h / 1000).toFixed(0)}k$ < ${(config.postCloseVolMin24h / 1000).toFixed(0)}k$ (chart mort)`,
          pos.pool_address
        );
        logEvent(
          "blacklist",
          `🚫 Token ${pos.token_x_symbol ?? pos.name} blacklisté ${config.postCloseBlacklistHours}h — vol 24h ${(scan.volume_24h / 1000).toFixed(0)}k$ < ${(config.postCloseVolMin24h / 1000).toFixed(0)}k$ au close (${reason})`,
          { positionId: id, poolAddress: pos.pool_address }
        );
      }
    }
  }
}

/** Recentre la position sur le bin actif (paper, avec friction). */
export function rebalancePosition(id: number, price: number, valueUsd: number): void {
  const pos = getPosition(id);
  if (!pos) return;
  const activeBin = binIdFromPrice(price, pos.bin_step);
  const halfSpan = Math.max(1, Math.round((pos.max_bin_id - pos.min_bin_id) / 2));
  const friction = valueUsd * 0.003; // gas + spread estimés
  const newMin = activeBin - halfSpan;
  const newMax = activeBin + halfSpan;

  // Re-projection des montants SUR la courbe au nouveau prix (leçon lab 04/10 :
  // l'ancien code décalait bins + entry_price sans toucher amount_x/amount_y →
  // evaluatePosition dérivait un L faux et la valeur explosait — Agency #25 :
  // 31 rebalances, 1 134 $ marqués pour 500 $ déposés). Le dépôt en Y courant =
  // valeur USD du mark ÷ yUsd implicite (même conversion que markPosition ;
  // valueUsd est en USD — le traiter comme du Y créerait un artefact ×yUsd²).
  const oneSided =
    pos.amount_x === 0 && pos.amount_y > 0
      ? "y"
      : pos.amount_y === 0 && pos.amount_x > 0
        ? "x"
        : "none";
  let depositY: number;
  if (oneSided === "y") {
    depositY = pos.amount_y; // SOL intégralement en Y, invariant au recentering
  } else {
    // yUsd implicite du dernier mark : last_value_usd = valueY(mark) × yUsd.
    const markPrice = pos.last_mark_price ?? price;
    const valueYMark = evaluatePosition(pos, markPrice).valueY;
    const yUsdImpl = valueYMark > 0 && pos.last_value_usd != null && pos.last_value_usd > 0
      ? pos.last_value_usd / valueYMark
      : pos.deposit_usd / Math.max(1e-9, pos.amount_y + pos.amount_x * pos.entry_price);
    depositY = yUsdImpl > 0 ? valueUsd / yUsdImpl : pos.deposit_usd;
  }
  let liq: ReturnType<typeof buildLiquidity>;
  try {
    liq = buildLiquidity({
      depositY,
      price,
      minBinId: newMin,
      maxBinId: newMax,
      binStep: pos.bin_step,
      oneSided: oneSided as "none" | "x" | "y",
    });
  } catch (e) {
    logEvent("rebalance", `⚠️ ${pos.name} : re-projection ratée (${String(e)}) — rebalance sauté`, {
      positionId: id,
      poolAddress: pos.pool_address,
    });
    return;
  }

  db.prepare(
    `UPDATE paper_positions SET min_bin_id = ?, max_bin_id = ?, entry_active_bin = ?, entry_price = ?,
       day_start_price = ?, last_mark_price = ?, amount_x = ?, amount_y = ?,
       rebalance_count = rebalance_count + 1,
       last_value_usd = last_value_usd - ?
     WHERE id = ?`
  ).run(newMin, newMax, activeBin, price, price, price, liq.x0, liq.y0, friction, id);
  logEvent(
    "rebalance",
    `Rebalance paper sur ${pos.name} : bins [${newMin}..${newMax}] autour du bin ${activeBin} (friction ${friction.toFixed(2)}$)`,
    { positionId: id, poolAddress: pos.pool_address }
  );
}

/**
 * Flip d'une bidask-dip (playbook satsmonkes, setup 4) : le moteur
 * d'accumulation devient un moteur de distribution. La position est re-projetée
 * single-sided TOKEN (X) AU-DESSUS du prix actuel : le bag accumulé se vend
 * bin par bin quand le prix remonte dans la range. Le span est conservé, le
 * prix courant marque le bas de la nouvelle range. Les fees continuent de
 * s'accumuler pendant la reprise (enRange). Échec = re-dump sous le bas de la
 * range → close « flip-failed » dans markPosition.
 */
export function flipPosition(id: number, price: number, depositY: number): void {
  const pos = getPosition(id);
  if (!pos) return;
  const activeBin = binIdFromPrice(price, pos.bin_step);
  const span = Math.max(1, pos.max_bin_id - pos.min_bin_id);
  const minBinId = activeBin;
  const maxBinId = activeBin + span;
  const liq = buildLiquidity({
    depositY,
    price,
    minBinId,
    maxBinId,
    binStep: pos.bin_step,
    oneSided: "x",
  });
  db.prepare(
    `UPDATE paper_positions SET strategy = 'bidask-flip', min_bin_id = ?, max_bin_id = ?,
       entry_active_bin = ?, entry_price = ?, day_start_price = ?, last_mark_price = ?,
       amount_x = ?, amount_y = ?
     WHERE id = ?`
  ).run(minBinId, maxBinId, activeBin, price, price, price, liq.x0, liq.y0, id);
  logEvent(
    "flip",
    `↕ Flip ${pos.name} : accumulation → distribution — range [${minBinId}..${maxBinId}] au-dessus de ${price.toPrecision(6)}, ${liq.x0.toPrecision(4)} ${pos.token_x_symbol} à distribuer dans la reprise`,
    { positionId: id, poolAddress: pos.pool_address }
  );
}

/** Mark-to-market de toutes les positions ouvertes. */
export async function markAll(): Promise<{ id: number; result: MarkResult }[]> {
  const results: { id: number; result: MarkResult }[] = [];
  for (const pos of getOpenPositions()) {
    try {
      results.push({ id: pos.id, result: await markPosition(pos) });
    } catch (err) {
      logEvent("mark", `Mark échoué pour ${pos.name}: ${String(err)}`, {
        positionId: pos.id,
        poolAddress: pos.pool_address,
      });
    }
  }
  return results;
}

export function getPortfolioSummary(): {
  open: number;
  investedUsd: number;
  valueUsd: number;
  feesEarnedUsd: number;
  feesClaimedUsd: number;
  netPnlUsd: number;
  rebalances: number;
} {
  const row = db
    .prepare(
      `SELECT COUNT(CASE WHEN status='open' THEN 1 END) as open,
              COALESCE(SUM(CASE WHEN status='open' THEN deposit_usd END),0) as invested,
              COALESCE(SUM(CASE WHEN status='open' THEN last_value_usd END),0) as value,
              COALESCE(SUM(fees_earned_usd),0) as fees,
              COALESCE(SUM(fees_claimed_usd),0) as claimed,
              COALESCE(SUM(CASE WHEN status='open' THEN last_value_usd - deposit_usd + fees_earned_usd + fees_claimed_usd END),0) as net,
              COALESCE(SUM(rebalance_count),0) as rebalances
       FROM paper_positions`
    )
    .get() as {
    open: number;
    invested: number;
    value: number;
    fees: number;
    claimed: number;
    net: number;
    rebalances: number;
  };
  return {
    open: row.open,
    investedUsd: row.invested,
    valueUsd: row.value,
    feesEarnedUsd: row.fees,
    feesClaimedUsd: row.claimed,
    netPnlUsd: row.net,
    rebalances: row.rebalances,
  };
}
