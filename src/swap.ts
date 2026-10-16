// Swap DIRECT pool DLMM : SOL → token X (achat d'inventaire, pilote L4-B).
// Chemin SDK CJS (createRequire), confirmation par POLLING HTTP (incident
// 2026-08-27 : la souscription ws peut pendre → blocage ; HTTP pur + polling).
// Les GARDES (cluster mainnet, pubkey == wallet pilote, --confirm explicite)
// sont portées par les scripts appelants (buy-token.ts, l4b-open.ts) — ici
// aucune signature n'est faite sans appel volontaire.
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

export interface SwapSolForTokenResult {
  sig: string;
  inSol: number; // SOL réellement consommés (quote)
  outTokenUi: number; // token attendus (quote — vérifier le solde réel après)
  decimals: number;
}

/**
 * Swap SOL → token via le pool DLMM direct (Y→X). Retourne la sig + la quote ;
 * l'appelant VÉRIFIE le solde token réel après (2 lectures — pattern sell-omo).
 */
export async function swapSolForToken(opts: {
  poolAddress: string;
  xMint: string;
  xDecimals: number;
  solAmount: number;
  slippageBps?: number;
}): Promise<SwapSolForTokenResult> {
  const slippageBps = opts.slippageBps ?? 500;
  const conn = new Connection(config.rpcUrl, "confirmed");
  const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64"));
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const pool = await create(conn, new PublicKey(opts.poolAddress), { cluster: config.cluster });
  const inRaw = BigInt(Math.floor(opts.solAmount * 1e9));
  if (inRaw <= 0n) throw new Error("solAmount invalide");

  const binArrays = await pool.getBinArrayForSwap(false, 8); // false = Y→X
  const quote = pool.swapQuote(new BN(inRaw.toString()), false, new BN(slippageBps), binArrays);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tx = await pool.swap({
    inToken: new PublicKey(SOL_MINT),
    outToken: new PublicKey(opts.xMint),
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
    throw new Error(`confirmation non obtenue en 60 s (dernier : ${status?.confirmationStatus ?? "inconnu"}) — sig ${sig}`);
  }

  return {
    sig,
    inSol: Number(quote.consumedInAmount.toString()) / 1e9,
    outTokenUi: Number(quote.outAmount.toString()) / 10 ** opts.xDecimals,
    decimals: opts.xDecimals,
  };
}

export interface SwapTokenForSolResult {
  sig: string;
  inTokenUi: number; // token réellement consommés (quote)
  outSol: number; // SOL attendus (quote — vérifier le solde réel après)
}

/**
 * Swap token X → SOL via le pool DLMM direct (X→Y) : revente de l'inventaire
 * d'une position fermée (miroir DLMM Claude). Même chemin que swapSolForToken,
 * sens inverse. Le montant est en unités brutes (solde réel lu par l'appelant).
 */
export async function swapTokenForSol(opts: {
  poolAddress: string;
  xMint: string;
  xDecimals: number;
  amountRaw: bigint;
  slippageBps?: number;
}): Promise<SwapTokenForSolResult> {
  const slippageBps = opts.slippageBps ?? 300;
  if (opts.amountRaw <= 0n) throw new Error("amountRaw invalide");
  const conn = new Connection(config.rpcUrl, "confirmed");
  const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64"));
  const pool = await create(conn, new PublicKey(opts.poolAddress), { cluster: config.cluster });

  const binArrays = await pool.getBinArrayForSwap(true, 8); // true = X→Y
  const quote = pool.swapQuote(new BN(opts.amountRaw.toString()), true, new BN(slippageBps), binArrays);

  const tx = await pool.swap({
    inToken: new PublicKey(opts.xMint),
    outToken: new PublicKey(SOL_MINT),
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
    throw new Error(`confirmation non obtenue en 60 s (dernier : ${status?.confirmationStatus ?? "inconnu"}) — sig ${sig}`);
  }
  return {
    sig,
    inTokenUi: Number(quote.consumedInAmount.toString()) / 10 ** opts.xDecimals,
    outSol: Number(quote.outAmount.toString()) / 1e9,
  };
}

/** Solde token d'un wallet (lecture par mint, déterministe — pas d'index RPC). */
export async function tokenBalanceOf(conn: unknown, wallet: unknown, mint: string): Promise<bigint> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const c = conn as any;
  const accounts = await c.getTokenAccountsByOwner(wallet, { mint: new PublicKey(mint) });
  let total = 0n;
  for (const ta of accounts.value) total += Buffer.from(ta.account.data).readBigUInt64LE(64);
  return total;
}
