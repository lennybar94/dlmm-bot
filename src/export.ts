// Export JSON pour le dashboard (data/export/*.json). Le dashboard ne lit JAMAIS la DB
// en mode export — il lit ces fichiers (ou la DB directement si DASHBOARD_LIVE=true).

import fs from "node:fs";
import path from "node:path";
import { db } from "./db.js";
import { config } from "./config.js";
import { getPortfolioSummary, getOpenPositions } from "./paper.js";
import { getRules, getRuleChanges } from "./rules.js";
import { bucketStats } from "./tuner.js";

export function exportData(): string {
  const dir = path.join(config.dataDir, "export");
  fs.mkdirSync(dir, { recursive: true });
  const now = Date.now();

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
      name: r.name,
      tvl: r.tvl,
      volume_24h: r.volume_24h,
      volume_1h: r.volume_1h,
      fee_apr_24h: r.fee_apr_24h,
      fee_tvl_ratio_24h: r.fee_tvl_ratio_24h,
      bin_step: r.bin_step,
      current_price: r.current_price,
      vol_24h: r.vol_24h,
      score: r.score,
      signals: safeJson(r.signals as string),
      strategy_hint: safeJson(r.strategy_hint as string),
    }));

  const positions = getOpenPositions().map((p) => ({
    id: p.id,
    opened_at: p.opened_at,
    pool_address: p.pool_address,
    name: p.name,
    strategy: p.strategy,
    deposit_usd: p.deposit_usd,
    value_usd: p.last_value_usd,
    fees: (p.fees_earned_usd ?? 0) + (p.fees_claimed_usd ?? 0),
    il_usd: p.last_il_usd,
    net_pnl: p.last_value_usd - p.deposit_usd + p.fees_earned_usd + p.fees_claimed_usd,
    min_bin_id: p.min_bin_id,
    max_bin_id: p.max_bin_id,
    entry_price: p.entry_price,
    rebalance_count: p.rebalance_count,
  }));

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

  const events = (db
    .prepare(
      `SELECT created_at, position_id, pool_address, type, message FROM events
       WHERE created_at > ? ORDER BY created_at DESC LIMIT 100`
    )
    .all(now - 7 * 86_400_000) as Record<string, unknown>[]).map((e) => ({
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

  const payload = {
    generated_at: now,
    summary: getPortfolioSummary(),
    last_activity: {
      last_scan_at: lastScanAt.m ?? null,
      last_mark_at: lastMarkAt.m ?? null,
      last_monitor_at: lastMonitorAt.m ?? null,
      dashboard_started_at: now - Math.round(process.uptime() * 1000),
      monitor_interval_min: config.monitorIntervalMin,
    },
    learning: buildLearningExport(),
    opportunities,
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
