// Scanner d'opportunités : pools top volume → filtres de sécurité → volatilité →
// score → signaux + hint de stratégie.

import { db, logEvent } from "./db.js";
import { config } from "./config.js";
import { fetchOhlcv, fetchTopPools } from "./api.js";
import { realizedVolatility, buildStrategyHint, binIdFromPrice } from "./strategies.js";
import { getRules, strategyForVolatility, type RuleSet } from "./rules.js";
import type { OpportunityScore, Pool } from "./types.js";

export interface ScanResult {
  scannedAt: number;
  poolsSeen: number;
  poolsKept: number;
  opportunities: OpportunityScore[];
}

function passesFilters(p: Pool, rules: RuleSet): { ok: boolean; reason: string } {
  if (p.is_blacklisted) return { ok: false, reason: "blacklisté" };
  if (p.tvl < config.minTvl) return { ok: false, reason: `TVL < ${config.minTvl}$` };
  if (p.volume_24h < config.minVolume24h)
    return { ok: false, reason: `vol 24h < ${config.minVolume24h}$` };
  if (p.pool_age_days < config.minPoolAgeDays)
    return { ok: false, reason: "pool trop récent" };
  if (p.fee_tvl_ratio_24h < rules.minFeeTvlRatio24h)
    return { ok: false, reason: `fees/TVL 24h < ${rules.minFeeTvlRatio24h}%` };
  if (!p.current_price || p.current_price <= 0) return { ok: false, reason: "prix absent" };
  return { ok: true, reason: "" };
}

/**
 * Score composite (0-100), pondérations issues des RÈGLES (apprises par le tuner) :
 * - log(fee_apr_24h) normalisé (les APR suivent une loi de puissance)
 * - stabilité du volume (volume_1h vs volume_24h/24)
 * - pénalité pour les pools très jeunes / sans launchpad connu
 */
export function scorePool(p: Pool, vol24h: number, rules: RuleSet): { score: number; signals: string[] } {
  const signals: string[] = [];
  const aprLog = Math.log10(1 + p.fee_apr_24h); // 1+ → APR 1000% ≈ 3.0
  const volStability = Math.min(1, p.volume_1h / Math.max(1, p.volume_24h / 24));
  const tvlScore = Math.min(1, Math.sqrt(p.tvl / 500_000));
  const farmBonus = p.farm_apr > 10 ? rules.farmBonus : 0;
  const volPenalty = vol24h > 1.2 ? rules.volPenalty : 0; // volatilité extrême

  let score =
    (rules.wApr / 100) * Math.min(1, aprLog / 3) * 100 +
    (rules.wVolStability / 100) * volStability * 100 +
    (rules.wTvl / 100) * tvlScore * 100 +
    rules.wBase +
    farmBonus * 100 +
    volPenalty * 100;
  score = Math.max(0, Math.min(100, score));

  if (p.fee_apr_24h > 100) signals.push("APR fees 24h > 100%");
  if (volStability > 0.7) signals.push("volume stable");
  if (p.fee_tvl_ratio_24h > 0.5) signals.push("fees/TVL très élevé");
  if (p.launchpad) signals.push(`launchpad: ${p.launchpad}`);
  if (p.farm_apr > 10) signals.push(`farm APR ${p.farm_apr.toFixed(0)}%`);
  if (vol24h > 0.5) signals.push(`volatilité élevée (${(vol24h * 100).toFixed(0)}%/j)`);
  // Playbook quick in & out (LP Army) : volume ≥ 30k$/min ≈ ≥ 900k$/30min
  if (p.volume_1h >= 900_000) signals.push("volume burst (≥30k$/min sur 1h)");
  // Insight LP Army : gros bin step = couverture de dump large (200 bp ≈ -75%
  // en ~70 bins) + fees dynamiques qui s'envolent sur gros volume
  if (p.bin_step >= 100) signals.push(`bin step large (${p.bin_step} bp — couverture dump -75% en ~${Math.round(Math.log(0.25) / Math.log(1 + p.bin_step / 10000))} bins)`);
  if (score >= 55) signals.push("top opportunité");
  return { score, signals };
}

