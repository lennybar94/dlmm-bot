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
  // Miroir réel de DLMM Claude : même structure de range que bidask-dip
  // ([actif − n, actif], SOL seul) mais forme Spot uniforme. La largeur vient
  // du plan Claude (≤ 69 bins), pas du preset ; montants passés en override.
  "sol-ladder-spot": {
    name: "sol-ladder-spot",
    minBinsPerSide: 4,
    maxBinsPerSide: 69,
    sdkStrategy: "Spot",
    oneSided: "y",
    description: "Spot SOL-only du bin actif vers le bas — plan DLMM Claude exécuté par le miroir réel.",
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
  // ♻️ Résurrection (Nowload 2026-08-25 — « LP sniping » ; complète HALO) :
  // vieux token (> 2 j, hors fenêtre topblast) qui se réveille — spike de
  // volume SANS drawdown ≥ 30 % (le prix n'est pas dans un dump : la porte
  // bidask-dip ne s'applique pas). Le post : SPOT one-side SOL « classic
  // range ~70 bins » (≈ notre max on-chain 69) — la liquidité est répartie
  // dans toute la range, on encaisse les fees tant que le volume tient, et
  // on sort quand le momentum refroidit (« we disappear the moment the
  // opportunity fades »). Largeur pilotée par la volatilité (20-34 bins/côté
  // = 40-69 bins au total, clamp on-chain 69 dans real.ts).
  "resurrect": {
    name: "resurrect",
    minBinsPerSide: 20,
    maxBinsPerSide: 34,
    sdkStrategy: "Spot",
    oneSided: "y",
    description: "Spot SOL-only 40-69 bins — résurrection (Nowload) : vieux token en spike de volume, fees tant que le momentum tient, sortie sur refroidissement.",
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
 * Candidat « résurrection » (Nowload 2026-08-25 — LP sniping ; complète HALO) :
 * vieux token (> QUICK_MAX_POOL_AGE_DAYS, hors fenêtre topblast) qui se
 * réveille — spike de volume 30m + frais qui tournent, SANS drawdown ≥ 30 %
 * (le prix n'est pas dans un dump : la porte bidask-dip ne s'applique pas).
 * Le post : « an old forgotten token suddenly rising from the dead » /
 * « a narrative unexpectedly regaining CT's attention ». RADAR uniquement
 * (score 0 → jamais ouvert en auto — rollout shadow→pilot→scale).
 */
export function isResurrectionCandidate(p: {
  pool_age_days: number;
  volume_30m: number;
  fee_tvl_ratio_30m: number;
}): boolean {
  return (
    p.pool_age_days > config.quickMaxPoolAgeDays &&
    p.volume_30m >= config.resurrectionMinVol30m &&
    p.fee_tvl_ratio_30m >= config.quickMinFeeTvlRatio30m
  );
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

/** Volatilité réalisée journalière. ⚠️ Fix 25/10 (NOTES-20261025 §2-1) : l'OHLCV Data API
 * ne renvoie que 10 bougies DAILY (interval ignoré, vérifié 25/08 — cf. commentaire du RSI).
 * L'ancien code les traitait en horaires et multipliait par √24 → σ surestimé ×4,9. Les
 * bougies étant déjà daily, l'écart-type des log-returns est DIRECTEMENT le σ journalier ;
 * le √24 est supprimé. Réglages calibrés sur le σ gonflé divisés d'autant (MAX_VOL_24H
 * 0,6→0,12, seuils strategyForVolatility, mapping binsPerSide ×√24) — comportement
 * identique, valeurs honnêtes. */
const SIGMA_FALLBACK = 0.1 / Math.sqrt(24); // = 0,1 de l'ANCIENNE échelle (σ gonflé ×√24)

export function realizedVolatility(candles: OhlcvCandle[]): number {
  // ⚠️ Le repli « pas assez de bougies » valait 0,1 sur l'échelle GONFLÉE → il doit être
  // converti comme tout le reste, sinon un pool sans OHLCV bascule de bande : 0,1 reste
  // au-dessus du seuil mid/high (0,3/√24 ≈ 0,061) et le fait classer « high » alors qu'il
  // l'était « mid » avant. Trouvé par le test d'équivalence main↔branche (DacityCoin-SOL).
  if (candles.length < 3) return SIGMA_FALLBACK;
  const closes = candles.map((c) => c.close).filter((c) => c > 0);
  if (closes.length < 3) return SIGMA_FALLBACK;
  const returns: number[] = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(Math.log(closes[i] / closes[i - 1]));
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, returns.length - 1);
  // bougies DAILY → écart-type = σ journalière directe (plafond converti : 2,0/√24 ≈ 0,41)
  return Math.min(2.0 / Math.sqrt(24), Math.sqrt(variance));
}

/**
 * RSI (Relative Strength Index — lissage Wilder) sur les closes des bougies.
 * Période par défaut 7 : l'OHLCV Data API ne renvoie que 10 bougies DAILY
 * (l'interval est ignoré, vérifié 2026-08-25) → 14 exigerait 15 bougies et ne
 * calculerait jamais. Ajout 2026-08-25 (LP Army academy) : indicateur de
 * MOMENTUM, pas de direction — à croiser, jamais seul (règle du tuto «
 * n'attendez pas qu'une seule info »). Usage : signal INFO au scan, aucune
 * décision d'exit (leçon Bollinger 2026-08-18). Retourne null si échantillon
 * insuffisant.
 */
export function rsi(candles: OhlcvCandle[], period = 7): number | null {
  const closes = candles.map((c) => c.close).filter((c) => c > 0);
  if (closes.length < period + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) avgGain += diff;
    else avgLoss -= diff;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/**
 * Analyse de TENDANCE (L4-A, 2026-08-29 — pivot pur : détenir des actifs en
 * tendance au lieu de memes mourants). Calculée sur les MÊMES bougies daily
 * déjà fetchées (0 requête API). Trois signaux du rapport L4-A :
 *   drift24h  = close d'aujourd'hui vs close de la veille (bougies DAILY)
 *   rsiRising = RSI(7) actuel > RSI(7) de la veille (momentum qui tourne)
 *   priceAboveSma = close > SMA(7) des closes
 * ⚠️ downTrend = les TROIS négatifs ensemble (tendance baissière CONFIRMÉE =
 * profil de dump mortel −50/−68 %). Volontairement STRICT : un token qui
 * rebondit après un dump (le playbook bidask-dip) a au moins un signal
 * positif et ne doit PAS être bloqué — contrainte David 29/08 : ne pas
 * sacrifier la collecte des fees (les entrées bidask-dip SONT des rebonds).
 * Retourne des nulls si échantillon insuffisant (pool neuf < ~2 j).
 */
export interface TrendAnalysis {
  drift24h: number | null;
  rsiNow: number | null;
  rsiPrev: number | null;
  rsiRising: boolean;
  sma7: number | null;
  priceAboveSma: boolean | null;
  downTrend: boolean;
}

export function analyzeTrend(candles: OhlcvCandle[]): TrendAnalysis {
  const closes = candles.map((c) => c.close).filter((c) => c > 0);
  const last = closes[closes.length - 1];
  const drift24h =
    closes.length >= 3 && closes[closes.length - 2] > 0
      ? last / closes[closes.length - 2] - 1
      : null;
  const rsiNow = rsi(candles);
  const rsiPrev = candles.length >= 2 ? rsi(candles.slice(0, -1)) : null;
  const rsiRising = rsiNow !== null && rsiPrev !== null && rsiNow > rsiPrev;
  const sma7 = closes.length >= 7 ? closes.slice(-7).reduce((a, b) => a + b, 0) / 7 : null;
  const priceAboveSma = sma7 !== null && sma7 > 0 ? last > sma7 : null;
  const downTrend =
    drift24h !== null &&
    drift24h < 0 &&
    rsiNow !== null &&
    rsiPrev !== null &&
    rsiNow < rsiPrev &&
    priceAboveSma === false;
  return { drift24h, rsiNow, rsiPrev, rsiRising, sma7, priceAboveSma, downTrend };
}

/**
 * Supertrend (ATR, multiplier 3 — réglages Evil Panda/LogicalTA) sur les
 * bougies. Période par défaut 7 : l'OHLCV Data API ne renvoie que 10 bougies
 * DAILY (l'interval est ignoré, vérifié 2026-08-25). Retourne
 * { trend: 1 haussier | -1 baissier, price } ou null si échantillon
 * insuffisant. Ajout 2026-08-25 (LP Army academy) : signal INFO au scan —
 * « en dessous de la supertrend = baissier, au-dessus = haussier » ; jamais un
 * exit autonome (leçon Bollinger 2026-08-18).
 */
export function supertrend(
  candles: OhlcvCandle[],
  period = 7,
  multiplier = 3
): { trend: 1 | -1; price: number } | null {
  if (candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    const pc = candles[i - 1];
    const tr = Math.max(
      c.high - c.low,
      Math.abs(c.high - pc.close),
      Math.abs(c.low - pc.close)
    );
    trs.push(tr);
  }
  // ATR Wilder
  const atr: number[] = [];
  const seed = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  atr.push(seed);
  for (let i = period; i < trs.length; i++) {
    atr.push((atr[atr.length - 1] * (period - 1) + trs[i]) / period);
  }
  // Supertrend standard (implémentation de référence : TradingView/Pine).
  // ⚠️ BUG corrigé 2026-08-25 : le flip compare le close à la bande finale de
  // la barre PRÉCÉDENTE (finalLower[1]/finalUpper[1]) — pas à celle de la barre
  // courante (elle vient d'être réinitialisée au même instant → le close est
  // presque toujours au-dessus → trend bloqué haussier, même en baisse franche).
  let upTrend = true;
  let prevUpper = 0;
  let prevLower = 0;
  let prevFinalLower = 0;
  let prevFinalUpper = 0;
  let finalUpper = 0;
  let finalLower = 0;
  let final = 0;
  for (let i = 0; i < atr.length; i++) {
    const c = candles[i + 1];
    const mid = (c.high + c.low) / 2;
    const upper = mid + multiplier * atr[i];
    const lower = mid - multiplier * atr[i];
    finalUpper = upper < prevUpper || c.close > prevUpper ? upper : prevUpper;
    finalLower = lower > prevLower || c.close < prevLower ? lower : prevLower;
    if (i === 0) {
      upTrend = true;
    } else if (!upTrend) {
      // Était baissier → redevient haussier si le close casse la bande sup PRÉCÉDENTE
      upTrend = c.close > prevFinalUpper;
    } else {
      // Était haussier → devient baissier si le close casse la bande inf PRÉCÉDENTE
      upTrend = c.close >= prevFinalLower;
    }
    final = upTrend ? finalLower : finalUpper;
    prevUpper = finalUpper;
    prevLower = finalLower;
    prevFinalUpper = finalUpper;
    prevFinalLower = finalLower;
  }
  return { trend: upTrend ? 1 : -1, price: final };
}

/**
 * Nombre de bins de chaque côté en fonction de la volatilité journalière.
 * Vol élevée → range large (survit aux mouvements), vol faible → range serré (plus de frais).
 */
export function binsPerSideForVolatility(volDaily: number, preset: StrategyPreset): number {
  // Fix 25/10 : mapping ×√24 — le σ est désormais daily direct ; le calibrage d'origine
  // (« vol 2 % → serré ») supposait le σ gonflé ×√24 du bug. Comportement identique.
  const volPct = volDaily * 100 * Math.sqrt(24);
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
  // ⚠️ FLOOR (pas ROUND) — leçon lab 04/10 : round place le prix AU-DESSUS du
  // bin quand la fraction ≥ 0,5 → une bidask-dip ancrée maxBin=active « couvre »
  // un prix déjà sorti de son range haut (entry > pb par flottants inclus).
  // Le floor garantit price ≤ pb : le dépôt Y est intégralement projeté dans le
  // range (valueY@entry = dépôt exact), et le mark garde sa sémantique OOR.
  return Math.floor(Math.log(price) / Math.log(base));
}
