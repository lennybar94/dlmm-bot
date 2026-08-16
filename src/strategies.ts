// Stratégies DLMM : presets de forme de liquidité + dimensionnement par volatilité.
// Inspiré des shapes officielles (Spot/Curve/BidAsk) et du bot meteora_meme
// (volatilité → span), et du recentrage à la MeteorShower.

import { config } from "./config.js";
import type { OhlcvCandle, Pool, StrategyHint, StrategyPreset } from "./types.js";

export const STRATEGY_PRESETS: Record<string, StrategyPreset> = {
  "spot-concentrated": {
    name: "spot-concentrated",
    minBinsPerSide: 1,
    maxBinsPerSide: 3,
    sdkStrategy: "Spot",
    oneSided: "none",
    description: "Uniforme sur 1-3 bins de chaque côté — max capital efficiency, très actif.",
  },
  "spot-spread": {
    name: "spot-spread",
    minBinsPerSide: 10,
    maxBinsPerSide: 15,
    sdkStrategy: "Spot",
    oneSided: "none",
    description: "Uniforme sur 20-30 bins — équilibre frais vs couverture.",
  },
  "spot-wide": {
    name: "spot-wide",
    minBinsPerSide: 20,
    maxBinsPerSide: 30,
    sdkStrategy: "Spot",
    oneSided: "none",
    description: "Uniforme sur ~50 bins — résilient, rebalance rare.",
  },
  curve: {
    name: "curve",
    minBinsPerSide: 5,
    maxBinsPerSide: 10,
    sdkStrategy: "Curve",
    oneSided: "none",
    description: "Concentré au centre — pour marchés calmes/stables.",
  },
  bidask: {
    name: "bidask",
    minBinsPerSide: 8,
    maxBinsPerSide: 12,
    sdkStrategy: "BidAsk",
    oneSided: "none",
    description: "Liquidité aux bords — DCA / marchés volatils.",
  },
  // Playbook LP Army (Tikz/VladimirKovacs, MeteoraFR) : SOL-only, BidAsk,
  // range du prix actuel jusqu'à -70/-80% de dump. Échelle d'achat de la
  // chute + frais dynamiques élevés sur gros volumes. Positions AFK heures/jours.
  "bidask-dip": {
    name: "bidask-dip",
    minBinsPerSide: 35,
    maxBinsPerSide: 90,
    sdkStrategy: "BidAsk",
    oneSided: "y",
    description: "BidAsk SOL-only du prix courant jusqu'à -75% (échelle anti-dump, style LP Army).",
  },
  // Playbook Tikz1070 (quick in & out) : Spot SERRÉ 1-3 bins de chaque côté sur
  // un pool RÉCENT en spike de volume (≥30K$/min) à frais élevés. Position
  // courte (minutes/heures) : on encaisse les fees du spike et on sort vite
  // (volume fade ou OOR → pull). « fast in and fast out ».
  "quick-inout": {
    name: "quick-inout",
    minBinsPerSide: 1,
    maxBinsPerSide: 3,
    sdkStrategy: "Spot",
    oneSided: "none",
    description: "Spot serré 1-3 bins — quick in & out (Tikz1070) : spike ≥30K$/min sur pool récent, sortie rapide.",
  },
};

export const DEFAULT_STRATEGY = "spot-spread";
export const DIP_DEFAULT_TARGET = 0.75; // couverture de dump par défaut (75%)

/**
 * Candidat « fee printer » (playbook 0xmiir) : gros volume 24h ET gros ratio de
 * frais (fees/TVL 24h ≥ seuil). Ces pools sont les meilleurs encaisseurs de
 * frais du marché malgré une volatilité extrême — ils passent le plafond σ du
 * scan (l'échelle bidask-dip + le filtre drawdown sont les protections).
 */
export function isFeePrinterCandidate(p: {
  volume_24h: number;
  fee_tvl_ratio_24h: number;
}): boolean {
  return (
    p.volume_24h >= config.minVolume24hBidask &&
    p.fee_tvl_ratio_24h >= config.minFeeTvlFeePrinter
  );
}

/** Token suivi en watchlist (playbook 0xmiir — les « fee printers » nommés). */
export function isWatchlisted(symbol: string | undefined): boolean {
  if (!symbol) return false;
  return config.watchlistTokens
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .includes(symbol.toUpperCase());
}

/**
 * Candidat « quick in & out » (playbook Tikz1070) : spike de volume 30 min
 * ≥ 30K$/min sur un pool RÉCENT (≤ QUICK_MAX_POOL_AGE_DAYS) avec des frais qui
 * tournent (fees/TVL 30m ≥ seuil). C'est la porte d'entrée du playbook — ces
 * pools passent les filtres d'âge/TVL/volatilité du scan classique.
 */
export function isQuickInOutCandidate(p: {
  volume_30m: number;
  pool_age_days: number;
  fee_tvl_ratio_30m: number;
}): boolean {
  return (
    p.volume_30m >= config.quickMinVolume30m &&
    p.pool_age_days <= config.quickMaxPoolAgeDays &&
    p.fee_tvl_ratio_30m >= config.quickMinFeeTvlRatio30m
  );
}

