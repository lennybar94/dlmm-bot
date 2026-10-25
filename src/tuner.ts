// Tuner : ajuste les règles du bot à partir des outcome reviews.
// Principe (repris du copy bot) : on n'apprend JAMAIS sur du bruit —
// échantillon minimum par bucket, pas de petit pas, changement versionné avec
// la raison, et au plus un run de tuning par jour.

import { db, logEvent, getMeta, setMeta } from "./db.js";
import { config } from "./config.js";
import { getRules, applyRuleChange, strategyForVolatility } from "./rules.js";

export interface BucketStat {
  band: string;
  n: number;
  avgPnlPct: number;
  avgFeesUsd: number;
  avgInRangePct: number | null;
  bestStrategy: string | null;
}

export interface ReviewLike {
  fee_tvl_ratio_24h: number | null;
  vol_24h: number | null;
  strategy: string;
  net_pnl_pct: number;
  fees_usd: number;
  in_range_pct: number | null;
}

function feeBand(v: number | null): string {
  if (v === null) return "inconnu";
  if (v < 0.05) return "bas (<5%)";
  if (v < 0.2) return "moyen (5-20%)";
  return "élevé (>20%)";
}

function volBand(v: number | null): string {
  // Fix 25/10 : seuils ÷√24 exacts ; labels en σ daily réel (≈2 % / ≈6 %).
  if (v === null) return "inconnu";
  if (v < 0.1 / Math.sqrt(24)) return "bas (<2%)";
  if (v < 0.3 / Math.sqrt(24)) return "moyen (2-6%)";
  return "élevé (>6%)";
}

/** Statistiques d'un bucket (n, PnL moyen, frais moyens, meilleure stratégie). */
export function bucketStats(
  bucketFn: (r: ReviewLike) => string,
  reviews: ReviewLike[]
): BucketStat[] {
  const groups = new Map<string, ReviewLike[]>();
  for (const r of reviews) {
    const b = bucketFn(r);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b)!.push(r);
  }
  const out: BucketStat[] = [];
  for (const [band, rs] of groups) {
    const avg = (f: (r: ReviewLike) => number) =>
      rs.reduce((a, r) => a + f(r), 0) / rs.length;
    // meilleure stratégie (n ≥ 3 par stratégie)
    const byStrat = new Map<string, ReviewLike[]>();
    for (const r of rs) {
      if (!byStrat.has(r.strategy)) byStrat.set(r.strategy, []);
      byStrat.get(r.strategy)!.push(r);
    }
    let best: string | null = null;
    let bestAvg = -Infinity;
    for (const [s, srs] of byStrat) {
      if (srs.length < 3) continue;
      const a = srs.reduce((x, r) => x + r.net_pnl_pct, 0) / srs.length;
      if (a > bestAvg) {
        bestAvg = a;
        best = s;
      }
    }
    out.push({
      band,
      n: rs.length,
      avgPnlPct: avg((r) => r.net_pnl_pct),
      avgFeesUsd: avg((r) => r.fees_usd),
      avgInRangePct: rs.some((r) => r.in_range_pct !== null)
        ? avg((r) => r.in_range_pct ?? 0)
        : null,
      bestStrategy: best,
    });
  }
  return out.sort((a, b) => b.n - a.n);
}

/** Toutes les reviews exploitables (fermetures + hebdo ≥ 7 j). */
function allReviews(): ReviewLike[] {
  const rows = db
    .prepare(
      `SELECT fee_tvl_ratio_24h, vol_24h, strategy, net_pnl_pct, fees_usd, in_range_pct
       FROM outcome_reviews`
    )
    .all() as ReviewLike[];
  return rows;
}

export interface TuneResult {
  applied: number;
  skipped: boolean;
  reason: string;
  changes: { key: string; before: string; after: string }[];
}

