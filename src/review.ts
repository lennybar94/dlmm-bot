// Outcome reviews : à la fermeture d'une position (verdict réalisé) et
// hebdomadaire pour les positions ouvertes ≥ 7 j. Chaque review capture le
// résultat (PnL, frais, IL, temps en range) + les caractéristiques d'entrée
// (buckets d'évidence) pour alimenter le tuner.

import { db, logEvent } from "./db.js";
import type { PaperPositionRow } from "./types.js";

export interface ReviewRow {
  id: number;
  position_id: number;
  review_type: "closed" | "weekly";
  reviewed_at: number;
  pool_address: string;
  name: string;
  strategy: string;
  opened_at: number;
  closed_at: number | null;
  age_days: number;
  deposit_usd: number;
  value_usd: number;
  fees_usd: number;
  il_usd: number;
  net_pnl_usd: number;
  net_pnl_pct: number;
  exit_reason: string | null;
  in_range_pct: number | null;
  rebalance_count: number;
  fee_tvl_ratio_24h: number | null;
  vol_24h: number | null;
  bin_step: number | null;
  launchpad: string | null;
  pool_age_days: number | null;
  tvl: number | null;
}

/** Caractéristiques d'entrée du pool (scan le plus proche de l'ouverture). */
function entryFeatures(poolAddress: string, openedAt: number) {
  const row = db
    .prepare(
      `SELECT fee_tvl_ratio_24h, vol_24h, bin_step, launchpad, pool_age_days, tvl
       FROM pool_scans WHERE pool_address = ?
       ORDER BY ABS(scanned_at - ?) ASC LIMIT 1`
    )
    .get(poolAddress, openedAt) as
    | {
        fee_tvl_ratio_24h: number | null;
        vol_24h: number | null;
        bin_step: number | null;
        launchpad: string | null;
        pool_age_days: number | null;
        tvl: number | null;
      }
    | undefined;
  return row ?? null;
}

/** Crée la review d'une position (dédupliquée par type). */
export function insertReview(pos: PaperPositionRow, reviewType: "closed" | "weekly"): ReviewRow | null {
  const existing = db
    .prepare(
      "SELECT id FROM outcome_reviews WHERE position_id = ? AND review_type = ? AND reviewed_at > ?"
    )
    .get(pos.id, reviewType, Date.now() - 7 * 86_400_000);
  if (existing) return null;

  const fees = (pos.fees_earned_usd ?? 0) + (pos.fees_claimed_usd ?? 0);
  const lastSnap = db
    .prepare(
      "SELECT net_pnl_usd, il_usd FROM pnl_snapshots WHERE position_id = ? ORDER BY taken_at DESC LIMIT 1"
    )
    .get(pos.id) as { net_pnl_usd: number; il_usd: number } | undefined;
  const rangeStats = db
    .prepare(
      "SELECT COUNT(*) total, COALESCE(SUM(in_range), 0) inr FROM pnl_snapshots WHERE position_id = ?"
    )
    .get(pos.id) as { total: number; inr: number };

  const netPnl = lastSnap?.net_pnl_usd ?? pos.last_value_usd - pos.deposit_usd + fees;
  const ilUsd = lastSnap?.il_usd ?? pos.last_il_usd;
  const netPnlPct = pos.deposit_usd > 0 ? (netPnl / pos.deposit_usd) * 100 : 0;
  const inRangePct = rangeStats.total > 0 ? (rangeStats.inr / rangeStats.total) * 100 : null;
  const ageDays = (Date.now() - pos.opened_at) / 86_400_000;
  const feat = entryFeatures(pos.pool_address, pos.opened_at);

  const info = db
    .prepare(
      `INSERT INTO outcome_reviews
       (position_id, review_type, reviewed_at, pool_address, name, strategy, opened_at, closed_at,
        age_days, deposit_usd, value_usd, fees_usd, il_usd, net_pnl_usd, net_pnl_pct,
        exit_reason, in_range_pct, rebalance_count,
        fee_tvl_ratio_24h, vol_24h, bin_step, launchpad, pool_age_days, tvl)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      pos.id,
      reviewType,
      Date.now(),
      pos.pool_address,
      pos.name,
      pos.strategy,
      pos.opened_at,
      pos.closed_at,
      ageDays,
      pos.deposit_usd,
      pos.last_value_usd,
      fees,
      ilUsd,
      netPnl,
      netPnlPct,
      pos.close_reason,
      inRangePct,
      pos.rebalance_count,
      feat?.fee_tvl_ratio_24h ?? null,
      feat?.vol_24h ?? null,
      feat?.bin_step ?? null,
      feat?.launchpad ?? null,
      feat?.pool_age_days ?? null,
      feat?.tvl ?? null
    );

  const id = Number(info.lastInsertRowid);
  logEvent(
    reviewType === "closed" ? "review" : "review-weekly",
    `Review ${reviewType} de ${pos.name} : PnL ${netPnlPct >= 0 ? "+" : ""}${netPnlPct.toFixed(1)}% (${netPnl.toFixed(2)}$), frais ${fees.toFixed(2)}$, en range ${inRangePct?.toFixed(0) ?? "—"}%`,
    { positionId: pos.id, poolAddress: pos.pool_address }
  );
  return {
    id,
    position_id: pos.id,
    review_type: reviewType,
    reviewed_at: Date.now(),
    pool_address: pos.pool_address,
    name: pos.name,
    strategy: pos.strategy,
    opened_at: pos.opened_at,
    closed_at: pos.closed_at,
    age_days: ageDays,
    deposit_usd: pos.deposit_usd,
    value_usd: pos.last_value_usd,
    fees_usd: fees,
    il_usd: ilUsd,
    net_pnl_usd: netPnl,
    net_pnl_pct: netPnlPct,
    exit_reason: pos.close_reason,
    in_range_pct: inRangePct,
    rebalance_count: pos.rebalance_count,
    fee_tvl_ratio_24h: feat?.fee_tvl_ratio_24h ?? null,
    vol_24h: feat?.vol_24h ?? null,
    bin_step: feat?.bin_step ?? null,
    launchpad: feat?.launchpad ?? null,
    pool_age_days: feat?.pool_age_days ?? null,
    tvl: feat?.tvl ?? null,
  };
}

/** Reasons de fermeture ADMINISTRATIVES (réallocation, opérations) — pas des
 * outcomes de stratégie : elles ne doivent PAS créer de review (une position
 * fermée à l'ouverture avec PnL ~0 polluerait l'évidence du tuner). */
const ADMIN_CLOSE_REASONS = new Set(["reconfig", "admin", "admin-close", "manual"]);

/** Review à la fermeture (appelée par closePosition). */
export function reviewPositionOnClose(pos: PaperPositionRow): void {
  if (pos.status !== "closed") return;
  if (pos.close_reason && ADMIN_CLOSE_REASONS.has(pos.close_reason)) return;
  insertReview(pos, "closed");
}

/** Reviews hebdomadaires des positions ouvertes depuis ≥ minAgeDays. */
export function runWeeklyReviews(minAgeDays = 7): number {
  const cutoff = Date.now() - minAgeDays * 86_400_000;
  const positions = db
    .prepare(
      "SELECT * FROM paper_positions WHERE status = 'open' AND opened_at <= ?"
    )
    .all(cutoff) as PaperPositionRow[];
  let count = 0;
  for (const pos of positions) {
    if (insertReview(pos, "weekly")) count++;
  }
  if (count > 0) logEvent("review", `${count} review(s) hebdomadaire(s) créée(s)`);
  return count;
}
