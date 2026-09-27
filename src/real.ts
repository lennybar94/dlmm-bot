// Adapter MODE RÉEL — verrouillé par la garde d'exécution (assertPaperOnly).
// Réécrit le 21/08/2026 (revue REAL-ADAPTER-REVIEW-20260821.md) :
//  - montants calculés par la MÊME math que le paper (buildLiquidity + presets),
//    convertis en lamports avec les decimals réels des deux tokens
//  - oneSided respecté (topblast = single-sided)
//  - StrategyType issu du preset (sdkStrategy), plus de fallback Spot silencieux
//  - fermeture (removeLiquidity + claim) et claim ajoutés
//  - priority fee + retry
// NOTE SDK : @meteora-ag/dlmm v1.9.x s'importe en CJS (createRequire) — l'import
// ESM casse sur @coral-xyz/anchor (ERR_UNSUPPORTED_DIR_IMPORT). API : create() à
// la racine. Testé en lecture seule sur mainnet (getActiveBin OK).

import { createRequire } from "node:module";
import { assertPaperOnly, config } from "./config.js";
import type { OpportunityScore } from "./types.js";
import { STRATEGY_PRESETS, depositForPool } from "./strategies.js";
import { buildLiquidity, estimateYUsd } from "./paper.js";
import { binIdFromPrice } from "./strategies.js";

const require = createRequire(import.meta.url);

interface SdkBundle {
  Connection: new (url: string, commitment?: string) => unknown;
  Keypair: { fromSecretKey: (bytes: Uint8Array) => unknown; generate: () => unknown };
  PublicKey: new (s: string) => unknown;
  sendAndConfirmTransaction: (...args: unknown[]) => Promise<string>;
  createPool: (conn: unknown, address: unknown, opts: { cluster: string }) => Promise<Record<string, unknown>>;
  StrategyType: Record<string, number>;
  BN: new (v: string | number) => { isZero: () => boolean };
  ComputeBudgetProgram: { setComputeUnitPrice: (args: { microLamports: number }) => unknown };
}

function loadSdk(): SdkBundle {
  const solana = require("@solana/web3.js") as Record<string, unknown>;
  const dlmm = require("@meteora-ag/dlmm") as Record<string, unknown>;
  return {
    Connection: solana.Connection as SdkBundle["Connection"],
    Keypair: solana.Keypair as SdkBundle["Keypair"],
    PublicKey: solana.PublicKey as SdkBundle["PublicKey"],
    sendAndConfirmTransaction: solana.sendAndConfirmTransaction as SdkBundle["sendAndConfirmTransaction"],
    createPool: dlmm.create as SdkBundle["createPool"],
    StrategyType: dlmm.StrategyType as SdkBundle["StrategyType"],
    BN: require("bn.js") as SdkBundle["BN"],
    ComputeBudgetProgram: solana.ComputeBudgetProgram as SdkBundle["ComputeBudgetProgram"],
  };
}

// Decimals des mints : Data API d'abord (pool.token_x.decimals), sinon RPC
// (getParsedAccountInfo) avec cache. Fallback 9 (SOL-like) en dernier recours.
const mintDecimalsCache = new Map<string, number>();
async function decimalsFor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any,
  mint: string,
  fallback: number | undefined
): Promise<number> {
  if (fallback != null && Number.isFinite(fallback)) return fallback;
  if (mintDecimalsCache.has(mint)) return mintDecimalsCache.get(mint)!;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const info = (await connection.getParsedAccountInfo(new (loadSdk().PublicKey)(mint))) as any;
    const d = info?.value?.data?.parsed?.info?.decimals;
    if (typeof d === "number") {
      mintDecimalsCache.set(mint, d);
      return d;
    }
  } catch {
    /* fallback ci-dessous */
  }
  return 9;
}

// Retry sur envoi de transaction (congestion Solana) : 3 essais, 2 s d'écart.
/**
 * Confirme une tx par POLLING getSignatureStatus — HTTP pur, AUCUN websocket.
 * ⚠️ Incident 2026-08-27 14:35 : sendAndConfirmTransaction confirme via
 * signatureSubscribe (ws interne web3.js) ; quand le tier ws Helius renvoie
 * 429 (saturation — 2 ws-pool-monitor en double), la souscription ne
 * s'établit jamais → la confirmation pend → le run real-monitor se BLOQUE
 * (flock pris, surveillance arrêtée 25 min, watchdog 15:00). Les txs
 * passaient quand même on-chain (claim Zoe 12:36 + sweep 12:45 finalisés
 * malgré TransactionExpired…) — le ws ne fait que casser la CONFIRMATION.
 * Le polling est HTTP pur : plus aucune dépendance au ws pour le filet de
 * sécurité (open/close/claim).
 */
