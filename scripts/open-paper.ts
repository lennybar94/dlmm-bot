// Ouvre des positions paper sur les meilleures opportunités du dernier scan.
// Usage : `npm run open:paper` (top MAX_POSITIONS) ou `--limit N` / `--strategy spot-wide`
// Mode RÉEL (REAL_MODE=true dans .env) : ouvre de vraies positions via src/real.ts
// et les enregistre dans real_positions (pilote — surveillance manuelle des exits).
import { db, isTokenBlacklisted } from "../src/db.js";
import { config } from "../src/config.js";
import { runScan } from "../src/scanner.js";
import { openPaperPosition, getOpenPositions, estimateYUsd } from "../src/paper.js";
import { depositForPool } from "../src/strategies.js";
import { realOpenPosition } from "../src/real.js";
import { Connection, Keypair } from "@solana/web3.js";

// Wallet pilote du bot (garde de clé — le .env doit porter CETTE clé).
const PILOT = "HE48NngQ46ZmgNMphNwEwxmLxK8D5gmcfd3bPqgeNoVk";

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : config.maxPositions;

const openPositions = getOpenPositions();
const openAddresses = new Set(openPositions.map((p) => p.pool_address));
// Cap de diversification par token : max 1 position par token (les pools du même
// token — ex. 3× ANSEM-SOL — sont corrélés, zap-out groupé = chart cassé).
const openTokens = new Set(openPositions.map((p) => p.token_x_symbol?.toLowerCase() ?? p.name));
const openStrategies = new Map<string, number>();
for (const p of openPositions)
  openStrategies.set(p.strategy, (openStrategies.get(p.strategy) ?? 0) + 1);
// Cap de slots pour le playbook top blast (satsmonkes, ex-quick-inout Tikz) :
// la stratégie spike ne doit pas cannibaliser le book — le reste du capital va
// aux fee printers / bidask-dip (le cœur).
let topblastSlots = Math.max(0, config.maxTopblastPositions - (openStrategies.get("topblast") ?? 0));
const slots = Math.max(0, config.maxPositions - openPositions.length);
if (slots <= 0) {
  console.log(`Portefeuille plein (${openPositions.length}/${config.maxPositions} positions) — rien à ouvrir.`);
  process.exit(0);
}

const scan = await runScan();
let opened = 0;
let skippedSameToken = 0;
let skippedTopblastCap = 0;
let skippedBlacklisted = 0;
let skippedNotYOnly = 0;
let skippedSoldeGuard = 0;

