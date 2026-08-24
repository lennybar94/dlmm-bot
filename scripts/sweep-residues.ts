// Sweep des résidus token → SOL (leçon omo 2026-08-24 : le gain marqué n'est
// réalisé qu'en cash — un résidu token peut dumper -41% en une nuit).
// Scan les comptes token du wallet pilote (hors SOL) ; pour chaque token issu
// d'un close récent (48h), si la valeur ≥ RESIDUE_SWAP_MIN_USD, swap → SOL via
// le pool direct (SDK, comme sell-omo.ts), slippage plafonné, minOut garanti,
// cooldown par token. Notif Telegram ✅/🚨 (mandataire : argent réel).
// Gardes : cluster mainnet, clé == wallet pilote, JAMAIS le SOL, JAMAIS les
// positions ouvertes (leur liquidité vit dans le pool, pas le wallet).
// Usage : npm run sweep:residues [-- --dry-run]
import { Keypair, PublicKey, Connection } from "@solana/web3.js";
import { createRequire } from "node:module";
import { config } from "../src/config.js";
import { db, logEvent } from "../src/db.js";
import { getTelegramCreds, sendTelegram } from "../src/telegram.js";
import { getSolPriceUsd } from "../src/export.js";

const require = createRequire(import.meta.url);
const { create: createPool } = require("@meteora-ag/dlmm") as any;
const { BN } = require("bn.js") as any;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const DATA_API = "https://dlmm.datapi.meteora.ag";
const PILOT = "HE48NngQ46ZmgNMphNwEwxmLxK8D5gmcfd3bPqgeNoVk";
const dryRun = process.argv.includes("--dry-run");

db.exec(`CREATE TABLE IF NOT EXISTS residue_sweeps (
  token_key TEXT PRIMARY KEY,
  pool_address TEXT,
  last_swap_at INTEGER,
  last_value_usd REAL
)`);

if (config.cluster !== "mainnet-beta") {
  console.error("⛔ CLUSTER≠mainnet-beta — sweep annulé.");
  process.exit(1);
}
const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64"));
if (signer.publicKey.toBase58() !== PILOT) {
  console.error(`⛔ Clé ${signer.publicKey.toBase58()} ≠ wallet pilote ${PILOT} — abandon.`);
  process.exit(1);
}
const conn = new Connection(config.rpcUrl, "confirmed");
const solUsd = (await getSolPriceUsd()) ?? 93;
const minValueSol = config.residueSwapMinUsd / solUsd;

// 1) Carte mint → {pool, symbol} depuis les closes récentes (48h) : les résidus
// viennent des positions fermées. Fetch du détail Data API (token_x.address).
const closedPools = (
  db.prepare(`SELECT DISTINCT pool_address, token_x_symbol FROM real_positions WHERE status='closed' AND closed_at > ?`).all(
    Date.now() - 48 * 3_600_000
  ) as { pool_address: string; token_x_symbol: string | null }[]
);
const mintMap = new Map<string, { pool: string; symbol: string }>();
for (const cp of closedPools) {
  try {
    const res = await fetch(`${DATA_API}/pools/${cp.pool_address}`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) continue;
    const pool = (await res.json()) as any;
    const xMint = pool.token_x?.address;
    if (xMint) mintMap.set(xMint, { pool: cp.pool_address, symbol: cp.token_x_symbol ?? pool.token_x?.symbol ?? "?" });
  } catch {
    /* pool indisponible — skip */
  }
}

// 2) Tokens du wallet (hors SOL) avec solde > 0.
// ⚠️ PIÈGE INDEX RPC (découvert 24/08, LOOKSMAX) : getParsedTokenAccountsByOwner
// filtré par programId RATE les comptes token créés récemment — l'ATA LOOKSMAX
// créée par le close du 24/08 14:00 n'est jamais remontée par l'index (le filtre
// par mint, lui, la trouve) → résidu jamais swappé (25 821 LOOKSMAX bloqués).
// → scan programId + RATTRAPAGE systématique par mint pour chaque pool fermé
// < 48h (déterministe, zéro dépendance à l'index).
const walletTokens: { mint: string; ui: number; decimals: number; raw: string }[] = [];
const seenMints = new Set<string>();
try {
  const parsed = await conn.getParsedTokenAccountsByOwner(signer.publicKey, {
    programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
  });
  for (const ta of parsed.value) {
    const info = (ta.account.data as any).parsed?.info;
    if (!info) continue;
    if (info.mint === SOL_MINT) continue;
    const ui = Number(info.tokenAmount?.uiAmount ?? 0);
    if (ui <= 0) continue;
    seenMints.add(info.mint);
    walletTokens.push({ mint: info.mint, ui, decimals: Number(info.tokenAmount.decimals), raw: info.tokenAmount.amount });
  }
} catch (e) {
  console.log(`[sweep] ⚠️ scan programId échoué (${(e as Error).message}) — rattrapage par mint seul`);
}
for (const [mint] of mintMap) {
  if (seenMints.has(mint)) continue;
  try {
    const byMint = await conn.getParsedTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(mint) });
    for (const ta of byMint.value) {
      const info = (ta.account.data as any).parsed?.info;
      if (!info || info.mint === SOL_MINT) continue;
      const ui = Number(info.tokenAmount?.uiAmount ?? 0);
      if (ui <= 0) continue;
      console.log(`[sweep] rattrapage mint ${mint.slice(0, 8)}… : ${ui.toLocaleString("fr-FR")} tokens (invisible au scan programId)`);
      walletTokens.push({ mint: info.mint, ui, decimals: Number(info.tokenAmount.decimals), raw: info.tokenAmount.amount });
    }
  } catch {
    /* compte indisponible — skip */
  }
}
if (walletTokens.length === 0) {
  console.log("[sweep] aucun token résiduel — rien à faire.");
  process.exit(0);
}