async function pollConfirmed(
  conn: any,
  sig: string,
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: any = null;
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatus(sig).catch(() => null);
    const v = st?.value;
    if (v) {
      last = v;
      if (v.err) throw new Error(`tx ${sig.slice(0, 12)}… rejetée on-chain : ${JSON.stringify(v.err)}`);
      if (v.confirmationStatus && v.confirmationStatus !== "processed") return;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(
    `confirmation timeout ${Math.round(timeoutMs / 1000)}s (sig ${sig.slice(0, 12)}… — dernier statut ${last ? last.confirmationStatus : "inconnu"})`
  );
}

async function sendWithRetry(
  _send: SdkBundle["sendAndConfirmTransaction"],
  connection: unknown,
  tx: unknown,
  signers: unknown[],
  attempts = 3
): Promise<string> {
  const conn = connection as any;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      // Envoi IDENTIQUE à sendAndConfirmTransaction (ligne 2273) : HTTP pur,
      // signature gérée par sendTransaction — seule la CONFIRMATION change
      // (polling au lieu de la souscription ws).
      const sig: string = await conn.sendTransaction(tx, signers);
      await pollConfirmed(conn, sig, 60_000);
      return sig;
    } catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 2000));
    }
  }
  throw lastErr;
}

export interface RealOpenResult {
  sig: string;
  positionPubkey: string;
  amountX: number; // en unités token (décimales incluses)
  amountY: number;
  rawX?: bigint; // montants bruts on-chain (pour convertisseur de marqueur $, L4-B stable)
  rawY?: bigint;
  minBinId: number;
  maxBinId: number;
  entryPrice: number;
}

/**
 * Ouvre une position RÉELLE sur un pool DLMM.
 * Montants : même math que le paper (buildLiquidity), convertie en lamports.
 * Range : récentrée sur le bin actif on-chain (échelle SDK ≠ Data API).
 */
