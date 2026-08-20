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
  // Playbook satsmonkes (setup 1 — top blast) : LA stratégie spike du bot,
  // single-sided SOL, range 10-15 bins au total (5-8/côté). « Tu es présent
  // pendant la première jambe haussière d'un memecoin sur du vrai volume, tu
  // joues la volatilité extrême du top avec un range serré pour capter le max
  // de fees en quelques minutes ». SOL-only → pas d'IL, l'expo SOL est
  // conservée (l'upside reste le SOL). Absorbe l'ancien quick-inout (Tikz :
  // « fast in and fast out », sortie rapide spike essoufflé / OOR → pull).
  "topblast": {
    name: "topblast",
    minBinsPerSide: 5,
    maxBinsPerSide: 7,
    sdkStrategy: "Spot",
    oneSided: "y",
    description: "Spot SOL-only 10-15 bins — top blast (satsmonkes, ex-quick-inout Tikz) : première jambe haussière sur spike, fees en quelques minutes.",
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
 * Candidat « top blast » (playbook satsmonkes, setup 1 — ex-quick-inout Tikz) :
 * spike de volume 30 min ≥ 30K$/min sur un pool RÉCENT à frais qui tournent.
 * C'est la porte d'entrée unique du playbook spike (le pool jeune en spike =
 * la première jambe haussière). Shape : single-sided SOL, 10-15 bins.
 */
export function isTopBlastCandidate(p: {
  volume_30m: number;
  pool_age_days: number;
  fee_tvl_ratio_30m: number;
}): boolean {
  return isQuickInOutCandidate(p);
}

/**
 * Dépôt par classe de pool (playbook satsmonkes — « la taille de la position
 * est inverse à la volatilité et inverse au gap de conviction ») :
 * - majors (gros TVL + gros volume 24h) → gros dépôt
 * - exploratoire (pool jeune ou launchpad pump.fun) → petit dépôt (tuition)
 * - le reste (token établi) → dépôt de conviction intermédiaire
 * Désactivé (SATS_SIZING_ENABLED=false) → dépôt fixe DEPOSIT_USD_PER_POSITION.
 */
export function depositForPool(pool: {
  pool_age_days: number;
  launchpad: string | null;
  tvl: number;
  volume_24h: number;
}): number {
  if (!config.satsSizingEnabled) return config.depositUsdPerPosition;
  if (pool.tvl >= config.satsMajorMinTvl && pool.volume_24h >= config.satsMajorMinVolume24h)
    return config.satsSizeMajorUsd;
  if (pool.pool_age_days < config.satsExploratoryMaxAgeDays || pool.launchpad === "pump.fun")
    return config.satsSizeExploratoryUsd;
  return config.satsSizeConvictionUsd;
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

/**
 * Swing (ATH → low majeur) et niveaux du retracement de Fibonacci
 * (playbook satsmonkes, setup 2). fib(level) = high − level × (high − low) :
 * 0.382, 0.5, 0.618, 0.786 — « la majorité du marché place ses ordres sur ces
 * retraces, c'est là que le prix réagit ». La zone que satsmonkes joue :
 * 0.5 → 0.786 (« pas le wick le plus profond, pas le bounce le plus faible,
 * le sweet spot où la majorité des buyers ré-entrent »).
 */
export interface FibSwing {
  high: number;
  low: number;
  level50: number;
  level786: number;
}

export function fibSwingFromCandles(candles: OhlcvCandle[]): FibSwing | null {
  const highs = candles.map((c) => c.high).filter((h) => h > 0);
  const lows = candles.map((c) => c.low).filter((l) => l > 0);
  if (highs.length < 2 || lows.length < 2) return null;
  const high = Math.max(...highs);
  const low = Math.min(...lows);
  // Swing invalide : pas d'amplitude → token sans structure, on garde le
  // dipTarget classique plutôt qu'une ancre fantaisiste.
  if (!(high > low) || high / low - 1 < config.satsFibMinSwing) return null;
  const span = high - low;
  return {
    high,
    low,
    level50: high - 0.5 * span,
    level786: high - 0.786 * span,
  };
}

/** Niveau de retracement courant du prix (0 = ATH du swing, 1 = low). */
export function fibRetraceLevel(fib: FibSwing, price: number): number {
  const span = fib.high - fib.low;
  if (!(span > 0) || !(price > 0)) return 0;
  return (fib.high - price) / span;
}

/** Le prix est dans la zone 0.5-0.786 du retracement (sweet spot satsmonkes). */
export function inSatsFibZone(
  fib: FibSwing,
  price: number,
  lo = config.satsFibZoneLo,
  hi = config.satsFibZoneHi
): boolean {
  const lvl = fibRetraceLevel(fib, price);
  return lvl >= lo && lvl <= hi;
}

/** Construit le hint de stratégie pour un pool donné (range autour du bin actif). */
export function buildStrategyHint(
  pool: Pick<Pool, "bin_step" | "pool_age_days" | "launchpad" | "volume_24h">,
  activeBinId: number,
  volDaily: number,
  strategyName = DEFAULT_STRATEGY,
  currentPrice?: number,
  candles: OhlcvCandle[] = []
): StrategyHint {
  const preset = STRATEGY_PRESETS[strategyName] ?? STRATEGY_PRESETS[DEFAULT_STRATEGY];
  if (strategyName === "bidask-dip") {
    // Playbook satsmonkes (setup 2) : ancre structurelle Fibonacci si le swing
    // est valide — maxBin = min(prix actuel, fib 0.5), minBin = fib 0.786.
    // On déploie à travers la zone où le marché réagit, pas sur un % de dump
    // présupposé. Fallback sur dipTargetForPool si le prix a déjà traversé la
    // zone (minBin ≥ maxBin) ou si le swing est trop petit.
    if (config.satsFibEnabled && currentPrice && currentPrice > 0) {
      const fib = fibSwingFromCandles(candles);
      if (fib) {
        const maxPrice = Math.min(currentPrice, fib.level50);
        const minPrice = fib.level786;
        const maxBin = binIdFromPrice(maxPrice, pool.bin_step);
        const minBin = binIdFromPrice(minPrice, pool.bin_step);
        if (minBin < maxBin) {
          return {
            strategy: preset.name,
            minBinId: minBin,
            maxBinId: maxBin,
            binsPerSide: Math.round((maxBin - minBin) / 2),
            vol_24h: volDaily,
            dipTarget: 1 - minPrice / currentPrice, // profondeur effective sous le prix
            fibZone: { high: fib.high, low: fib.low, level50: fib.level50, level786: fib.level786 },
          };
        }
      }
    }
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
