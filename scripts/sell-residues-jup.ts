// Vente des résidus du wallet SANS pool Meteora connu (fallback Jupiter).
// Complément de scripts/sweep-residues.ts : celui-ci ne sait swapper que via un
// pool DLMM rattaché à une position (close < 48h ou open) ou à l'inventaire
// pilote — les jetons reçus autrement (ex. 5UUH9RTD… 8,32$ au 21/09, 2e plus
// gros résidu dormant) restaient « token inconnu » à vie. Jupiter a un routage
// sur ces mints, avec un impact ~0 %.
//
// Usage :
//   npx tsx scripts/sell-residues-jup.ts                      # phase QUOTE seule (défaut)
//   npx tsx scripts/sell-residues-jup.ts --confirm=SELL-RESIDUES   # swap réel
//   options : --min-usd=0.05 (plancher), --slippage-bps=500 (5 % max)
//
// Gardes : cluster mainnet-beta, clé dérivée == wallet pilote, inventaire pilote
// L4-B en attente jamais vendu, cooldown 30 min via residue_sweeps, refus si
// l'impact prix Jupiter dépasse max(3 %, --max-impact), simulation avant envoi,
// never log de la clé. Chaque swap réussi est tracé (residue_sweeps + events +
// Telegram) exactement comme le sweep Meteora, pour que le rapport quotidien et
// le récap le voient.
import { config } from "../src/config.js";
import { db, logEvent, isPilotInventoryPending } from "../src/db.js";
import { getTelegramCreds, sendTelegram } from "../src/telegram.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Keypair, PublicKey, Connection, VersionedTransaction } = require("@solana/web3.js") as any;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const JUP = "https://lite-api.jup.ag/swap/v1";
const UA = { "User-Agent": "Mozilla/5.0" };

const arg = (name: string, def: number) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? Number(a.split("=")[1]) : def;
};
const confirmed = process.argv.includes("--confirm=SELL-RESIDUES");
const minUsd = arg("min-usd", 0.05);
const slippageBps = arg("slippage-bps", 500);
const maxImpactPct = arg("max-impact", 3);
const cooldownMin = 30;

const log = (m: string) => console.log(`[${new Date().toLocaleTimeString("fr-FR")}] [jup-sweep] ${m}`);

// --- Garde 1 : cluster mainnet ---
if (config.cluster !== "mainnet-beta") {
  console.error(`⛔ CLUSTER=${config.cluster} — la vente exige mainnet-beta.`);
  process.exit(1);
}
// --- Garde 2 : clé dérivée == wallet pilote (jamais loggée) ---
const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64"));
if (signer.publicKey.toBase58() !== config.walletAddress) {
  console.error("⛔ La clé dérivée ne correspond pas au wallet pilote — abandon.");
  process.exit(1);
}
console.log(`✓ wallet pilote OK · mode ${confirmed ? "CONFIRMÉ (tx réelles)" : "QUOTE seule (aucune tx)"}`);

const conn = new Connection(config.rpcUrl, "confirmed");
const wallet = signer.publicKey as any;

// --- Inventaire des jetons du wallet ---
const parsed = await conn.getParsedTokenAccountsByOwner(wallet, {
  programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"),
});
const holdings: { mint: string; ui: number; raw: string; dec: number }[] = [];
for (const { account } of parsed.value) {
  const info = account.data?.parsed?.info;
  const ui = Number(info?.tokenAmount?.uiAmount ?? 0);
  if (!info || ui <= 0 || info.mint === SOL_MINT) continue;
  holdings.push({ mint: info.mint, ui, raw: info.tokenAmount.amount, dec: Number(info.tokenAmount.decimals) });
}
if (!holdings.length) {
  log("aucun jeton au wallet — rien à vendre.");
  process.exit(0);
}

// Prix USD (Jupiter) pour trier et ne payer des frais que sur ce qui vaut le coup.
const prices: Record<string, { usdPrice?: number }> = await fetch(
  `${JUP.replace("/swap/v1", "/price/v3")}?ids=${holdings.map((h) => h.mint).join(",")}`,
  { headers: UA, signal: AbortSignal.timeout(15000) }
)
  .then((r) => (r.ok ? r.json() : {}))
  .catch(() => ({}));