export async function runScan(): Promise<ScanResult> {
  const scannedAt = Date.now();
  const rules = getRules();
  const pools = await fetchTopPools(config.scanTopPools);
  const kept: Pool[] = [];
  const rejected: { pool: Pool; reason: string }[] = [];

  for (const p of pools) {
    const f = passesFilters(p, rules);
    if (f.ok) kept.push(p);
    else rejected.push({ pool: p, reason: f.reason });
  }

  // Volatilité réalisée sur les pools retenus (30 RPS max → délai).
  const opportunities: OpportunityScore[] = [];
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    try {
      const candles = await fetchOhlcv(p.address, 24);
      const vol = realizedVolatility(candles);
      // Plafond de volatilité : les pools à σ extrême encaissent des frais mais
      // détruisent les petits gains en IL (leçon du jour 1 : Qenis-SOL σ 160%).
      if (vol > config.maxVol24h) {
        rejected.push({
          pool: p,
          reason: `volatilité ${(vol * 100).toFixed(0)}% > max ${(config.maxVol24h * 100).toFixed(0)}%`,
        });
        continue;
      }
      const { score, signals } = scorePool(p, vol, rules);
      const activeBinId = binIdFromPrice(p.current_price, p.bin_step);
      const strategy = strategyForVolatility(vol, rules);
      const hint = buildStrategyHint(p.address, activeBinId, vol, strategy);
      opportunities.push({ pool: p, vol_24h: vol, score, signals, strategyHint: hint });
    } catch (err) {
      logEvent("scan", `OHLCV échoué pour ${p.name}: ${String(err)}`, {
        poolAddress: p.address,
      });
    }
    await new Promise((r) => setTimeout(r, config.apiRequestDelayMs));
  }

  opportunities.sort((a, b) => b.score - a.score);

  const insertPool = db.prepare(
    `INSERT INTO pool_scans (scanned_at, pool_address, name, token_x_symbol, token_y_symbol,
       tvl, volume_1h, volume_24h, fee_tvl_ratio_1h, fee_tvl_ratio_24h, fee_apr_24h, farm_apr,
       base_fee_pct, dynamic_fee_pct, bin_step, launchpad, is_blacklisted, current_price,
       vol_24h, score, signals, strategy_hint, pool_age_days, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSignal = db.prepare(
    `INSERT INTO signals (created_at, pool_address, name, score, fee_apr_24h, tvl, volume_24h, signal_type, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'opportunity', ?)`
  );

  for (const opp of opportunities) {
    const p = opp.pool;
    insertPool.run(
      scannedAt,
      p.address,
      p.name,
      p.token_x.symbol,
      p.token_y.symbol,
      p.tvl,
      p.volume_1h,
      p.volume_24h,
      p.fee_tvl_ratio_1h,
      p.fee_tvl_ratio_24h,
      p.fee_apr_24h,
      p.farm_apr,
      p.base_fee_pct,
      p.dynamic_fee_pct,
      p.bin_step,
      p.launchpad,
      p.is_blacklisted ? 1 : 0,
      p.current_price,
      opp.vol_24h,
      opp.score,
      JSON.stringify(opp.signals),
      JSON.stringify(opp.strategyHint),
      p.pool_age_days,
      p.created_at
    );
    for (const sig of opp.signals) {
      insertSignal.run(Date.now(), p.address, p.name, opp.score, p.fee_apr_24h, p.tvl, p.volume_24h, sig);
    }
  }
  for (const r of rejected) {
    insertPool.run(
      scannedAt,
      r.pool.address,
      r.pool.name,
      r.pool.token_x.symbol,
      r.pool.token_y.symbol,
      r.pool.tvl,
      r.pool.volume_1h,
      r.pool.volume_24h,
      r.pool.fee_tvl_ratio_1h,
      r.pool.fee_tvl_ratio_24h,
      r.pool.fee_apr_24h,
      r.pool.farm_apr,
      r.pool.base_fee_pct,
      r.pool.dynamic_fee_pct,
      r.pool.bin_step,
      r.pool.launchpad,
      r.pool.is_blacklisted ? 1 : 0,
      r.pool.current_price,
      0,
      0,
      "[]",
      "{}",
      r.pool.pool_age_days,
      r.pool.created_at
    );
  }

  logEvent("scan", `Scan terminé : ${pools.length} pools vus, ${kept.length} retenus, ${opportunities.length} opportunités scorées.`);
  return { scannedAt, poolsSeen: pools.length, poolsKept: kept.length, opportunities };
}