/**
 * Cible de couverture de dump selon le profil du token (playbook Tiagogo/MeteoraFR) :
 * - shitcoin récent (pool < N jours) ou launchpad pump.fun → couverture large (-90%) :
 *   "Shitcoin récent ou +3000% en une nuit = -90%, pas de discussion"
 * - token établi avec du volume → -60/-70% : "Token établi avec du volume = -60/-70%"
 * - runner à très gros volume (playbook Djedje20x : "le runner du moment, Bid-Ask
 *   range -80%, énorme volume") → palier intermédiaire -80%.
 */
export function dipTargetForPool(pool: {
  pool_age_days: number;
  launchpad: string | null;
  volume_24h: number;
}): number {
  const recent = pool.pool_age_days < config.dipRiskyAgeDays;
  const isPumpFun = pool.launchpad === "pump.fun";
  if (recent || isPumpFun) return config.dipTargetRisky;
  // Runner : token établi mais volume massif → le crash peut être violent, mais
  // le token a une base → couverture intermédiaire -80%.
  if (pool.volume_24h >= config.runnerMinVolume24h) return config.dipTargetRunner;
  return config.dipTargetSafe;
}

/**
 * Nombre de bins pour couvrir un dump de `target` (0.9 = -90%) depuis le prix
 * actuel, selon le bin_step du pool : price = (1 + bin_step/10000)^binId →
 * bins = |ln(1−target) / ln(1 + bin_step/10000)|, borné par maxDipBins.
 */
export function binsForDumpTarget(target: number, binStep: number): number {
  if (!(target > 0 && target < 1)) return Math.round(config.maxDipBins / 2);
  const base = 1 + binStep / 10_000;
  const bins = Math.abs(Math.round(Math.log(1 - target) / Math.log(base)));
  return Math.max(1, Math.min(config.maxDipBins, bins));
}

/** Volatilité réalisée journalière (log-returns, écart-type × √24 pour 1h→24h). */
export function realizedVolatility(candles: OhlcvCandle[]): number {
  if (candles.length < 3) return 0.1;
  const closes = candles.map((c) => c.close).filter((c) => c > 0);
  if (closes.length < 3) return 0.1;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  const sigmaHourly = Math.sqrt(variance);
  // 1h → 24h (√24), plafonné pour éviter les absurdités
  return Math.min(2.0, sigmaHourly * Math.sqrt(24));
}

/**
 * Nombre de bins de chaque côté en fonction de la volatilité journalière.
 * Vol élevée → range large (survit aux mouvements), vol faible → range serré (plus de frais).
 */
export function binsPerSideForVolatility(volDaily: number, preset: StrategyPreset): number {
  const volPct = volDaily * 100;
  // mapping: vol 2% → serré, vol 30%+ → large
  const target = Math.round((volPct / 2.2) * 1.15);
  const lo = preset.minBinsPerSide;
  const hi = preset.maxBinsPerSide;
  return Math.max(lo, Math.min(hi, target));
}

/**
 * Drawdown du prix actuel vs high des 24 dernières heures (bougies 1h).
 * 0.3 = prix 30% sous le high — condition d'entrée "rebond après dump".
 */
export function drawdownFromHigh(candles: OhlcvCandle[], currentPrice: number): number {
  if (candles.length < 2 || !(currentPrice > 0)) return 0;
  const high24h = Math.max(...candles.map((c) => c.high).filter((h) => h > 0));
  if (!(high24h > 0)) return 0;
  return Math.max(0, Math.min(1, (high24h - currentPrice) / high24h));
}

/** Construit le hint de stratégie pour un pool donné (range autour du bin actif). */
export function buildStrategyHint(
  pool: Pick<Pool, "bin_step" | "pool_age_days" | "launchpad" | "volume_24h">,
  activeBinId: number,
  volDaily: number,
  strategyName = DEFAULT_STRATEGY
): StrategyHint {
  const preset = STRATEGY_PRESETS[strategyName] ?? STRATEGY_PRESETS[DEFAULT_STRATEGY];
  if (strategyName === "bidask-dip") {
    // Playbook LP Army (Tiagogo/VladimirKovacs) : maxBin = prix actuel, minBin =
    // jusqu'à -X% de dump où X dépend du profil du token (récent/pump.fun → -90%,
    // établi → -60/-70%). Le nombre de bins découle du bin_step du pool.
    const target = dipTargetForPool(pool);
    const bins = binsForDumpTarget(target, pool.bin_step);
    return {
      strategy: preset.name,
      minBinId: activeBinId - bins,
      maxBinId: activeBinId,
      binsPerSide: bins,
      vol_24h: volDaily,
      dipTarget: target,
    };
  }
  const perSide = binsPerSideForVolatility(volDaily, preset);
  return {
    strategy: preset.name,
    minBinId: activeBinId - perSide,
    maxBinId: activeBinId + perSide,
    binsPerSide: perSide,
    vol_24h: volDaily,
  };
}

/** Bin step en % (ex: 25 bp → 0.25). */
export function binStepPct(binStep: number): number {
  return binStep / 100;
}

/**
 * Bin id depuis un prix : price = (1 + bin_step/10000)^binId.
 * Même formule que le SDK (getBinIdFromPrice).
 */
export function binIdFromPrice(price: number, binStep: number): number {
  const base = 1 + binStep / 10_000;
  return Math.round(Math.log(price) / Math.log(base));
}