let sold = 0;
let skipped = 0;
for (const h of holdings) {
  const usd = h.ui * Number(prices[h.mint]?.usdPrice ?? 0);
  const label = h.mint.slice(0, 8);
  if (usd < minUsd) {
    log(`${label}… : ${usd.toFixed(2)}$ < plancher ${minUsd}$ — skip`);
    skipped++;
    continue;
  }
  if (isPilotInventoryPending(h.mint)) {
    log(`${label}… : inventaire pilote L4-B EN ATTENTE — skip (le swap casserait l'ouverture balancée)`);
    skipped++;
    continue;
  }
  const prev = db.prepare(`SELECT last_swap_at FROM residue_sweeps WHERE token_key = ?`).get(`jup-${label}`) as
    | { last_swap_at: number }
    | undefined;
  if (prev && Date.now() - prev.last_swap_at < cooldownMin * 60_000) {
    log(`${label}… : cooldown ${cooldownMin} min actif — skip`);
    skipped++;
    continue;
  }

  // --- Quote ---
  let quote: any;
  try {
    const qr = await fetch(
      `${JUP}/quote?inputMint=${h.mint}&outputMint=${SOL_MINT}&amount=${h.raw}&slippageBps=${slippageBps}&restrictIntermediateTokens=true`,
      { headers: UA, signal: AbortSignal.timeout(15000) }
    );
    if (!qr.ok) {
      log(`${label}… : pas de route Jupiter (HTTP ${qr.status}) — skip`);
      skipped++;
      continue;
    }
    quote = await qr.json();
  } catch (e) {
    log(`${label}… : quote en échec (${(e as Error).message}) — skip`);
    skipped++;
    continue;
  }
  const outSol = Number(quote.outAmount) / 1e9;
  const impact = Number(quote.priceImpactPct) * 100;
  log(`${label}… : ${h.ui.toLocaleString("fr-FR")} tokens ≈ ${usd.toFixed(2)}$ → ${outSol.toFixed(5)} SOL (impact ${impact.toFixed(3)}%)`);
  if (impact > maxImpactPct) {
    log(`  ⛔ impact ${impact.toFixed(2)}% > ${maxImpactPct}% — swap refusé (on ne brade pas)`);
    skipped++;
    continue;
  }
  if (!confirmed) {
    log("  [quote seule] aucune signature, aucune tx.");
    continue;
  }

  // --- Swap réel ---
  try {
    const sr = await fetch(`${JUP}/swap`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...UA },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: signer.publicKey.toBase58(),
        wrapAndUnwrapSol: true,
        dynamicComputeUnitLimit: true,
      }),
      signal: AbortSignal.timeout(20000),
    });
    if (!sr.ok) throw new Error(`/swap HTTP ${sr.status} : ${(await sr.text()).slice(0, 200)}`);
    const body = (await sr.json()) as { swapTransaction: string };
    const tx = VersionedTransaction.deserialize(Buffer.from(body.swapTransaction, "base64"));
    // Garde : la tx doit être payée par NOTRE wallet (une tx tierce serait refusée).
    if (tx.message.staticAccountKeys[0].toBase58() !== signer.publicKey.toBase58()) {
      throw new Error("feePayer de la tx Jupiter ≠ wallet pilote — abandon");
    }
    const sim = await conn.simulateTransaction(tx, { replaceRecentBlockhash: true });
    if (sim.value.err) throw new Error(`simulation en échec : ${JSON.stringify(sim.value.err)}`);

    const solBefore = (await conn.getBalance(wallet)) / 1e9;
    tx.sign([signer]);
    const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 3 });

    let st: any = null;
    const deadline = Date.now() + 120_000;
    for (;;) {
      const s = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
      st = s?.value ?? null;
      if (st?.err) throw new Error(`swap échoué on-chain : ${JSON.stringify(st.err)}`);
      if (st?.confirmationStatus === "confirmed" || st?.confirmationStatus === "finalized") break;
      if (Date.now() > deadline) throw new Error(`confirmation timeout 120 s (sig ${String(sig).slice(0, 12)}…)`);
      await new Promise((r) => setTimeout(r, 1500));
    }
    await new Promise((r) => setTimeout(r, 2500));
    const b1 = (await conn.getBalance(wallet)) / 1e9;
    const b2 = (await conn.getBalance(wallet)) / 1e9;
    const gain = Math.min(b1, b2) - solBefore;

    db.prepare(
      `INSERT INTO residue_sweeps (token_key, pool_address, last_swap_at, last_value_usd)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(token_key) DO UPDATE SET pool_address=excluded.pool_address,
         last_swap_at=excluded.last_swap_at, last_value_usd=excluded.last_value_usd`
    ).run(`jup-${label}`, "jupiter", Date.now(), usd);
    const msg = `✅ [${new Date().toLocaleTimeString("fr-FR")}] SWEEP JUP ${label}… : ${h.ui.toLocaleString("fr-FR")} tokens → +${gain.toFixed(4)} SOL (sig ${String(sig).slice(0, 12)}…) — gain réalisé en cash`;
    logEvent("residue-sweep", msg, {});
    const creds = getTelegramCreds();
    if (creds) await sendTelegram(creds.token, creds.chatId, msg);
    log(`  ✅ +${gain.toFixed(4)} SOL (sig ${String(sig).slice(0, 12)}…)`);
    sold++;
  } catch (e) {
    const errMsg = (e as Error).message.slice(0, 200);
    log(`  🚨 échec : ${errMsg}`);
    db.prepare(
      `INSERT INTO residue_sweeps (token_key, pool_address, last_swap_at, last_value_usd)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(token_key) DO UPDATE SET last_swap_at=excluded.last_swap_at`
    ).run(`jup-${label}`, "jupiter", Date.now(), usd);
    logEvent("residue-sweep-fail", `🚨 SWEEP JUP ${label}… ÉCHOUÉ : ${errMsg}`, {});
  }
}
log(`terminé — ${sold} swap(s), ${skipped} skip${confirmed ? "" : " (quote seule)"}`);
