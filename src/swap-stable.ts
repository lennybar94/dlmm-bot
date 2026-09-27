// Swap DIRECT pool DLMM : SOL → USDC (préparation du côté stable d'un dépôt
// balancé sur un pool X-USDC — pilote L4-B élargi 27/09).
// Mécanique identique à swapSolForToken (Y→X) : ici on vise le token Y = USDC.
// Les GARDES (cluster mainnet, pubkey wallet pilote, --confirm explicite) sont
// portées par les scripts appelants — aucune signature sans appel volontaire.
import { config } from "./config.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Keypair, PublicKey, Connection } = require("@solana/web3.js") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { create } = require("@meteora-ag/dlmm") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { BN } = require("bn.js") as any;

export const SOL_MINT = "So11111111111111111111111111111111111111112";

export const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const USDT_MINT = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";

export interface SwapStableResult {
  sig: string;
  inSol: number; // SOL réellement consommés (quote)
  outUi: number; // units stables attendues (quote — vérifier le solde réel après)
}

/**
 * Swap SOL → stable (USDC ou USDT) via le pool DLMM donné (SOL doit être l'un
 * des deux tokens du pool). Retourne la sig + la quote ; l'appelant VÉRIFIE le
 * solde stable réel après (pattern double lecture de sell-omo).
 */
export async function swapSolForStable(opts: {
  poolAddress: string;
  stableMint: string; // USDC_MINT | USDT_MINT
  stableDecimals: number;
  solAmount: number;
  slippageBps?: number;
}): Promise<SwapStableResult> {
  const slippageBps = opts.slippageBps ?? 100; // paires majeures : slippage faible
  const conn = new Connection(config.rpcUrl, "confirmed");
  const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = await create(conn, new PublicKey(opts.poolAddress), { cluster: config.cluster });
  const inRaw = BigInt(Math.floor(opts.solAmount * 1e9));
  if (inRaw <= 0n) throw new Error("solAmount invalide");

  // Direction SOL → stable : false si SOL est le token Y du pool (SOL-USDC où
  // x=SOL? non — dans nos pools « y » est souvent USDC et SOL est x). Le SDK
  // veut `swapForY`: true quand on vend X pour acheter Y. On détermine selon
  // la position réelle de SOL dans le pool.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xMintPk: any =
    (pool as any).tokenX?.publicKey ?? (pool as any).lbPair?.tokenXMint ?? (pool as any).lbPair?.token_x_mint;
  if (!xMintPk) throw new Error("mint X du pool illisible");
  const SOL_MINT_PK = new PublicKey(SOL_MINT);
  const solIsX = xMintPk.equals(SOL_MINT_PK);
  const swapForY = solIsX; // vendre X(SOL) → acheter Y(stable)
  const binArrays = await pool.getBinArrayForSwap(swapForY, 8);
  const quote = pool.swapQuote(
    new BN(inRaw.toString()),
    swapForY,
    new BN(slippageBps),
    binArrays
  );

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = await pool.swap({
    inToken: new PublicKey("So11111111111111111111111111111111111111112"),
    outToken: new PublicKey(opts.stableMint),
    inAmount: quote.consumedInAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: new PublicKey(opts.poolAddress),
    user: signer.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });

  // Confirmation par polling HTTP (leçon 27/08) — jamais de ws.
  let status: { err: unknown; confirmationStatus?: string } | null = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatus(sig).catch(() => null);
    const v = st?.value;
    if (v) {
      status = v;
      if (v.err) throw new Error(`tx rejetée on-chain : ${JSON.stringify(v.err)}`);
      if (v.confirmationStatus && v.confirmationStatus !== "processed") break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!status || (status.confirmationStatus ?? "") === "processed") {
    throw new Error(
      `confirmation non obtenue en 60 s (dernier : ${status?.confirmationStatus ?? "inconnu"}) — sig ${sig}`
    );
  }

  return {
    sig,
    inSol: Number(quote.consumedInAmount.toString()) / 1e9,
    outUi: Number(quote.outAmount.toString()) / 10 ** opts.stableDecimals,
  };
}

/**
 * Swap stable (USDC/USDT) → token X via le pool DLMM X-stable (Y→X).
 * Même mécanique de confirmation que swapSolForStable (polling HTTP).
 */
export async function swapStableForToken(opts: {
  poolAddress: string;
  xMint: string;
  xDecimals: number;
  stableMint: string; // USDC_MINT | USDT_MINT
  stableDecimals: number;
  stableAmountUi: number; // unités UI du stable à engager
  slippageBps?: number;
}): Promise<{ sig: string; inUi: number; outTokenUi: number }> {
  const slippageBps = opts.slippageBps ?? 200;
  const conn = new Connection(config.rpcUrl, "confirmed");
  const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = await create(conn, new PublicKey(opts.poolAddress), { cluster: config.cluster });
  const inRaw = BigInt(Math.floor(opts.stableAmountUi * 10 ** opts.stableDecimals));
  if (inRaw <= 0n) throw new Error("stableAmountUi invalide");

  // Le stable est-il X ou Y dans ce pool ? (TRUMP-USDC : x=TRUMP, y=USDC → vendre Y)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const xMintPk: any =
    (pool as any).tokenX?.publicKey ?? (pool as any).lbPair?.tokenXMint ?? (pool as any).lbPair?.token_x_mint;
  if (!xMintPk) throw new Error("mint X du pool illisible");
  const stableIsX = xMintPk.equals(new PublicKey(opts.stableMint));
  const swapForY = !stableIsX; // vendre Y(stable) → acheter X si stable côté Y ; sinon vendre X(stable)
  const binArrays = await pool.getBinArrayForSwap(swapForY, 8);
  const quote = pool.swapQuote(new BN(inRaw.toString()), swapForY, new BN(slippageBps), binArrays);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = await pool.swap({
    inToken: new PublicKey(opts.stableMint),
    outToken: new PublicKey(opts.xMint),
    inAmount: quote.consumedInAmount,
    minOutAmount: quote.minOutAmount,
    lbPair: new PublicKey(opts.poolAddress),
    user: signer.publicKey,
    binArraysPubkey: quote.binArraysPubkey,
  });
  tx.sign(signer);
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });

  let status: { err: unknown; confirmationStatus?: string } | null = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const st = await conn.getSignatureStatus(sig).catch(() => null);
    const v = st?.value;
    if (v) {
      status = v;
      if (v.err) throw new Error(`tx rejetée on-chain : ${JSON.stringify(v.err)}`);
      if (v.confirmationStatus && v.confirmationStatus !== "processed") break;
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!status || (status.confirmationStatus ?? "") === "processed") {
    throw new Error(
      `confirmation non obtenue en 60 s (dernier : ${status?.confirmationStatus ?? "inconnu"}) — sig ${sig}`
    );
  }
  return {
    sig,
    inUi: Number(quote.consumedInAmount.toString()) / 10 ** opts.stableDecimals,
    outTokenUi: Number(quote.outAmount.toString()) / 10 ** opts.xDecimals,
  };
}
