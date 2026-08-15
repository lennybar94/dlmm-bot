// Stratégies DLMM : presets de forme de liquidité + dimensionnement par volatilité.
// Inspiré des shapes officielles (Spot/Curve/BidAsk) et du bot meteora_meme
// (volatilité → span), et du recentrage à la MeteorShower.

import type { OhlcvCandle, StrategyHint, StrategyPreset } from "./types.js";

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
};

export const DEFAULT_STRATEGY = "spot-spread";

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

/** Construit le hint de stratégie pour un pool donné (range autour du bin actif). */
export function buildStrategyHint(
  poolAddress: string,
  activeBinId: number,
  volDaily: number,
  strategyName = DEFAULT_STRATEGY
): StrategyHint {
  const preset = STRATEGY_PRESETS[strategyName] ?? STRATEGY_PRESETS[DEFAULT_STRATEGY];
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
