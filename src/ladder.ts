// Manche ladder (portage Claude en RÉEL) — noyau partagé par les scripts.
// Cahier des charges David 16/10 (docs/PR-REAL-LADDER.md). Ce fichier ne contient
// AUCUNE règle de politique : tout verdict vient de claudePolicy (vendor dlmm-claude).

import { createRequire } from "node:module";
import { db } from "./db.js";
import { config, labMode } from "./config.js";
import { memesBookPaused } from "./book-pause.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Connection, Keypair } = require("@solana/web3.js") as any;

// ---------------------------------------------------------------------------
// Plafonds EN DUR — cahier des charges David 16/10. Volontairement non lisibles
// depuis .env : une montée en taille est une décision séparée, pas un réglage.
// ---------------------------------------------------------------------------
export const LADDER_CAP_SOL = 5; // capital max déployé par la manche ladder
export const LADDER_MAX_POSITIONS = 1; // une position à la fois au début
export const LADDER_MIN_ENTRY_SOL = 0.1; // garde de déploiement (même seuil que le paper P4)

/** Les trois verrous d'activation. Renvoie le motif d'inactivité, ou null si actif. */
export function ladderGate(confirmFlag?: string): string | null {
  if (!config.realLadder) return "REAL_LADDER=false — manche ladder désactivée par défaut";
  if (labMode) return "labMode — le ladder réel ne tourne jamais dans le lab";
  const pause = memesBookPaused();
  if (pause.paused) return `book réel en pause (${pause.note}) — lever la pause est une décision explicite de David, pas un flag`;
  if (confirmFlag && !process.argv.includes(confirmFlag)) return `manquant ${confirmFlag} (dry-run par défaut)`;
  return null;
}

// ---------------------------------------------------------------------------
// Vendor dlmm-claude (submodule git → src/vendor/dlmm-claude). Politique UNIQUE.
// ---------------------------------------------------------------------------
const CLAUDE_SRC = new URL("../src/vendor/dlmm-claude/src/", import.meta.url).href;

export async function loadClaude() {
  const [{ claudePolicy }, { DEFAULT_LEVERS }, { sigmaDaily }, { composition }] = await Promise.all([
    import(`${CLAUDE_SRC}policy.ts`),
    import(`${CLAUDE_SRC}config.ts`),
    import(`${CLAUDE_SRC}features.ts`),
    import(`${CLAUDE_SRC}dlmm.ts`),
  ]);
  return { claudePolicy, DEFAULT_LEVERS, sigmaDaily, composition };
}

// ---------------------------------------------------------------------------
// Mapping Pool (Data API dlmm-bot) → Market/features (conventions claude).
// Traduction seule : aucune décision ici.
//   - fee_tvl_ratio_24h est EN POURCENTAGE côté api.ts → fraction /100.
//   - f.feeTvl1h est « PAR JOUR » côté policy → ratio 1 h × 24 (biais noté PR).
//   - σ : formule vendor sigmaDaily() sur bougies (10 daily — limite PR §Limites).
// ---------------------------------------------------------------------------
export interface LadderFeatures {
  t: number; price: number; sigmaDaily: number | null; nReturns: number;
  chg1h: number | null; high: number; drawdown: number; sma: number | null;
  feeDaily24h: number; feeTvl1h: number; volSpike: number | null;
  tvlUsd: number; tvlSol: number; volume24hUsd: number; poolAgeDays: number;
  binStep: number; swapFee: number; poolWidthLog?: number;
}

export function mapPoolToFeatures(
  p: any,
  candles: { time: number; close: number }[],
  solUsd: number,
  sigma: { sigma: number | null; n: number },
): LadderFeatures {
  const closes = candles.map((c) => c.close).filter((c) => c > 0);
  const last = closes.length ? closes[closes.length - 1] : p.current_price;
  const recentHour = [...candles].reverse().find((c) => Date.now() / 1000 - c.time <= 3600 + 900);
  const high = closes.length ? Math.max(...closes) : last;
  return {
    t: Date.now(),
    price: p.current_price,
    sigmaDaily: sigma.sigma,
    nReturns: sigma.n,
    chg1h: recentHour && recentHour.close > 0 ? last / recentHour.close - 1 : null,
    high,
    drawdown: high > 0 ? last / high - 1 : 0,
    sma: closes.length >= 7 ? closes.slice(-7).reduce((a, b) => a + b, 0) / Math.min(closes.length, 7) : null,
    feeDaily24h: (p.fee_tvl_ratio_24h ?? 0) / 100,
    feeTvl1h: ((p.fee_tvl_ratio_1h ?? 0) / 100) * 24,
    volSpike: p.volume_1h > 0 && p.volume_24h > 0 ? (p.volume_1h * 24) / p.volume_24h : null,
    tvlUsd: p.tvl,
    tvlSol: solUsd > 0 ? p.tvl / solUsd : 0,
    volume24hUsd: p.volume_24h,
    poolAgeDays: p.pool_age_days,
    binStep: p.bin_step,
    swapFee: (p.base_fee_pct ?? 0) / 100,
  };
}