export async function realOpenPosition(
  opp: OpportunityScore,
  depositUsd?: number,
  opts: { yOverrideRaw?: bigint } = {}
): Promise<RealOpenResult> {
  assertPaperOnly("realOpenPosition");
  if (!config.walletPrivateKey) throw new Error("WALLET_PRIVATE_KEY manquant dans .env");

  const sdk = loadSdk();
  const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, createPool, StrategyType, ComputeBudgetProgram } = sdk;
  const connection = new Connection(config.rpcUrl, "confirmed");
  const user = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(config.walletPrivateKey, "base64")));

  const p = opp.pool;
  const hint = opp.strategyHint;
  const preset = STRATEGY_PRESETS[hint.strategy] ?? STRATEGY_PRESETS["spot-spread"];

  // 1) Mêmes calculs que le paper (math validée par le paper)
  const yUsd = estimateYUsd(p);
  const entryPrice = p.current_price;
  const depositUsdFinal = depositUsd ?? depositForPool(p);
  if (!Number.isFinite(depositUsdFinal) || depositUsdFinal <= 0) throw new Error("dépôt invalide");
  const depositY = depositUsdFinal / yUsd;
  const activeBinIdData = binIdFromPrice(entryPrice, p.bin_step);
  const minBinIdHint = hint.minBinId ?? activeBinIdData - 10;
  const maxBinIdHint = hint.maxBinId ?? activeBinIdData + 10;
  const liq = buildLiquidity({
    depositY,
    price: entryPrice,
    minBinId: minBinIdHint,
    maxBinId: maxBinIdHint,
    binStep: p.bin_step,
    oneSided: preset.oneSided,
  });

  // 2) Montants bruts (lamports) avec les decimals réels des deux tokens
  const decX = await decimalsFor(connection, p.token_x.address, p.token_x.decimals);
  const decY = await decimalsFor(connection, p.token_y.address, p.token_y.decimals);
  const rawX = preset.oneSided === "y" ? 0n : BigInt(Math.floor((liq.x0 ?? 0) * 10 ** decX));
  let rawY = preset.oneSided === "x" ? 0n : BigInt(Math.floor((liq.y0 ?? 0) * 10 ** decY));
  // Pilote L4-B sur pool stable (TRUMP-USDC…) : le côté Y a été acheté en amont
  // (swapSolForStable) → on dépose le montant RÉEL en sa devise native (raw UI),
  // pas la projection SOL de la math paper.
  if (opts.yOverrideRaw !== undefined && opts.yOverrideRaw > 0n) rawY = opts.yOverrideRaw;
  if (rawX <= 0n && rawY <= 0n) throw new Error("montants nuls (math) — position non ouverte");
  if (rawX < 0n || rawY < 0n) throw new Error("montants négatifs (math) — position non ouverte");

  // 3) Pool + bin actif on-chain (échelle SDK)
  const pool = await createPool(connection, new PublicKey(p.address), { cluster: config.cluster });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeBin = await (pool as any).getActiveBin();
  // Range on-chain : les ids SDK ≠ ids Data API (échelle différente), mais le
  // NOMBRE de bins pour un même écart % est invariant. On réplique la STRUCTURE
  // du hint :
  //  - bidask-dip  : accumulation SOUS le prix → [activeBin − spread, activeBin]
  //  - bidask-flip : distribution AU-DESSUS      → [activeBin, activeBin + spread]
  //  - autres (spot/curve/topblast) : symétrique → activeBin ± spread/2
  // ⚠️ Limite on-chain (probe sim 2026-08-22) : le programme DLMM exige une
  // largeur de position < 70 bins (InvalidPositionWidth ≥ 70, common.rs:30) ET
  // le realloc d'un compte créé dans la même tx est plafonné à 10 240 octets
  // (~28 o/bin → ~69 bins max). Au-delà, l'ouverture échoue À LA SIMULATION
  // (sig vide, aucun fonds engagé). Clamp = garde réelle du pilote.
  const MAX_REAL_POSITION_WIDTH = 69;
  const spreadRaw = Math.max(1, Math.round(maxBinIdHint - minBinIdHint));
  const spread = Math.min(spreadRaw, MAX_REAL_POSITION_WIDTH);
  if (spread < spreadRaw) {
    console.warn(
      `⚠️ échelle réduite ${spreadRaw} → ${spread} bins (largeur max on-chain ${MAX_REAL_POSITION_WIDTH}, realloc 10 240 o)`
    );
  }
  let minBinId: number;
  let maxBinId: number;
  if (hint.strategy === "bidask-dip") {
    minBinId = activeBin.binId - spread;
    maxBinId = activeBin.binId;
  } else if (hint.strategy === "bidask-flip") {
    minBinId = activeBin.binId;
    maxBinId = activeBin.binId + spread;
  } else {
    const perSide = Math.max(1, Math.round(spread / 2));
    minBinId = activeBin.binId - perSide;
    maxBinId = activeBin.binId + perSide;
  }
  const strategyType = StrategyType[preset.sdkStrategy] ?? StrategyType.Spot;

  // 4) Position + transaction (priority fee + retry)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const positionPubKey = (Keypair.generate() as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = await (pool as any).initializePositionAndAddLiquidityByStrategy({
    positionPubKey: positionPubKey.publicKey,
    user: (user as any).publicKey,
    totalXAmount: new sdk.BN(rawX.toString()),
    totalYAmount: new sdk.BN(rawY.toString()),
    strategy: { minBinId, maxBinId, strategyType },
  });
  try {
    const ix = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 });
    if (tx?.instructions?.unshift) tx.instructions.unshift(ix);
  } catch {
    /* priority fee optionnel — non bloquant */
  }
  const sig = await sendWithRetry(sendAndConfirmTransaction, connection, tx, [user, positionPubKey]);

  return {
    sig,
    positionPubkey: positionPubKey.publicKey.toBase58(),
    amountX: Number(rawX) / 10 ** decX,
    amountY: Number(rawY) / 10 ** decY,
    rawX,
    rawY,
    minBinId,
    maxBinId,
    entryPrice,
  };
}

/**
 * Ferme une position RÉELLE : removeLiquidity (bps, défaut 10000 = tout) + claim
 * dans la même transaction. C'est le kill-switch manuel du pilote.
 */
