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
import { db, logEvent, isPilotInventoryPending } from "../src/db.js";
import { getTelegramCreds, sendTelegram } from "../src/telegram.js";
import { getSolPriceUsd } from "../src/export.js";

const require = createRequire(import.meta.url);
const { create: createPool } = require("@meteora-ag/dlmm") as any;
const { BN } = require("bn.js") as any;

const SOL_MINT = "So11111111111111111111111111111111111111112";
const DATA_API = "https://dlmm.datapi.meteora.ag";
const PILOT = config.walletAddress;
const dryRun = process.argv.includes("--dry-run");

// Log horodaté (audit 24/08) — le log cron sweep.log était illisible sans timestamp.
const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
const log = (...a: unknown[]) => console["log"](`[${ts()}]`, ...a);
const err = (...a: unknown[]) => console["error"](`[${ts()}]`, ...a);

db.exec(`CREATE TABLE IF NOT EXISTS residue_sweeps (
  token_key TEXT PRIMARY KEY,
  pool_address TEXT,
  last_swap_at INTEGER,
  last_value_usd REAL
)`);

if (config.cluster !== "mainnet-beta") {
  err("⛔ CLUSTER≠mainnet-beta — sweep annulé.");
  process.exit(1);
}
const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64"));
if (signer.publicKey.toBase58() !== PILOT) {
  err(`⛔ Clé ${signer.publicKey.toBase58()} ≠ wallet pilote ${PILOT} — abandon.`);
  process.exit(1);
}
const conn = new Connection(config.rpcUrl, "confirmed");
const solUsd = (await getSolPriceUsd()) ?? 93;
const minValueSol = config.residueSwapMinUsd / solUsd;

