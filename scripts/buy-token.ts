// Achat de token X pour le pilote L4-B — wrapper CLI autour de src/swap.ts.
// QUOTE seule par défaut (aucune tx) ; envoi avec --confirm=BUY-TOKEN.
// Gardes : cluster mainnet, pubkey dérivée == wallet pilote.
//
// Usage :
//   npx tsx scripts/buy-token.ts --pool=<addr> --sol=<N>                 # QUOTE seule
//   REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE \
//     npx tsx scripts/buy-token.ts --pool=<addr> --sol=<N> --confirm=BUY-TOKEN  # ENVOIE
import { config } from "../src/config.js";
import { createRequire } from "node:module";
import { swapSolForToken, tokenBalanceOf } from "../src/swap.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Keypair, PublicKey, Connection } = require("@solana/web3.js") as any;

const DATA_API = "https://dlmm.datapi.meteora.ag";
const PILOT = config.walletAddress;
const SLIPPAGE_BPS = 500;

const args = process.argv.slice(2);
const poolAddr = args.find((a) => a.startsWith("--pool="))?.split("=")[1] ?? "";
const solIn = parseFloat(args.find((a) => a.startsWith("--sol="))?.split("=")[1] ?? "0");
const hasConfirm = args.includes("--confirm=BUY-TOKEN");

if (!poolAddr) {
  console.error("⛔ --pool=<addr> requis (adresse du pool DLMM token-SOL).");
  process.exit(1);
}
if (!(solIn > 0)) {
  console.error("⛔ --sol=<N> requis (montant de SOL à swapper en token).");
  process.exit(1);
}

// --- Garde 1 : cluster mainnet ---
if (config.cluster !== "mainnet-beta") {
  console.error(`⛔ CLUSTER=${config.cluster} — l'achat exige mainnet-beta.`);
  process.exit(1);
}

// --- Garde 2 : clé dérivée == wallet pilote ---
const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64"));
if (signer.publicKey.toBase58() !== PILOT) {
  console.error(`⛔ Clé dérivée ${signer.publicKey.toBase58()} ≠ wallet pilote ${PILOT} — abandon.`);
  process.exit(1);
}
console.log(`✓ Clé = wallet pilote (MATCH ${PILOT})`);

// --- Pool + mint token X (Data API, User-Agent obligatoire — 403 sinon) ---
const res = await fetch(`${DATA_API}/pools/${poolAddr}`, {
  headers: { "User-Agent": "Mozilla/5.0" },
  signal: AbortSignal.timeout(10_000),
});
if (!res.ok) {
  console.error(`⛔ Pool ${poolAddr} injoignable (HTTP ${res.status}).`);
  process.exit(1);
}
const poolMeta = (await res.json()) as {
  token_x?: { address: string; symbol?: string; decimals?: number };
  current_price?: number;
  name?: string;
};
const xMint = poolMeta.token_x?.address;
const xSymbol = poolMeta.token_x?.symbol ?? "X";
const xDecimals = poolMeta.token_x?.decimals ?? 9;
const price = Number(poolMeta.current_price ?? 0);
if (!xMint) {
  console.error(`⛔ token_x introuvable pour ${poolAddr}.`);
  process.exit(1);
}
console.log(`Pool ${poolAddr} : ${poolMeta.name ?? "?"} — prix ${price} SOL/${xSymbol}`);

const conn = new Connection(config.rpcUrl, "confirmed");
const solBal = await conn.getBalance(signer.publicKey);
if (solBal < BigInt(Math.floor(solIn * 1e9)) + 50_000_000n) {
  console.error(`⛔ Solde SOL ${(Number(solBal) / 1e9).toFixed(4)} — besoin ≈ ${solIn.toFixed(4)} + frais.`);
  process.exit(1);
}
console.log(`Solde SOL : ${(Number(solBal) / 1e9).toFixed(4)} — swap de ${solIn.toFixed(4)} SOL → ${xSymbol}`);

if (!hasConfirm) {
  console.log(`\nPhase QUOTE : lancer avec --confirm=BUY-TOKEN pour envoyer le swap.`);
  console.log(`  REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE npx tsx scripts/buy-token.ts --pool=${poolAddr} --sol=${solIn} --confirm=BUY-TOKEN`);
  process.exit(0);
}

// --- Exécution ---
console.log("\n--- EXÉCUTION (confirmé) ---");
const before = await tokenBalanceOf(conn, signer.publicKey, xMint);
const r = await swapSolForToken({ poolAddress: poolAddr, xMint, xDecimals, solAmount: solIn, slippageBps: SLIPPAGE_BPS });
await new Promise((res2) => setTimeout(res2, 3000));

// Vérification : 2 lectures indépendantes + sigs
const bal1 = (await conn.getBalance(signer.publicKey)) / 1e9;
const after = await tokenBalanceOf(conn, signer.publicKey, xMint);
const bal2 = (await conn.getBalance(signer.publicKey)) / 1e9;
const sigs = await conn.getSignaturesForAddress(signer.publicKey, { limit: 3 });
console.log(`✅ Swap OK — sig ${r.sig} (${r.outTokenUi.toLocaleString("fr-FR")} ${xSymbol} attendus)`);
console.log(`SOL : ${(Number(solBal) / 1e9).toFixed(4)} → lecture1 ${bal1.toFixed(4)} → lecture2 ${bal2.toFixed(4)}`);
console.log(`${xSymbol} : ${(Number(before) / 10 ** xDecimals).toLocaleString("fr-FR")} → ${(Number(after) / 10 ** xDecimals).toLocaleString("fr-FR")} (Δ ${(Number(after - before) / 10 ** xDecimals).toLocaleString("fr-FR")})`);
console.log(`Dernières sigs : ${sigs.map((s: any) => s.signature.slice(0, 8)).join(", ")}`);
if (after <= before) {
  console.error(`⛔ Solde ${xSymbol} inchangé après le swap — VÉRIFIER avant tout dépôt.`);
  process.exit(1);
}