// Contexte RÉEL créé une seule fois (garde de clé + solde).
let realCtx: { connection: Connection; signer: Keypair } | null = null;
if (config.realMode) {
  realCtx = {
    connection: new Connection(config.rpcUrl, "confirmed"),
    signer: Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64")),
  };
  if (realCtx.signer.publicKey.toBase58() !== PILOT) {
    console.error(`⛔ Clé ${realCtx.signer.publicKey.toBase58()} ≠ wallet pilote ${PILOT} — abandon.`);
    process.exit(1);
  }
  console.log(`✓ Mode RÉEL : wallet pilote ${PILOT} (garde clé OK)`);
}
for (const opp of scan.opportunities) {
  if (opened >= Math.min(limit, slots)) break;
  if (openAddresses.has(opp.pool.address)) continue;
  const tokenKey = opp.pool.token_x.symbol?.toLowerCase() ?? opp.pool.name;
  if (openTokens.has(tokenKey)) {
    skippedSameToken++;
    continue;
  }
  // Blacklist post-close (playbook gud, 2026-08-24) : « dead chart = dead
  // position » — token fermé avec volume 24h < seuil → pas de ré-entrée
  // pendant POST_CLOSE_BLACKLIST_HOURS (leçon omo : 6 ré-ouvertures).
  if (isTokenBlacklisted(tokenKey)) {
    skippedBlacklisted++;
    continue;
  }
  if (opp.strategyHint.strategy === "topblast") {
    if (topblastSlots <= 0) {
      skippedTopblastCap++;
      continue;
    }
    topblastSlots--;
  }
  if (config.realMode) {
    // ---- RÉGIME MACHINE RÉELLE : ouverture réelle + enregistrement local ----
    // Filtre Y-only SOL : le wallet ne détient que du SOL — une position
    // balancée (spot/curve) exigerait des jetons absents → tx en échec
    // (leçon 22/08 : TRUMP-USDC). Seules bidask-dip/topblast (oneSided y).
    const ySym = (opp.pool.token_y.symbol ?? "").toUpperCase();
    const yOnlyOk =
      (ySym === "SOL" || ySym === "WSOL") &&
      (opp.strategyHint.strategy === "bidask-dip" || opp.strategyHint.strategy === "topblast");
    if (!yOnlyOk) {
      skippedNotYOnly++;
      continue;
    }
    const dep = depositForPool(opp.pool);
    // Garde de solde : déployé + projeté ≤ REAL_MAX_DEPLOY_RATIO × solde —
    // le cron open:paper ne peut pas sur-déployer le wallet (régime machine).
    const depositY = dep / estimateYUsd(opp.pool);
    const balance = (await realCtx!.connection.getBalance(realCtx!.signer.publicKey)) / 1e9;
    const deployed = (
      db.prepare(`SELECT COALESCE(SUM(amount_y),0) s FROM real_positions WHERE status='open'`).get() as {
        s: number;
      }
    ).s;
    const maxDeploy = balance * config.realMaxDeployRatio;
    if (deployed + depositY > maxDeploy) {
      skippedSoldeGuard++;
      console.log(
        `  ⛔ ${opp.pool.name} : ${depositY.toFixed(2)} SOL projetés → déployé ${deployed.toFixed(2)} + ${depositY.toFixed(2)} > ${maxDeploy.toFixed(2)} (${(config.realMaxDeployRatio * 100).toFixed(0)}% de ${balance.toFixed(2)} SOL) — skip`
      );
      continue;
    }
    const r = await realOpenPosition(opp, dep);
    db.prepare(
      `INSERT INTO real_positions
       (opened_at, pool_address, name, strategy, deposit_usd, position_pubkey, sig,
        min_bin_id, max_bin_id, bin_step, entry_price, token_x_symbol, token_y_symbol,
        amount_x, amount_y, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
    ).run(
      Date.now(), opp.pool.address, opp.pool.name, opp.strategyHint.strategy, dep,
      r.positionPubkey, r.sig, r.minBinId, r.maxBinId, opp.pool.bin_step, r.entryPrice,
      opp.pool.token_x.symbol ?? null, opp.pool.token_y.symbol ?? null, r.amountX, r.amountY
    );
    console.log(
      `  Ouvert RÉEL #${r.positionPubkey.slice(0, 8)}: ${opp.pool.name} — ${opp.strategyHint.strategy} ` +
        `(dep ${dep.toFixed(0)}$ · sig ${r.sig.slice(0, 10)}…)`
    );
  } else {
    const r = openPaperPosition(opp);
    console.log(`  Ouvert #${r.positionId}: ${opp.pool.name} — ${opp.strategyHint.strategy} (score ${opp.score.toFixed(1)})`);
  }
  openAddresses.add(opp.pool.address);
  openTokens.add(tokenKey);
  opened++;
}
console.log(
  `Terminé : ${opened} position(s) ouverte(s)` +
    `${skippedSameToken ? ` (${skippedSameToken} pool(s) sauté(s) : token déjà en portefeuille)` : ""}` +
    `${skippedTopblastCap ? ` (${skippedTopblastCap} top blast sauté(s) : cap ${config.maxTopblastPositions} atteint)` : ""}` +
    `${skippedBlacklisted ? ` (${skippedBlacklisted} token(s) blacklisté(s) post-close)` : ""}` +
    `${skippedNotYOnly ? ` (${skippedNotYOnly} non Y-only SOL ignoré(s))` : ""}` +
    `${skippedSoldeGuard ? ` (${skippedSoldeGuard} skip garde de solde)` : ""}.`
);

// Petit état du portefeuille
const summary = db
  .prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(deposit_usd),0) inv, COALESCE(SUM(last_value_usd),0) val
     FROM paper_positions WHERE status='open'`
  )
  .get() as { n: number; inv: number; val: number };
console.log(`Portefeuille : ${summary.n} positions, ${summary.inv.toFixed(0)}$ investis, ${summary.val.toFixed(0)}$ de valeur.`);
