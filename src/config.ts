import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function num(key: string, def: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}

function str(key: string, def: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === "" ? def : raw;
}

function bool(key: string, def: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return def;
  return raw.toLowerCase() === "true" || raw === "1";
}

export const config = {
  root: path.resolve(__dirname, ".."),
  dataDir: path.resolve(__dirname, "..", "data"),
  logDir: path.resolve(__dirname, "..", "logs"),

  // API DLMM (Data API officielle)
  dlmmApiBase: str("DLMM_API_BASE", "https://dlmm.datapi.meteora.ag"),
  rpcUrl: str("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),

  // Mode réel : STRICTEMENT désactivé par défaut.
  realMode: bool("REAL_MODE", false),
  realConfirm: str("REAL_CONFIRM", ""),
  walletPrivateKey: str("WALLET_PRIVATE_KEY", ""),

  // Scan / opportunités
  minTvl: num("MIN_TVL", 50_000),
  minVolume24h: num("MIN_VOLUME_24H", 10_000),
  minFeeTvlRatio24h: num("MIN_FEE_TVL_RATIO_24H", 0.02), // % (2 = 2%)
  minPoolAgeDays: num("MIN_POOL_AGE_DAYS", 1),
  maxVol24h: num("MAX_VOL_24H", 0.6), // σ journalière max (60 %/j) — protège les petits gains de l'IL
  scanTopPools: num("SCAN_TOP_POOLS", 150),
  apiRequestDelayMs: num("API_REQUEST_DELAY_MS", 120),
  apiMaxRetries: num("API_MAX_RETRIES", 3),

  // Stratégies / positions paper
  maxPositions: num("MAX_POSITIONS", 6),
  depositUsdPerPosition: num("DEPOSIT_USD_PER_POSITION", 1_000),
  rebalanceThreshold: num("REBALANCE_THRESHOLD", 0.45),
  hardStopDailyDrop: num("HARD_STOP_DAILY_DROP", 0.4),
  minClaimUsd: num("MIN_CLAIM_USD", 25),
  maxDailyDrop: num("MAX_DAILY_DROP", 0.4),

  // Couverture de dump typée (playbook Tiagogo/MeteoraFR) : le target dépend du
  // profil du token — shitcoin récent pump.fun → -90%, token établi → -60/-70%.
  dipTargetRisky: num("DIP_TARGET_RISKY", 0.9),
  dipTargetSafe: num("DIP_TARGET_SAFE", 0.65),
  dipTargetRunner: num("DIP_TARGET_RUNNER", 0.8),
  runnerMinVolume24h: num("RUNNER_MIN_VOLUME_24H", 500_000),
  dipRiskyAgeDays: num("DIP_RISKY_AGE_DAYS", 7),
  maxDipBins: num("MAX_DIP_BINS", 400),
  // Volume 24h min pour les pools bidask-dip (Tiagogo : "volume 24h > 1-2M
  // minimum" — l'échelle anti-dump compte sur les frais dynamiques des gros
  // volumes ; un pool à petit volume = capital immobilisé sans frais).
  minVolume24hBidask: num("MIN_VOLUME_24H_BIDASK", 250_000),
  // Entrée sur rebond : n'ouvrir une échelle bidask-dip que si le prix est déjà
  // ≥ ce drawdown sous son high 24h ("rentrer sur les rebonds après gros dumps").
  minDipDrawdown: num("MIN_DIP_DRAWDOWN", 0.3),
  // Diversification : max 1 position par token (les 3× ANSEM-SOL étaient 3 pools
  // du même token — risque corrélé zap-out, contre le playbook 6-7 positions).
  maxPositionsPerToken: num("MAX_POSITIONS_PER_TOKEN", 1),
  // DCA quotidien (playbook Djedje20x) : ajout périodique de quote (SOL) aux
  // positions bidask-dip ouvertes — l'échelle grossit, les fees aussi.
  dcaEnabled: bool("DCA_ENABLED", false),
  dcaDailyUsd: num("DCA_DAILY_USD", 100),
  dcaHourUtc: num("DCA_HOUR_UTC", 7),

  // Exit Bollinger (Tiagogo : cassure de la Bollinger haute en 15 min → sortie).
  // Bougies 15 min construites depuis les marks du bot (monitor 15 min).
  bollingerExitEnabled: bool("BOLLINGER_EXIT_ENABLED", true),
  bollingerPeriod: num("BOLLINGER_PERIOD", 20),
  bollingerStd: num("BOLLINGER_STD", 2),
  bollingerMinSamples: num("BOLLINGER_MIN_SAMPLES", 20),

  // Playbook quick in & out (Tikz1070, MeteoraFR) : entrée = spike de volume
  // ≥ 30K$/min (≈ 900K$/30min) sur un pool RÉCENT (nouveau pool = edge, détection
  // tôt) à frais élevés, position SERRÉE, sortie rapide (spike essoufflé ou
  // OOR → pull, style salarycat). Les pools candidats passent les filtres
  // d'âge/TVL/volatilité — la porte d'entrée EST le spike 30m.
  quickMinVolume30m: num("QUICK_MIN_VOLUME_30M", 900_000), // 30K$/min × 30 min
  quickMaxPoolAgeDays: num("QUICK_MAX_POOL_AGE_DAYS", 2), // « nouveau pool »
  quickMinFeeTvlRatio30m: num("QUICK_MIN_FEE_TVL_30M", 0.02), // % fees/TVL sur 30m (frais qui tournent)
  quickVolumeFadeFactor: num("QUICK_VOLUME_FADE_FACTOR", 0.5), // sortie si vol 30m < 50% du seuil

  // Playbook fee printers (0xmiir, 2026-08-16) : les meilleurs encaisseurs de
  // frais du marché (ANSEM/MANLET/TOAD/CATE) font 0.5-2.5% de fees/TVL 24h avec
  // une volatilité extrême — le plafond σ (60%/j, antérieur au playbook
  // bidask-dip) les EXCLUAIT du scan. Un pool à gros volume + gros ratio de
  // frais passe le plafond : l'échelle anti-dump + le filtre drawdown ≥ 30%
  // (entrée sur rebond) sont les protections.
  minFeeTvlFeePrinter: num("MIN_FEE_TVL_FEEPRINTER", 0.5), // % fees/TVL 24h min
  watchlistTokens: str("WATCHLIST_TOKENS", "ANSEM,MANLET,TOAD,CATE"), // watchlist 0xmiir
  migrationMinVolume24h: num("MIGRATION_MIN_VOLUME_24H", 5_000_000), // « 5M+ volume sur le DLMM » (0xmiir)

  // Apprentissage (outcome reviews + tuner)
  tuneMinSamples: num("TUNE_MIN_SAMPLES", 10),
  tuneMinHoursBetween: num("TUNE_MIN_HOURS_BETWEEN", 24),
  weeklyReviewDays: num("WEEKLY_REVIEW_DAYS", 7),

  // Dashboard
  dashboardPort: num("DASHBOARD_PORT", 4001),
  dashboardLive: bool("DASHBOARD_LIVE", true),
  dashboardHost: str("DASHBOARD_HOST", "0.0.0.0"),

  // Intervalle monitor (minutes)
  monitorIntervalMin: num("MONITOR_INTERVAL_MIN", 15),
};

/** Garde d'exécution : interdit tout passage en réel sauf config explicite. */
export function assertPaperOnly(action: string): void {
  if (!config.realMode || config.realConfirm !== "CONFIRMED-REAL-MODE") {
    throw new Error(
      `[EXECUTION GUARD] ${action} est BLOQUÉ : mode réel non confirmé. ` +
        `Le bot est PAPER ONLY. Pour activer le réel (DÉCONSEILLÉ en prod sans revue), ` +
        `il faut REAL_MODE=true ET REAL_CONFIRM=CONFIRMED-REAL-MODE dans .env.`
    );
  }
}