/** Un run de tuning (gated : échantillon min + 1×/24h). */
export function runTune(): TuneResult {
  const rules = getRules();
  const reviews = allReviews();
  const changes: { key: string; before: string; after: string }[] = [];

  if (reviews.length < config.tuneMinSamples) {
    return {
      applied: 0,
      skipped: true,
      reason: `échantillon insuffisant (${reviews.length}/${config.tuneMinSamples} reviews) — pas d'apprentissage sur du bruit`,
      changes,
    };
  }

  const lastTune = getMeta("last_tune_at");
  if (lastTune && Date.now() - Number(lastTune) < config.tuneMinHoursBetween * 3_600_000) {
    return {
      applied: 0,
      skipped: true,
      reason: `dernier tuning il y a moins de ${config.tuneMinHoursBetween}h`,
      changes,
    };
  }

  const fmt = (v: number, d = 2) => `${v.toFixed(d)}%`;

  // 1) Seuil fees/TVL : la bande basse perd-elle ?
  const feeBands = bucketStats((r) => feeBand(r.fee_tvl_ratio_24h), reviews);
  const lowFee = feeBands.find((b) => b.band.startsWith("bas"));
  if (lowFee && lowFee.n >= 5 && lowFee.avgPnlPct < -5) {
    const before = rules.minFeeTvlRatio24h;
    const after = Math.min(0.1, before + 0.005);
    if (after > before) {
      applyRuleChange(
        "minFeeTvlRatio24h",
        before,
        after,
        `bande fees/TVL basse en perte (${fmt(lowFee.avgPnlPct)} sur ${lowFee.n} reviews) → seuil relevé`
      );
      changes.push({ key: "minFeeTvlRatio24h", before: String(before), after: String(after) });
    }
  }

  // 2) Stratégie par bande de volatilité : basculer vers la meilleure observée.
  for (const band of ["low", "mid", "high"] as const) {
    const key = `strategyByVol.${band}` as const;
    const label = band === "low" ? "bas (<2%)" : band === "mid" ? "moyen (2-6%)" : "élevé (>6%)";
    const stat = bucketStats((r) => volBand(r.vol_24h), reviews).find((b) => b.band.startsWith(label.split(" ")[0]));
    if (!stat || stat.n < 5 || !stat.bestStrategy) continue;
    const current = strategyForVolatility(
      // Points d'échantillonnage dans la MÊME unité que les seuils (÷√24) — fix 25/10.
      band === "low" ? 0.05 / Math.sqrt(24) : band === "mid" ? 0.2 / Math.sqrt(24) : 0.5 / Math.sqrt(24),
      rules
    );
    if (stat.bestStrategy !== current && stat.avgPnlPct > 0) {
      applyRuleChange(
        key,
        current,
        stat.bestStrategy,
        `vol ${label} : ${stat.bestStrategy} meilleure (${fmt(stat.avgPnlPct)} vs ${current} actuel) sur ${stat.n} reviews`
      );
      changes.push({ key, before: current, after: stat.bestStrategy });
    }
  }

  // 3) Seuil de rebalance : trop de temps hors range → recentrer plus tard.
  const withRange = reviews.filter((r) => r.in_range_pct !== null);
  if (withRange.length >= 5) {
    const avgInRange =
      withRange.reduce((a, r) => a + (r.in_range_pct ?? 0), 0) / withRange.length;
    if (avgInRange < 50) {
      const before = rules.rebalanceThreshold;
      const after = Math.min(0.7, before + 0.05);
      if (after > before) {
        applyRuleChange(
          "rebalanceThreshold",
          before,
          after,
          `temps en range moyen ${avgInRange.toFixed(0)}% (<50%) → rebalance plus tardive`
        );
        changes.push({ key: "rebalanceThreshold", before: String(before), after: String(after) });
      }
    } else if (avgInRange > 85) {
      const before = rules.rebalanceThreshold;
      const after = Math.max(0.3, before - 0.05);
      if (after < before) {
        applyRuleChange(
          "rebalanceThreshold",
          before,
          after,
          `temps en range moyen ${avgInRange.toFixed(0)}% (>85%) → rebalance plus tôt (range plus serré)`
        );
        changes.push({ key: "rebalanceThreshold", before: String(before), after: String(after) });
      }
    }
  }

  // 4) Pénalité de volatilité : la bande haute perd-elle ?
  const highVol = bucketStats((r) => volBand(r.vol_24h), reviews).find((b) =>
    b.band.startsWith("élevé")
  );
  if (highVol && highVol.n >= 5 && highVol.avgPnlPct < -10) {
    const before = rules.volPenalty;
    const after = Math.max(-0.3, before - 0.05);
    if (after < before) {
      applyRuleChange(
        "volPenalty",
        before,
        after,
        `vol élevée en perte (${fmt(highVol.avgPnlPct)} sur ${highVol.n} reviews) → pénalité renforcée`
      );
      changes.push({ key: "volPenalty", before: String(before), after: String(after) });
    }
  }

  setMeta("last_tune_at", String(Date.now()));
  const reason =
    changes.length > 0
      ? `${changes.length} règle(s) ajustée(s) sur ${reviews.length} reviews`
      : `aucun ajustement nécessaire (${reviews.length} reviews analysées)`;
  logEvent("tune", reason);
  return { applied: changes.length, skipped: false, reason, changes };
}
