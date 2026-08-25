// Types partagés du bot DLMM.

export interface PoolToken {
  address: string;
  name: string;
  symbol: string;
  decimals?: number;
}

export interface PoolMetrics {
  tvl: number;
  volume_24h: number;
  volume_1h: number;
  volume_30m: number;
  fee_tvl_ratio_24h: number; // en POURCENTAGE (2.5 = 2.5% de frais/TVL sur 24h)
  fee_tvl_ratio_1h: number;
  fee_tvl_ratio_30m: number;
  fees_24h: number;
  fees_1h: number;
  fees_30m: number;
  fee_apr_24h: number; // annualisé, dérivé
  farm_apr: number;
  current_price: number;
  bin_step: number;
  base_fee_pct: number;
  dynamic_fee_pct: number;
  protocol_fee_pct: number;
  launchpad: string | null;
  is_blacklisted: boolean;
  created_at: number | null;
  pool_age_days: number;
}

export interface Pool extends PoolMetrics {
  address: string;
  name: string;
  token_x: PoolToken;
  token_y: PoolToken;
  token_x_amount: number;
  token_y_amount: number;
}

export interface OhlcvCandle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type StrategyName =
  | "spot-concentrated"
  | "spot-spread"
  | "spot-wide"
  | "curve"
  | "bidask"
  | "bidask-dip"
  | "bidask-flip" // état post-flip d'une bidask-dip (distribution au-dessus du prix)
  | "topblast" // spike single-sided SOL (satsmonkes setup 1, ex-quick-inout Tikz)
  | "resurrect"; // vieux token en spike (Nowload 2026-08-25 — SPOT SOL large, sortie sur refroidissement)

export interface StrategyPreset {
  name: StrategyName;
  minBinsPerSide: number;
  maxBinsPerSide: number;
  sdkStrategy: "Spot" | "Curve" | "BidAsk";
  oneSided: "none" | "x" | "y";
  description: string;
}

export interface StrategyHint {
  strategy: StrategyName;
  minBinId: number;
  maxBinId: number;
  binsPerSide: number;
  vol_24h: number; // volatilité réalisée journalière (0.12 = 12%)
  dipTarget?: number; // couverture de dump cible pour bidask-dip (0.9 = -90%)
  drawdown24h?: number; // drawdown vs high 24h à l'entrée (0.35 = -35% sous le high)
  // Ancre Fibonacci (playbook satsmonkes, setup 2) : swing ATH→low et niveaux
  // 0.5/0.786 utilisés pour placer la range bidask-dip par structure.
  fibZone?: { high: number; low: number; level50: number; level786: number };
}

export interface OpportunityScore {
  pool: Pool;
  vol_24h: number;
  score: number;
  signals: string[];
  strategyHint: StrategyHint;
}

export interface PaperPositionRow {
  id: number;
  opened_at: number;
  pool_address: string;
  name: string;
  strategy: StrategyName;
  deposit_usd: number;
  min_bin_id: number;
  max_bin_id: number;
  bin_step: number;
  entry_price: number;
  entry_active_bin: number;
  token_x_symbol: string;
  token_y_symbol: string;
  amount_x: number;
  amount_y: number;
  fees_earned_usd: number;
  fees_claimed_usd: number;
  status: "open" | "closed";
  closed_at: number | null;
  close_reason: string | null;
  last_mark_price: number;
  last_value_usd: number;
  last_il_usd: number;
  rebalance_count: number;
  day_start_price: number;
  last_mark_at: number;
}

export interface MarkResult {
  price: number;
  value_usd: number;
  fees_usd: number;
  il_usd: number;
  net_pnl_usd: number;
  in_range: boolean;
}
