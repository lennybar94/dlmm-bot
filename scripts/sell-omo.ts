// Vente du sac omo résiduel → SOL, swap DIRECT sur le pool omo-SOL via le SDK DLMM.
// Phase 1 (défaut) : QUOTE seule — aucune signature, aucune tx.
// Phase 2 : --confirm=SELL-OMO → swap signé localement + envoi + vérification.
// Gardes : pubkey dérivée == wallet pilote, CLUSTER=mainnet-beta, slippage 5 % max,
// jamais de log de la clé. Chemin SDK CJS (createRequire) — pattern de src/real.ts.
import { config } from "../src/config.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Keypair, PublicKey, Connection } = require("@solana/web3.js");
const { create } = require("@meteora-ag/dlmm");
const { BN } = require("bn.js");

const POOL = new PublicKey("3jD79NNgy7NZfNhAkMveq42rL8T3Ho1Mqtq1wmEt5W8K"); // omo-SOL
const OMO_MINT = new PublicKey("94Sm8joZMSRzpQmcNVn5zZpgnRLN2DBesJYDXwuNpump");
const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
const PILOT = "HE48NngQ46ZmgNMphNwEwxmLxK8D5gmcfd3bPqgeNoVk";
const SLIPPAGE_BPS = 500; // 5 % max (meme à liquidité fine)

const hasConfirm = process.argv.includes("--confirm=SELL-OMO");
const conn = new Connection(config.rpcUrl, "confirmed");

// --- Garde 1 : cluster mainnet ---
if (config.cluster !== "mainnet-beta") {
  console.error(`⛔ CLUSTER=${config.cluster} — la vente exige mainnet-beta.`);
  process.exit(1);
}

// --- Garde 2 : clé dérivée == wallet pilote ---
const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64"));
if (signer.publicKey.toBase58() !== PILOT) {
  console.error(`⛔ Clé dérivée ${signer.publicKey.toBase58()} ≠ wallet pilote ${PILOT} — abandon.`);
  process.exit(1);
}
console.log(`✓ Clé = wallet pilote (MATCH ${PILOT})`);

// --- Solde omo exact on-chain ---
const tokenAccounts = await conn.getTokenAccountsByOwner(signer.publicKey, { mint: OMO_MINT });
let omoRaw = 0n;
for (const ta of tokenAccounts.value) omoRaw += Buffer.from(ta.account.data).readBigUInt64LE(64);
if (omoRaw === 0n) {
  console.error("⛔ Aucun solde omo — rien à vendre.");
  process.exit(1);
}
const omoUi = Number(omoRaw) / 1e6;
console.log(`Solde omo on-chain : ${omoUi.toLocaleString("fr-FR")} tokens (${omoRaw} raw)`);

// --- Quote SDK (lecture seule) ---
const pool = await create(conn, POOL, { cluster: "mainnet-beta" });
const binArrays = await pool.getBinArrayForSwap(true, 8); // X→Y : omo en entrée
const quote = pool.swapQuote(new BN(omoRaw.toString()), true, new BN(SLIPPAGE_BPS), binArrays);
const outSol = Number(quote.outAmount.toString()) / 1e9;
const minSol = Number(quote.minOutAmount.toString()) / 1e9;
const impactPct = new (require("decimal.js"))(quote.priceImpact.toString()).mul(100).toFixed(2);
const feeSol = Number(quote.fee.toString()) / 1e9;
console.log(`--- QUOTE SDK (slippage ${SLIPPAGE_BPS} bps, pool direct) ---`);
console.log(`Vente : ${omoUi.toLocaleString("fr-FR")} omo → ${outSol.toFixed(4)} SOL (min garanti ${minSol.toFixed(4)})`);
console.log(`Prix : ${(outSol / omoUi).toFixed(9)} SOL/omo | impact prix : ${impactPct} % | fee : ${feeSol.toFixed(4)} SOL`);
console.log(`Prix de fin estimé : ${Number(quote.endPrice.toString())}`);
console.log(`Solde SOL estimé après : ${(9515410420 / 1e9 + outSol).toFixed(4)} SOL`);

if (!hasConfirm) {
  console.log("\nPhase QUOTE terminée — aucune tx envoyée.");
  console.log("Pour exécuter : npm run sell:omo -- --confirm=SELL-OMO");
  process.exit(0);
}

// --- Exécution ---
console.log("\n--- EXÉCUTION (confirmé) ---");
const tx = await pool.swap({
  inToken: OMO_MINT,
  outToken: SOL_MINT,
  inAmount: quote.consumedInAmount,
  minOutAmount: quote.minOutAmount,
  lbPair: POOL,
  user: signer.publicKey,
  binArraysPubkey: quote.binArraysPubkey,
});
tx.sign(signer);
const solBefore = (await conn.getBalance(signer.publicKey)) / 1e9;
const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
console.log(`Tx envoyée : ${sig}`);
const conf = await conn.confirmTransaction(sig, "confirmed");
console.log(`Confirmation : ${conf.value.err ? "ÉCHEC " + JSON.stringify(conf.value.err) : "OK"}`);
if (conf.value.err) process.exit(1);

// --- Vérification : 2 lectures indépendantes + sigs ---
await new Promise((r) => setTimeout(r, 3000));
const bal1 = (await conn.getBalance(signer.publicKey)) / 1e9;
const accounts2 = await conn.getTokenAccountsByOwner(signer.publicKey, { mint: OMO_MINT });
let omoLeft = 0n;
for (const ta of accounts2.value) omoLeft += Buffer.from(ta.account.data).readBigUInt64LE(64);
const bal2 = (await conn.getBalance(signer.publicKey)) / 1e9;
const sigs = await conn.getSignaturesForAddress(signer.publicKey, { limit: 3 });
console.log(`SOL avant : ${solBefore.toFixed(4)} → lecture1 ${bal1.toFixed(4)} → lecture2 ${bal2.toFixed(4)}`);
console.log(`omo restant : ${(Number(omoLeft) / 1e6).toFixed(2)} tokens`);
console.log(`Gain SOL net : ${(bal2 - solBefore).toFixed(4)} SOL`);
console.log(`Dernières sigs : ${sigs.map((s: any) => s.signature.slice(0, 8)).join(", ")}`);