// 1) Carte mint → {pool, symbol} :
//    - closes récentes (48h) : les résidus de close viennent des positions fermées.
//    - positions OUVERTES (fix 2026-08-26, leçon GTA6) : un claim AUTO de fees
//      paie une partie en token_x (selon le sens des swaps) → ces tokens
//      atterrissent au WALLET alors que la position est toujours ouverte. Sans
//      cette extension, ils restaient « token inconnu » ignorés à vie (16 154
//      GTA6 ≈ 15,3$ bloqués après le claim du 26/08 16:07). Sûr : on ne swappe
//      QUE le solde du wallet (la liquidité vit dans le pool on-chain, jamais
//      dans le wallet — removeLiquidity est la seule voie de sortie).
//    Fetch du détail Data API (token_x.address) pour chaque pool.
const closedPools = (
  db.prepare(`SELECT DISTINCT pool_address, token_x_symbol FROM real_positions WHERE status='closed' AND closed_at > ?
UNION
SELECT DISTINCT pool_address, token_x_symbol FROM real_positions WHERE status='open'`).all(
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

// 1bis) Fallback pour les résidus ANCIENS (21/09) : les pools des positions
// closes < 48h ne couvrent pas un jeton qui dort depuis des semaines — reste
// d'inventaire pilote L4-B (HYPE 98sMhvDw, 9,12$ bloqués au 21/09) ou token
// reçu lors d'un swap de close old. Sans ce fallback ils restaient « token
// inconnu » à vie. `pilot_inventory` garde le mapping mint → pool de chaque
// achat L4-B : on le réutilise (additif : n'écrase aucun pool déjà trouvé).
const invPools = db
  .prepare(
    `SELECT DISTINCT mint, pool_address, symbol FROM pilot_inventory
     WHERE pool_address IS NOT NULL`
  )
  .all() as { mint: string; pool_address: string; symbol: string | null }[];
for (const r of invPools) {
  if (!mintMap.has(r.mint)) mintMap.set(r.mint, { pool: r.pool_address, symbol: r.symbol ?? "?" });
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
  log(`[sweep] ⚠️ scan programId échoué (${(e as Error).message}) — rattrapage par mint seul`);
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
      log(`[sweep] rattrapage mint ${mint.slice(0, 8)}… : ${ui.toLocaleString("fr-FR")} tokens (invisible au scan programId)`);
      walletTokens.push({ mint: info.mint, ui, decimals: Number(info.tokenAmount.decimals), raw: info.tokenAmount.amount });
    }
  } catch {
    /* compte indisponible — skip */
  }
}
if (walletTokens.length === 0) {
  log("[sweep] aucun token résiduel — rien à faire.");
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
    log(`[sweep] token inconnu (mint ${wt.mint.slice(0, 8)}…) — skip (pas de pool de close récent)`);
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
    log(`[sweep] ${entry.symbol} : ${wt.ui.toFixed(2)} tokens ≈ ${valueUsd.toFixed(2)}$ < seuil ${config.residueSwapMinUsd}$ — skip`);
    skippedLow++;
    continue;
  }
  const last = db.prepare(`SELECT last_swap_at FROM residue_sweeps WHERE token_key = ?`).get(tokenKey) as
    | { last_swap_at: number }
    | undefined;
  if (last && Date.now() - last.last_swap_at < config.residueSwapCooldownMin * 60_000) {
    log(`[sweep] ${entry.symbol} : cooldown actif — skip`);
    skippedCooldown++;
    continue;
  }
  // ⚠️ Garde pilote L4-B (2026-08-29) : un token acheté pour une position
  // pilote (inventaire EN ATTENTE de dépôt) n'est PAS un résidu à swapper —
  // le swap le transformerait en SOL et l'ouverture balancée échouerait
  // (l'inventaire vit au wallet entre l'achat et le dépôt).
  if (isPilotInventoryPending(wt.mint)) {
    log(`[sweep] ${entry.symbol} : inventaire pilote EN ATTENTE (L4-B) — skip`);
    skippedUnknown++;
    continue;
  }
  log(`[sweep] ${entry.symbol} : ${wt.ui.toLocaleString("fr-FR")} tokens ≈ ${valueUsd.toFixed(2)}$ (${valueSol.toFixed(3)} SOL) → swap sur ${entry.pool.slice(0, 8)}…`);
  if (dryRun) {
    log(`  [dry-run] AUCUNE tx envoyée.`);
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
    // Confirmation POLLING HTTP (leçon b267c0f, 27/08 — réappliquée 01/09 au
    // sweep) : confirmTransaction utilise la souscription ws interne de web3.js
    // → quand le tier ws Helius sature (429), elle expire à 30 s alors que la
    // tx passe on-chain → fausses alertes 🚨 "SWEEP ÉCHOUÉ" (4× en 2 j :
    // fone/REDACTED/MANLET/BULLSHIT, toutes passées). Polling getSignatureStatus
    // : 1,5 s. Timeout porté 60→120 s (go David 12/09) : réseau chargé = tx
    // confirmée après 60-90 s (ZCAT/BUTTHOLE/EMBER en 48 h, tous repassés au
    // tick suivant) — 120 s absorbe ces retards sans jamais doubler un swap
    // (le retry ne part QUE si cette boucle a levé, donc statut inconnu ≠ succès).
    const confDeadline = Date.now() + 120_000;
    let confStatus: { confirmationStatus?: string; err?: unknown } | null = null;
    for (;;) {
      const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
      confStatus = st?.value ?? null;
      if (confStatus?.err) throw new Error(`swap échoué on-chain: ${JSON.stringify(confStatus.err)}`);
      if (confStatus?.confirmationStatus === "confirmed" || confStatus?.confirmationStatus === "finalized") break;
      if (Date.now() > confDeadline) {
        throw new Error(
          `confirmation timeout 120s (sig ${sig.slice(0, 12)}… — dernier statut ${confStatus ? confStatus.confirmationStatus : "inconnu"})`
        );
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    await new Promise((r) => setTimeout(r, 2500));
    const bal1 = (await conn.getBalance(signer.publicKey)) / 1e9;
    const bal2 = (await conn.getBalance(signer.publicKey)) / 1e9;
    const gainSolRaw = Math.min(bal1, bal2) - solBefore;
    // Garde-fou 29/09 (leçon « +958$ fantômes » du 28) : le solde global peut bouger pour
    // d'autres raisons (claim parallèle, close concurrente, dépôt pilote) sur la fenêtre de
    // 2 s. On ne déclare un GAIN que si le delta correspond à la quote du swap (±30 %) ;
    // sinon le montant est marqué unverified et exclu des cumuls de gains.
    const expectedSol = Number(quote.outAmount.toString()) / 1e9;
    // ⚠️ Leçon 03/10 (+16 734 $ fantômes) : « plausible » ne suffisait PAS — deux faux
    // géants (41,86 et 41,89 SOL) ont passé ce test car ils mesuraient une OUVERTURE
    // concurrente. Double garde : (a) le delta doit être POSITIF, (b) l'écart vs quote
    // < 30 %, (c) le token balayé doit réellement avoir disparu du wallet.
    const tokAfterRaw = await conn.getTokenAccountsByOwner(signer.publicKey, { mint: new PublicKey(wt.mint) })
      .then((r: any) => r.value.reduce((a: bigint, x: any) => a + BigInt(x.account.data.parsed?.info?.tokenAmount?.amount ?? 0), 0n))
      .catch(() => 0n);
    const drained = tokAfterRaw === 0n || Number(tokAfterRaw) < Number(wt.raw) * 0.1;
    const plausible =
      expectedSol > 0 &&
      gainSolRaw > 0 &&
      Math.abs(gainSolRaw - expectedSol) / expectedSol < 0.3 &&
      drained;
    const gainSol = plausible ? gainSolRaw : 0;
    db.prepare(
      `INSERT INTO residue_sweeps (token_key, pool_address, last_swap_at, last_value_usd)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(token_key) DO UPDATE SET pool_address=excluded.pool_address, last_swap_at=excluded.last_swap_at, last_value_usd=excluded.last_value_usd`
    ).run(tokenKey, entry.pool, Date.now(), valueUsd);
    const msg = `✅ [${new Date().toLocaleTimeString("fr-FR")}] SWEEP ${entry.symbol} : ${wt.ui.toLocaleString("fr-FR")} tokens → +${gainSol.toFixed(4)} SOL (sig ${sig.slice(0, 12)}…) — gain réalisé en cash`;
    // payload machine-lisible (demandé David 24/09 pour « Gains nets du jour »
    // dans le récap) : gain_sol converti en $ au prix du tick.
    // ⚠️ Garde 03/10 (leçon « +16 734 $ fantômes ») : balayer un STABLE (USDC/USDT)
    // ne crée aucune richesse — c'est le capital rendu par une close qu'on convertit
    // en SOL. Ces montants doivent être exclus des « gains nets », sinon le capital
    // est recompté en profit à chaque cycle (ici ×16 sur la journée).
    const symSweep = String(entry.symbol ?? "").toUpperCase();
    const isStable = symSweep === "USDC" || symSweep === "USDT";
    logEvent("residue-sweep", msg, {
      poolAddress: entry.pool,
      payload: {
        gainSol: Number(gainSol.toFixed(6)),
        gainUsd: Number((gainSol * solUsd).toFixed(2)),
        symbol: entry.symbol,
        ...(isStable ? { kind: "conversion" } : {}),
        ...(plausible ? {} : { kind: "unverified", measuredSol: Number(gainSolRaw.toFixed(6)), expectedSol: Number(expectedSol.toFixed(6)) }),
      },
    });
    // Cumul journalier (récap « Gains nets du jour ») : upsert par jour LOCAL —
    // toISOString() est en UTC et décalait le compteur d'un soir à l'autre
    // (leçon 29/09 : le rapport affichait les sweeps de la veille).
    const d0 = new Date();
    const day = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, "0")}-${String(d0.getDate()).padStart(2, "0")}`;
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(meta.value AS REAL) + excluded.value AS TEXT)`
    ).run(`sweep_gains_usd:${day}`, (gainSol * solUsd).toFixed(2));
    const creds = getTelegramCreds();
    if (creds) await sendTelegram(creds.token, creds.chatId, msg);
    log(`  ✅ ${entry.symbol} → +${gainSol.toFixed(4)} SOL (${sig.slice(0, 12)}…)`);
    swapped++;
  } catch (e) {
    const errMsg = String(e).slice(0, 160);
    // Cooldown d'échec (leçon 8ecb484, 26/08) : sans lui, un swap qui échoue
    // (bug ou réseau) spammait 🚨 Telegram à CHAQUE run */15 — le cooldown de
    // succès (residue_sweeps.last_swap_at) ne couvre que les runs gagnants.
    const lastFail =
      (db
        .prepare(`SELECT MAX(created_at) AS at FROM events WHERE type='residue-sweep-fail' AND pool_address=?`)
        .get(entry.pool) as { at: number | null } | undefined)?.at ?? 0;
    if (Date.now() / 1000 - lastFail > config.residueSwapCooldownMin * 60) {
      const msg = `🚨 [${new Date().toLocaleTimeString("fr-FR")}] SWEEP ${entry.symbol} ÉCHOUÉ : ${errMsg} — swap manuel possible (sell:omo pattern)`;
      logEvent("residue-sweep-fail", msg, { poolAddress: entry.pool });
      const creds = getTelegramCreds();
      if (creds) await sendTelegram(creds.token, creds.chatId, msg);
    } else {
      log(`  ⏳ ${entry.symbol} échec récent — pas de re-notif (cooldown ${config.residueSwapCooldownMin} min)`);
    }
    err(`  🚨 ${entry.symbol} échec : ${errMsg}`);
  }
}
log(`[sweep] terminé — ${swapped} swap(s), ${skippedLow} sous seuil, ${skippedCooldown} cooldown, ${skippedUnknown} inconnu(s)${dryRun ? " (DRY-RUN)" : ""}`);
