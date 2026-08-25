// Client de la DLMM Data API officielle (https://dlmm.datapi.meteora.ag).
// Rate limit : 30 RPS → petit délai entre requêtes + retry.

import { config } from "./config.js";
import type { OhlcvCandle, Pool } from "./types.js";

async function get<T>(path: string, params: Record<string, string | number> = {}): Promise<T> {
  const url = new URL(config.dlmmApiBase + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= config.apiMaxRetries; attempt++) {
    try {
      const res = await fetch(url, { headers: { accept: "application/json" } });
      if (res.status === 429 || res.status >= 500) {
        throw new Error(`HTTP ${res.status}`);
      }
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} sur ${path}`);
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr ?? new Error(`échec GET ${path}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function numOr(v: unknown, def = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

export interface PoolsResponse {
  total: number;
  pages: number;
  current_page: number;
  page_size: number;
  data: RawPool[];
}

export interface RawPool {
  address: string;
  name: string;
  tvl?: number;
  current_price?: number;
  created_at?: number;
  is_blacklisted?: boolean;
  launchpad?: string | null;
  apr?: number;
  apy?: number;
  farm_apr?: number;
  farm_apy?: number;
  dynamic_fee_pct?: number;
  pool_config?: {
    bin_step?: number;
    base_fee_pct?: number;
    protocol_fee_pct?: number;
  };
  fee_tvl_ratio?: Record<string, number>;
  fees?: Record<string, number>;
  volume?: Record<string, number>;
  token_x?: { address?: string; name?: string; symbol?: string; decimals?: number };
  token_y?: { address?: string; name?: string; symbol?: string; decimals?: number };
  token_x_amount?: number;
  token_y_amount?: number;
  [k: string]: unknown;
}

export function normalizePool(raw: RawPool): Pool {
  const cfg = raw.pool_config ?? {};
  const feeTvlRatio24h = numOr(raw.fee_tvl_ratio?.["24h"]);
  const feeTvlRatio1h = numOr(raw.fee_tvl_ratio?.["1h"]);
  const feeTvlRatio30m = numOr(raw.fee_tvl_ratio?.["30m"]);
  const volume24h = numOr(raw.volume?.["24h"]);
  const volume1h = numOr(raw.volume?.["1h"]);
  const volume30m = numOr(raw.volume?.["30m"]);
  const fees24h = numOr(raw.fees?.["24h"]);
  const fees1h = numOr(raw.fees?.["1h"]);
  const fees30m = numOr(raw.fees?.["30m"]);
  const protocolFeePct = numOr(cfg.protocol_fee_pct, 10);
  // fee_tvl_ratio est en POURCENTAGE (2.5 = 2.5%) → APR = ratio/100 × 365
  const feeApr24h =
    (feeTvlRatio24h / 100) * 365 * (1 - protocolFeePct / 100);
  const created = raw.created_at ? Number(raw.created_at) : null;
  const poolAgeDays = created ? (Date.now() - created) / 86_400_000 : 0;

  return {
    address: raw.address,
    name: raw.name ?? `${raw.token_x?.symbol ?? "X"}-${raw.token_y?.symbol ?? "Y"}`,
    tvl: numOr(raw.tvl),
    volume_24h: volume24h,
    volume_1h: volume1h,
    volume_30m: volume30m,
    fee_tvl_ratio_24h: feeTvlRatio24h,
    fee_tvl_ratio_1h: feeTvlRatio1h,
    fee_tvl_ratio_30m: feeTvlRatio30m,
    fees_24h: fees24h,
    fees_1h: fees1h,
    fees_30m: fees30m,
    fee_apr_24h: feeApr24h,
    farm_apr: numOr(raw.farm_apr),
    current_price: numOr(raw.current_price),
    bin_step: numOr(cfg.bin_step, 10),
    base_fee_pct: numOr(cfg.base_fee_pct),
    dynamic_fee_pct: numOr(raw.dynamic_fee_pct),
    protocol_fee_pct: protocolFeePct,
    launchpad: raw.launchpad ?? null,
    is_blacklisted: Boolean(raw.is_blacklisted),
    created_at: created,
    pool_age_days: poolAgeDays,
    token_x: {
      address: raw.token_x?.address ?? "",
      name: raw.token_x?.name ?? "",
      symbol: raw.token_x?.symbol ?? "X",
      decimals: raw.token_x?.decimals,
    },
    token_y: {
      address: raw.token_y?.address ?? "",
      name: raw.token_y?.name ?? "",
      symbol: raw.token_y?.symbol ?? "Y",
      decimals: raw.token_y?.decimals,
    },
    token_x_amount: numOr(raw.token_x_amount),
    token_y_amount: numOr(raw.token_y_amount),
  };
}

/** Pools paginés, triés par volume 24h desc par défaut. */
export async function fetchPools(opts: {
  pageSize?: number;
  sortBy?: string;
  page?: number;
}): Promise<Pool[]> {
  const { pageSize = 100, sortBy = "volume_24h:desc", page = 1 } = opts;
  const res = await get<PoolsResponse>("/pools", {
    page,
    page_size: pageSize,
    sort_by: sortBy,
  });
  return (res.data ?? []).map(normalizePool);
}

/**
 * Pools les plus RÉCENTES (tri par date de création — RocketScan 2026-08-23 :
 * « chasser le pool NEUF qui chauffe immédiatement », tri par date de création
 * + >50k$/5min). Un pool < 24 h avec un vrai volume 30m n'apparaît pas dans le
 * top 150 par volume 24h → appel dédié aux plus jeunes (1 requête/scan).
 * Champ de tri vérifié en live : `pool_created_at` (pas `created_at`).
 * Échec → radar silencieusement désactivé ce scan (jamais bloquant).
 */
export async function fetchNewestPools(topN = 100): Promise<Pool[]> {
  try {
    return await fetchPools({ pageSize: topN, sortBy: "pool_created_at:desc" });
  } catch (err) {
    console.warn(`[api] fetchNewestPools échoué (radar pool neuve désactivé ce scan) : ${String(err)}`);
    return [];
  }
}

/** État courant d'un pool. */
export async function fetchPool(address: string): Promise<Pool> {
  const raw = await get<RawPool>(`/pools/${address}`);
  return normalizePool(raw);
}

/**
 * Bougies OHLCV pour estimer la volatilité réalisée.
 * ⚠️ RÉALITÉ API (vérifié 2026-08-25) : l'endpoint IGNORE `interval`/`from`/`to`
 * et renvoie TOUJOURS 10 bougies DAILY (champ `timestamp`, pas `time`), peu
 * importe la fenêtre demandée → RSI/Supertrend/vol sont calculés sur ~10 jours,
 * pas en intraday. Normalisation : `timestamp` → `time` (le tri par `a.time`
 * comparaît des undefined → NaN → ordre non garanti avant ce fix).
 */
export async function fetchOhlcv(address: string, hours = 24): Promise<OhlcvCandle[]> {
  const now = Math.floor(Date.now() / 1000);
  const from = now - hours * 3600;
  const res = await get<{ data?: OhlcvCandle[]; candles?: OhlcvCandle[] }>(
    `/pools/${address}/ohlcv`,
    { interval: "1h", from, to: now }
  );
  const candles = (res.data ?? res.candles ?? []).map((c) => ({
    time: (c as unknown as { timestamp?: number }).timestamp ?? (c.time ?? 0),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }));
  return candles.sort((a, b) => a.time - b.time);
}

/** Scan multi-pages : top N pools par volume 24h. */
export async function fetchTopPools(topN: number): Promise<Pool[]> {
  const out: Pool[] = [];
  const pageSize = Math.min(200, Math.max(100, topN));
  const pages = Math.ceil(topN / pageSize);
  for (let page = 1; page <= pages; page++) {
    out.push(...(await fetchPools({ pageSize, page, sortBy: "volume_24h:desc" })));
    await sleep(config.apiRequestDelayMs);
  }
  return out.slice(0, topN);
}