// ---------------------------------------------------------------------------
// Mark temps réel d'une position ladder : reconstruit la composition DLMM depuis
// les montants on-chain (totalX/totalY du compte) et la transforme en pseudo
// BinPosition pour markInfo/composition du vendor (mêmes formules qu'en paper).
// aboveTicks/belowTicks : comparaisons prix bornes ↔ prix actif (tick = 1 passe
// de monitor ≈ 1 min ; latence mesurée via ladder_compare, pas cachée).
// ---------------------------------------------------------------------------
export interface LadderMark {
  valueSol: number; xUi: number; yUi: number; pureSol: number; depositSol: number;
  feesSol: number; inRange: boolean; activeBinId: number;
  aboveTicks: number; belowTicks: number;
}

export function computeMark(
  pos: { deposit_usd: number; min_bin_id: number; max_bin_id: number; bin_step: number },
  totalXRaw: bigint, totalYRaw: bigint, decX: number,
  price: number, activeBinId: number, solUsd: number, feesSol: number,
): LadderMark {
  const xUi = Number(totalXRaw) / 10 ** decX;
  const yUi = Number(totalYRaw) / 1e9;
  const valueSol = yUi + xUi * price;
  const depositSol = pos.deposit_usd / (solUsd || 1);
  // SOL seul côté Y (side=y) : le prix sort de la range HAUTE → tout en X (100 % SOL)
  // → X1 ; il sort par le BAS → tout en token → X3. On compte en ticks de bin.
  const aboveTicks = activeBinId > pos.max_bin_id ? activeBinId - pos.max_bin_id : 0;
  const belowTicks = activeBinId < pos.min_bin_id ? pos.min_bin_id - activeBinId : 0;
  return {
    valueSol, xUi, yUi, pureSol: valueSol - depositSol, depositSol,
    feesSol, inRange: activeBinId >= pos.min_bin_id && activeBinId <= pos.max_bin_id,
    activeBinId, aboveTicks, belowTicks,
  };
}

/** Position claude-Position reconstituée pour claudePolicy.exit (champs requis uniquement). */
export function toClaudePosition(pos: any, mark: LadderMark, openedTicksAbove: number, openedTicksBelow: number) {
  return {
    id: pos.id, book: "ladder-real", pool: pos.pool_address, token: pos.name,
    strategy: "sol-ladder-spot", openedAt: pos.opened_at,
    depositSol: mark.depositSol, binStep: pos.bin_step,
    liq: { binStep: pos.bin_step, lowerBin: pos.min_bin_id, upperBin: pos.max_bin_id, liq: [] },
    side: "y", shape: "spot", phase: "ladder",
    idleSol: 0, feesSol: mark.feesSol, claimedSol: 0, costsSol: 0,
    openPrice: pos.entry_price, lastPrice: mark.valueSol, lastValue: mark.valueSol, lastMarkT: Date.now(),
    lowSinceOpen: pos.entry_price, peakNet: 0,
    aboveTicks: openedTicksAbove, belowTicks: openedTicksBelow,
    edgeBadTicks: 0, oorSince: null, prevNet: 0,
    flipAt: null, flipVwap: null, flipLow: null,
    entry: {}, closedAt: null, closeReason: null, closePure: null, closeFees: null,
  } as any;
}

// ---------------------------------------------------------------------------
// Tables ladder (coûts + comparatif) — créées idempotemment à l'import.
// ---------------------------------------------------------------------------
// Migration idempotente : la version initiale de cette PR nommait la colonne
// « lamport_fees » ; les scripts lisent « tx_fees_sol ». On aligne par ALTER
// (les tables sont neuves, jamais peuplées hors test — aucune donnée à migrer).
const costCols = (db.prepare("PRAGMA table_info(ladder_costs)").all() as { name: string }[]).map((c) => c.name);
if (costCols.includes("lamport_fees") && !costCols.includes("tx_fees_sol")) {
  db.exec("ALTER TABLE ladder_costs RENAME COLUMN lamport_fees TO tx_fees_sol");
}

/** Clé wallet présente ? (lecture de solde autorisée sans REAL_LADDER — pas d'écriture possible ici) */
export function hasWalletKey(): boolean { return !!config.walletPrivateKey; }

/** Solde natif du wallet (journal des coûts réels). */
export async function walletSol(): Promise<number> {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey!, "base64"));
  return (await conn.getBalance(signer.publicKey)) / 1e9;
}