export async function realClosePosition(poolAddress: string, positionPubkey: string, bps = 10000): Promise<string> {
  assertPaperOnly("realClosePosition");
  const sdk = loadSdk();
  const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, createPool, BN } = sdk;
  const connection = new Connection(config.rpcUrl, "confirmed");
  const user = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(config.walletPrivateKey, "base64")));
  const pool = await createPool(connection, new PublicKey(poolAddress), { cluster: config.cluster });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { userPositions } = await (pool as any).getPositionsByUserAndLbPair((user as any).publicKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pos = userPositions.find((x: any) => x.publicKey.toBase58() === positionPubkey);
  if (!pos) throw new Error(`position ${positionPubkey} introuvable sur le pool ${poolAddress}`);

  // ⚠️ Le SDK attend le PUBLIC KEY du compte position (pas l'objet position) —
  // la doc : "position: The public key of the position account" (bug attrapé en
  // test kill-switch : getAccountInfo(position) plantait sur l'objet).
  // ⚠️ SDK v1.9.14 : fromBinId/toBinId n'ont PAS de défaut — sans eux,
  // chunkBinRange(undefined, undefined) → [] → AUCUNE tx (fermeture fantôme
  // avec sig vide, attrapée en test kill-switch). On passe le range complet
  // depuis positionData.
  const pd = (pos as any).positionData;
  const txs = (await (pool as any).removeLiquidity({
    position: (pos as any).publicKey,
    user: (user as any).publicKey,
    fromBinId: Number(pd.lowerBinId),
    toBinId: Number(pd.upperBinId),
    bps: new BN(bps), // ⚠️ le SDK appelle bps.toNumber() — BN obligatoire
    shouldClaimAndClose: true,
  })) as unknown[];
  let lastSig = "";
  for (const tx of txs) {
    lastSig = await sendWithRetry(sendAndConfirmTransaction, connection, tx, [user]);
  }
  return lastSig;
}

/** Claim des frais accumulés d'une position réelle. */
export async function realClaimRewards(poolAddress: string, positionPubkey: string): Promise<string> {
  assertPaperOnly("realClaimRewards");
  const sdk = loadSdk();
  const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, createPool, ComputeBudgetProgram } = sdk;
  const connection = new Connection(config.rpcUrl, "confirmed");
  const user = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(config.walletPrivateKey, "base64")));
  const pool = await createPool(connection, new PublicKey(poolAddress), { cluster: config.cluster });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { userPositions } = await (pool as any).getPositionsByUserAndLbPair((user as any).publicKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pos = userPositions.find((x: any) => x.publicKey.toBase58() === positionPubkey);
  if (!pos) throw new Error(`position ${positionPubkey} introuvable sur le pool ${poolAddress}`);

  // ⚠️ Le SDK destructure `{owner, position}` — passer `user` laissait `owner`
  // undefined → `payer.toBuffer()` dans compileToV0Message (simulation CU) → TypeError.
  // Fix 2026-08-25 (claim AUTO XST-SOL échoué à 17:15, fees 25.10$ restées on-chain).
  // ⚠️ claimAllRewardsByPosition retourne Transaction[] (1+ tx, comme
  // removeLiquidity) — envoyer CHAQUE tx dans l'ordre, la dernière sig est
  // le résultat. Envoyer le tableau tel quel → sendAndConfirmTransaction
  // crashe « transaction.sign is not a function » (bug réel 2026-08-26
  // 13:48 : claim AUTO CVXV666/GTA6 échoué ~4 h, fees 102$/29$ restées
  // on-chain, 240+ alertes 🚨). Même pattern que realClosePosition.
  const txs = (await (pool as any).claimAllRewardsByPosition({ owner: (user as any).publicKey, position: pos })) as unknown[];
  let lastSig = "";
  for (const tx of txs) {
    try {
      const ix = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10_000 });
      if ((tx as any)?.instructions?.unshift) (tx as any).instructions.unshift(ix);
    } catch {
      /* non bloquant */
    }
    lastSig = await sendWithRetry(sendAndConfirmTransaction, connection, tx, [user]);
  }
  return lastSig;
}

/** Récupère les positions réelles d'un wallet sur un pool (lecture seule). */
export async function realGetPositions(poolAddress: string): Promise<unknown[]> {
  const sdk = loadSdk();
  const { Connection, Keypair, PublicKey, createPool } = sdk;
  const connection = new Connection(config.rpcUrl, "confirmed");
  const user = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(config.walletPrivateKey, "base64")));
  const pool = await createPool(connection, new PublicKey(poolAddress), { cluster: config.cluster });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { userPositions } = await (pool as any).getPositionsByUserAndLbPair((user as any).publicKey);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (userPositions as any[]).map((p: any) => ({
    address: p.publicKey.toBase58(),
    lowerBinId: p.positionData.lowerBinId,
    upperBinId: p.positionData.upperBinId,
    totalXAmount: p.positionData.totalXAmount?.toString?.() ?? null,
    totalYAmount: p.positionData.totalYAmount?.toString?.() ?? null,
  }));
}
