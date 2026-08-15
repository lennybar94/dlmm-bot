// Adapter MODE RÉEL — verrouillé par la garde d'exécution.
// Le chemin par défaut du bot est PAPER ONLY ; ces fonctions ne s'exécutent que si
// REAL_MODE=true ET REAL_CONFIRM=CONFIRMED-REAL-MODE dans .env (déconseillé sans revue).
// NOTE SDK : @meteora-ag/dlmm v1.9.x s'importe en CJS (createRequire) — l'import ESM
// casse sur @coral-xyz/anchor (ERR_UNSUPPORTED_DIR_IMPORT). API : create() à la racine,
// plus de classe DLMM statique. Testé en lecture seule sur mainnet (getActiveBin OK).

import { createRequire } from "node:module";
import { assertPaperOnly, config } from "./config.js";
import type { StrategyHint } from "./types.js";

const require = createRequire(import.meta.url);

interface SdkBundle {
  Connection: new (url: string, commitment?: string) => unknown;
  Keypair: {
    fromSecretKey: (bytes: Uint8Array) => unknown;
    generate: () => unknown;
  };
  PublicKey: new (s: string) => unknown;
  sendAndConfirmTransaction: (...args: unknown[]) => Promise<string>;
  createPool: (
    conn: unknown,
    address: unknown,
    opts: { cluster: string }
  ) => Promise<Record<string, unknown>>;
  StrategyType: Record<string, number>;
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
  };
}

export interface RealOpenArgs {
  poolAddress: string;
  depositUsd: number;
  hint: StrategyHint;
  strategyName: string;
  tokenXDecimals: number;
  tokenYDecimals: number;
}

/**
 * Ouvre une position réelle sur un pool DLMM. GARDÉ : ne s'exécute qu'en mode réel confirmé.
 * Montants en unités brutes (lamports) — decimals attendus de la Data API.
 */
export async function realOpenPosition(args: RealOpenArgs): Promise<string> {
  assertPaperOnly("realOpenPosition");
  if (!config.walletPrivateKey) throw new Error("WALLET_PRIVATE_KEY manquant");

  const { Connection, Keypair, PublicKey, sendAndConfirmTransaction, createPool, StrategyType } =
    loadSdk();
  const connection = new Connection(config.rpcUrl, "confirmed");
  const user = Keypair.fromSecretKey(
    Uint8Array.from(Buffer.from(config.walletPrivateKey, "base64"))
  );
  const pool = await createPool(connection, new PublicKey(args.poolAddress), {
    cluster: "mainnet-beta",
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const activeBin = await (pool as any).getActiveBin();
  // ⚠️ Les bin ids de la Data API (échelle prix-par-token) diffèrent des ids
  // on-chain du SDK (échelle par-lamport) : on recentre donc le range sur
  // activeBin.binId avec l'écart de la stratégie (hint.binsPerSide).
  const perSide = Math.max(1, Math.round((args.hint.maxBinId - args.hint.minBinId) / 2) || 1);
  const minBinId = activeBin.binId - perSide;
  const maxBinId = activeBin.binId + perSide;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pricePerToken = (pool as any).fromPricePerLamport(Number(activeBin.price));
  const yUsd = args.depositUsd / 2;
  const amountY = Math.floor((yUsd * 10 ** args.tokenYDecimals) / pricePerToken) || 1;
  const amountX = Math.floor(yUsd * 10 ** args.tokenXDecimals);

  const positionPubKey = Keypair.generate();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = await (pool as any).initializePositionAndAddLiquidityByStrategy({
    positionPubKey: (positionPubKey as { publicKey: unknown }).publicKey,
    user: (user as { publicKey: unknown }).publicKey,
    totalXAmount: amountX,
    totalYAmount: amountY,
    strategy: {
      minBinId,
      maxBinId,
      strategyType: StrategyType[args.strategyName] ?? StrategyType.Spot,
    },
  });

  const sig = await sendAndConfirmTransaction(connection, tx, [user, positionPubKey]);
  return sig;
}

/** Récupère les positions réelles d'un wallet sur un pool (lecture seule). */
export async function realGetPositions(poolAddress: string): Promise<unknown[]> {
  const { Connection, Keypair, PublicKey, createPool } = loadSdk();
  const connection = new Connection(config.rpcUrl, "confirmed");
  const user = Keypair.fromSecretKey(
    Uint8Array.from(Buffer.from(config.walletPrivateKey, "base64"))
  );
  const pool = await createPool(connection, new PublicKey(poolAddress), {
    cluster: "mainnet-beta",
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { userPositions } = await (pool as any).getPositionsByUserAndLbPair(
    (user as { publicKey: unknown }).publicKey
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (userPositions as any[]).map((p: any) => ({
    address: p.publicKey.toBase58(),
    lowerBinId: p.positionData.lowerBinId,
    upperBinId: p.positionData.upperBinId,
  }));
}