// 3) Pour chaque token du wallet : valeur + cooldown + swap
let swapped = 0;
let skippedLow = 0;
let skippedCooldown = 0;
let skippedUnknown = 0;
for (const wt of walletTokens) {
  const entry = mintMap.get(wt.mint);
  if (!entry) {
    console.log(`[sweep] token inconnu (mint ${wt.mint.slice(0, 8)}…) — skip (pas de pool de close récent)`);
    skippedUnknown++;
    continue;
  }
  const poolRes = await fetch(`${DATA_API}/pools/${entry.pool}`, { signal: AbortSignal.timeout(10_000) }).catch(() => null);
  if (!poolRes || !poolRes.ok) continue;
  const pool = (await poolRes.json()) as any;
  const price = Number(pool.current_price ?? 0);
  if (!price) continue;
  const valueSol = wt.ui * price;
  const valueUsd = valueSol * solUsd;
  const tokenKey = entry.symbol.toLowerCase();

  if (valueUsd < config.residueSwapMinUsd) {
    console.log(`[sweep] ${entry.symbol} : ${wt.ui.toFixed(2)} tokens ≈ ${valueUsd.toFixed(2)}$ < seuil ${config.residueSwapMinUsd}$ — skip`);
    skippedLow++;
    continue;
  }
  const last = db.prepare(`SELECT last_swap_at FROM residue_sweeps WHERE token_key = ?`).get(tokenKey) as
    | { last_swap_at: number }
    | undefined;
  if (last && Date.now() - last.last_swap_at < config.residueSwapCooldownMin * 60_000) {
    console.log(`[sweep] ${entry.symbol} : cooldown actif — skip`);
    skippedCooldown++;
    continue;
  }
  console.log(`[sweep] ${entry.symbol} : ${wt.ui.toLocaleString("fr-FR")} tokens ≈ ${valueUsd.toFixed(2)}$ (${valueSol.toFixed(3)} SOL) → swap sur ${entry.pool.slice(0, 8)}…`);
  if (dryRun) {
    console.log(`  [dry-run] AUCUNE tx envoyée.`);
    continue;
  }

  try {
    const dlmm = await createPool(conn, new PublicKey(entry.pool), { cluster: "mainnet-beta" });
    const binArrays = await dlmm.getBinArrayForSwap(true, 8); // X→Y (token→SOL)
    const quote = dlmm.swapQuote(new BN(wt.raw), true, new BN(config.residueSwapSlippageBps), binArrays);
    const tx = await dlmm.swap({
      inToken: new PublicKey(wt.mint),
      outToken: new PublicKey(SOL_MINT),
      inAmount: quote.consumedInAmount,
      minOutAmount: quote.minOutAmount,
      lbPair: new PublicKey(entry.pool),
      user: signer.publicKey,
      binArraysPubkey: quote.binArraysPubkey,
    });
    tx.sign(signer);
    const solBefore = (await conn.getBalance(signer.publicKey)) / 1e9;
    const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
    const conf = await conn.confirmTransaction(sig, "confirmed");
    if (conf.value.err) throw new Error(JSON.stringify(conf.value.err));
    await new Promise((r) => setTimeout(r, 2500));
    const bal1 = (await conn.getBalance(signer.publicKey)) / 1e9;
    const bal2 = (await conn.getBalance(signer.publicKey)) / 1e9;
    const gainSol = Math.min(bal1, bal2) - solBefore;
    db.prepare(
      `INSERT INTO residue_sweeps (token_key, pool_address, last_swap_at, last_value_usd)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(token_key) DO UPDATE SET pool_address=excluded.pool_address, last_swap_at=excluded.last_swap_at, last_value_usd=excluded.last_value_usd`
    ).run(tokenKey, entry.pool, Date.now(), valueUsd);
    const msg = `✅ [${new Date().toLocaleTimeString("fr-FR")}] SWEEP ${entry.symbol} : ${wt.ui.toLocaleString("fr-FR")} tokens → +${gainSol.toFixed(4)} SOL (sig ${sig.slice(0, 12)}…) — gain réalisé en cash`;
    logEvent("residue-sweep", msg, { poolAddress: entry.pool });
    const creds = getTelegramCreds();
    if (creds) await sendTelegram(creds.token, creds.chatId, msg);
    console.log(`  ✅ ${entry.symbol} → +${gainSol.toFixed(4)} SOL (${sig.slice(0, 12)}…)`);
    swapped++;
  } catch (e) {
    const err = String(e).slice(0, 160);
    const msg = `🚨 [${new Date().toLocaleTimeString("fr-FR")}] SWEEP ${entry.symbol} ÉCHOUÉ : ${err} — swap manuel possible (sell:omo pattern)`;
    logEvent("residue-sweep-fail", msg, { poolAddress: entry.pool });
    const creds = getTelegramCreds();
    if (creds) await sendTelegram(creds.token, creds.chatId, msg);
    console.error(`  🚨 ${entry.symbol} échec : ${err}`);
  }
}
console.log(`[sweep] terminé — ${swapped} swap(s), ${skippedLow} sous seuil, ${skippedCooldown} cooldown, ${skippedUnknown} inconnu(s)${dryRun ? " (DRY-RUN)" : ""}`);
