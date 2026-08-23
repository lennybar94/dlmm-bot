// Export JSON pour le dashboard (data/export/*.json). Le dashboard ne lit JAMAIS la DB
// en mode export — il lit ces fichiers (ou la DB directement si DASHBOARD_LIVE=true).

import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { config } from "./config.js";
import { getPortfolioSummary, getOpenPositions } from "./paper.js";
import { getRules, getRuleChanges } from "./rules.js";
import { bucketStats } from "./tuner.js";

// --- Prix SOL/USD temps réel (API CoinGecko, cache 60 s, fallback stale) ---
let solPriceCache: { price: number | null; fetchedAt: number } = { price: null, fetchedAt: 0 };
// Jupiter /price/v2 renvoie 404 (endpoint changé, 2026-08) → CoinGecko (1 req/min max avec le cache).

async function fetchSolPriceUsd(): Promise<number | null> {
  try {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { solana?: { usd?: number } };
    const price = Number(data.solana?.usd);
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
      name: p.name,
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
  // principal ne montrait que le paper ; le réel vivait sur pool.html +
  // Telegram + rapport. Ajouté 2026-08-23 (demande David).
  const realRows = (db
    .prepare(
      `SELECT rp.id, rp.name, rp.strategy, rp.pool_address, rp.deposit_usd, rp.amount_y,
              rp.min_bin_id, rp.max_bin_id, rp.position_pubkey, rp.opened_at,
              rm.value_usd, rm.net_pnl_usd, rm.in_range, rm.taken_at
       FROM real_positions rp
       LEFT JOIN real_marks rm ON rm.id = (
         SELECT id FROM real_marks WHERE position_id = rp.id ORDER BY id DESC LIMIT 1)
       WHERE rp.status = 'open'
       ORDER BY rp.id`
    )
    .all() as Record<string, unknown>[]);
  const real = realRows.length
    ? {
        positions: realRows.map((p) => ({
          id: p.id,
          name: p.name,
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
        })),
        summary: {
          open: realRows.length,
          investedUsd: realRows.reduce((a, p) => a + Number(p.deposit_usd ?? 0), 0),
          valueUsd: realRows.reduce((a, p) => a + Number(p.value_usd ?? 0), 0),
          netPnlUsd: realRows.reduce((a, p) => a + Number(p.net_pnl_usd ?? 0), 0),
          deployedSol: realRows.reduce((a, p) => a + Number(p.amount_y ?? 0), 0),
        },
      }
    : null;

  const payload = {
    generated_at: now,
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
      if (r.vol_24h < 0.1) return "bas (<10%)";
      if (r.vol_24h < 0.3) return "moyen (10-30%)";
      return "élevé (>30%)";
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
