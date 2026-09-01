// Ouvre des positions paper sur les meilleures opportunités du DERNIER SCAN.
// Usage : `npm run open:paper` (top MAX_POSITIONS) ou `--limit N`.
// Mode RÉEL (REAL_MODE=true dans .env) : ouvre de vraies positions via src/real.ts
// et les enregistre dans real_positions (régime machine réelle — exits auto).
// ⚠️ Depuis l'audit 2026-08-25 (post Nowload) : lit le dernier scan en base
// (pool_scans, écrit */5 par le monitor) au lieu de re-scanner — le cron
// horaire à :07 ratait les fenêtres de spike qui durent des minutes.
import { db, isTokenBlacklisted } from "../src/db.js";
import { config } from "../src/config.js";
import { fetchPool } from "../src/api.js";
import { openPaperPosition, getOpenPositions, estimateYUsd } from "../src/paper.js";
import { depositForPool } from "../src/strategies.js";
import { realOpenPosition } from "../src/real.js";
import type { OpportunityScore, PaperPositionRow, StrategyHint } from "../src/types.js";
import { Connection, Keypair } from "@solana/web3.js";

// Wallet pilote du bot (garde de clé — le .env doit porter CETTE clé).
const PILOT = "HE48NngQ46ZmgNMphNwEwxmLxK8D5gmcfd3bPqgeNoVk";

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : config.maxPositions;

// ⚠️ Dédoublage par token / adresse / stratégie : en mode RÉEL, les positions
// ouvertes vivent dans real_positions. Lire paper_positions (VIDE en régime
// machine réelle — l'open:paper ouvre du réel) désactivait SILENCIEUSEMENT
// MAX_POSITIONS_PER_TOKEN (leçon ANSEM : 3 pools du même token = risque
// corrélé zap-out) et le cap de slots spike pour les ouvertures réelles (bug
// de croisement de filtres trouvé à l'audit 2026-08-25, post Nowload — le
// cron aurait pu ouvrir une 2e position réelle sur un token déjà en
// portefeuille).
const openPositions = (config.realMode
  ? db.prepare(`SELECT * FROM real_positions WHERE status = 'open'`).all()
  : getOpenPositions()) as unknown as PaperPositionRow[];
const openAddresses = new Set(openPositions.map((p) => p.pool_address));
// Cap de diversification par token : max 1 position par token (les pools du même
// token — ex. 3× ANSEM-SOL — sont corrélés, zap-out groupé = chart cassé).
const openTokens = new Set(openPositions.map((p) => p.token_x_symbol?.toLowerCase() ?? p.name));
const openStrategies = new Map<string, number>();
for (const p of openPositions)
  openStrategies.set(p.strategy, (openStrategies.get(p.strategy) ?? 0) + 1);
// Cap de slots pour les playbooks spike (topblast satsmonkes + résurrection
// Nowload — même famille « fast in fast out ») : les stratégies twitchy ne
// doivent pas cannibaliser le book — le reste du capital va aux fee printers
// / bidask-dip (le cœur).
let topblastSlots = Math.max(
  0,
  config.maxTopblastPositions -
    (openStrategies.get("topblast") ?? 0) -
    (openStrategies.get("resurrect") ?? 0)
);
const slots = Math.max(0, config.maxPositions - openPositions.length);
if (slots <= 0) {
  console.log(`Portefeuille plein (${openPositions.length}/${config.maxPositions} positions) — rien à ouvrir.`);
  process.exit(0);
}

// Ouverture depuis le DERNIER SCAN (pool_scans — écrit */5 par le monitor) au
// lieu de re-scanner : le cron horaire à :07 ratait les fenêtres de spike qui
// durent des MINUTES (« the opportunity window is short, sometimes a few
// minutes, sometimes only a few seconds » — Nowload 2026-08-25). Gardes :
// scan frais ≤ OPEN_MAX_SCAN_AGE_MIN ; pour les stratégies spike
// (topblast/resurrect) le vol 30m est REVÉRIFIÉ sur le détail API au moment
// d'ouvrir — pas d'entrée zombie sur un spike mort.
const lastScanAt = (
  db.prepare("SELECT MAX(scanned_at) AS m FROM pool_scans").get() as { m: number | null }
).m;
if (!lastScanAt || Date.now() - lastScanAt > config.openMaxScanAgeMin * 60_000) {
  console.log(
    `Scan ${lastScanAt ? `du ${new Date(lastScanAt).toISOString()}` : "absent"} — plus vieux que ${config.openMaxScanAgeMin} min (monitor en panne ?) — aucune ouverture.`
  );
  process.exit(0);
}
const scanRows = db
  .prepare(
    `SELECT pool_address, name, token_x_symbol, token_y_symbol, bin_step, score, strategy_hint, vol_24h
     FROM pool_scans WHERE scanned_at = ? AND score > 0 ORDER BY score DESC`
  )
  .all(lastScanAt) as {
  pool_address: string;
  name: string | null;
  token_x_symbol: string | null;
  token_y_symbol: string | null;
  bin_step: number;
  score: number;
  strategy_hint: string;
  vol_24h: number;
}[];

let opened = 0;
let skippedSameToken = 0;
let skippedTopblastCap = 0;
let skippedBlacklisted = 0;
let skippedNotYOnly = 0;
let skippedSoldeGuard = 0;
let skippedStaleSpike = 0;
let skippedNoHint = 0;

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

for (const row of scanRows) {
  if (opened >= Math.min(limit, slots)) break;
  if (openAddresses.has(row.pool_address)) continue;
  const tokenKey = row.token_x_symbol?.toLowerCase() ?? row.name ?? "";
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
  let hint: StrategyHint | null = null;
  try {
    hint = JSON.parse(row.strategy_hint || "{}") as StrategyHint;
  } catch {
    skippedNoHint++;
    continue;
  }
  if (!hint || !hint.strategy) {
    skippedNoHint++;
    continue;
  }
  const strategy = hint.strategy;
  if (strategy === "topblast" || strategy === "resurrect") {
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
    // (leçon 22/08 : TRUMP-USDC). Seules bidask-dip/topblast/resurrect
    // (oneSided y).
    const ySym = (row.token_y_symbol ?? "").toUpperCase();
    const yOnlyOk =
      (ySym === "SOL" || ySym === "WSOL") &&
      (strategy === "bidask-dip" || strategy === "topblast" || strategy === "resurrect");
    if (!yOnlyOk) {
      skippedNotYOnly++;
      continue;
    }
    // Détail API du pool (montants/decimals pour le dépôt réel) + re-vérif du
    // spike : pour topblast/resurrect, un vol 30m retombé sous le seuil
    // d'entrée = fenêtre fermée — on ne transforme pas un snipe raté en hold
    // (l'erreur n°1 du post Nowload : « turning a failed snipe into a
    // long-term investment »).
    let pool;
    try {
      pool = await fetchPool(row.pool_address);
    } catch (e) {
      console.warn(`  ⚠️ détail API KO pour ${row.name} — skip (${String(e).slice(0, 100)})`);
      continue;
    }
    if (strategy === "topblast" && pool.volume_30m < config.quickMinVolume30m) {
      skippedStaleSpike++;
      continue;
    }
    if (strategy === "resurrect" && pool.volume_30m < config.resurrectionMinVol30m) {
      skippedStaleSpike++;
      continue;
    }
    const opp: OpportunityScore = {
      pool,
      vol_24h: row.vol_24h ?? 0,
      score: row.score,
      signals: [],
      strategyHint: hint,
    };
    const dep = Math.min(depositForPool(opp.pool), config.realPositionUsdCap);
    // Garde de solde : déployé + projeté ≤ REAL_MAX_DEPLOY_RATIO × CAPITAL
    // TOTAL (déployé + libre) — correction 2026-08-24 : comparer au solde
    // libre seul bloquait TOUTE réouverture après un close (maxDeploy
    // rétrécissait avec le solde au lieu de suivre le capital).
    const depositY = dep / estimateYUsd(opp.pool);
    const balance = (await realCtx!.connection.getBalance(realCtx!.signer.publicKey)) / 1e9;
    const deployed = (
      db.prepare(`SELECT COALESCE(SUM(amount_y),0) s FROM real_positions WHERE status='open' AND (pilot IS NULL OR pilot = 0)`).get() as {
        s: number;
      }
    ).s;
    // Manches book hybride (01/09, go David) : manche memes = (1−share) du
    // capital TOTAL — la part tendance L4-B est réservée, open-paper ne peut
    // pas y toucher (leçon 31/08 : la machine re-consommait toute marge en
    // <5 min, le pilote ne passait jamais).
    const totalSol = deployed + balance;
    const capitalBook = totalSol * (1 - config.trendSleeveShare);
    const maxDeploy = capitalBook * config.realMaxDeployRatio;
    if (deployed + depositY > maxDeploy) {
      skippedSoldeGuard++;
      console.log(
        `  ⛔ ${row.name} : ${depositY.toFixed(2)} SOL projetés → déployé ${deployed.toFixed(2)} + ${depositY.toFixed(2)} > ${maxDeploy.toFixed(2)} (${(config.realMaxDeployRatio * 100).toFixed(0)}% de ${capitalBook.toFixed(2)} SOL de capital manche memes — réserve tendance ${(config.trendSleeveShare * 100).toFixed(0)}% (${(totalSol * config.trendSleeveShare).toFixed(1)} SOL)) — skip`
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
      Date.now(),
      row.pool_address,
      row.name,
      strategy,
      dep,
      r.positionPubkey,
      r.sig,
      r.minBinId,
      r.maxBinId,
      row.bin_step,
      r.entryPrice,
      row.token_x_symbol ?? null,
      row.token_y_symbol ?? null,
      r.amountX,
      r.amountY
    );
    console.log(
      `  Ouvert RÉEL #${r.positionPubkey.slice(0, 8)}: ${row.name} — ${strategy} ` +
        `(dep ${dep.toFixed(0)}$ · sig ${r.sig.slice(0, 10)}…)`
    );
  } else {
    let pool;
    try {
      pool = await fetchPool(row.pool_address);
    } catch (e) {
      console.warn(`  ⚠️ détail API KO pour ${row.name} — skip (${String(e).slice(0, 100)})`);
      continue;
    }
    const opp: OpportunityScore = {
      pool,
      vol_24h: row.vol_24h ?? 0,
      score: row.score,
      signals: [],
      strategyHint: hint,
    };
    const r = openPaperPosition(opp);
    console.log(`  Ouvert #${r.positionId}: ${row.name} — ${strategy} (score ${row.score.toFixed(1)})`);
  }
  openAddresses.add(row.pool_address);
  openTokens.add(tokenKey);
  opened++;
}
console.log(
  `Terminé : ${opened} position(s) ouverte(s)` +
    `${skippedSameToken ? ` (${skippedSameToken} pool(s) sauté(s) : token déjà en portefeuille)` : ""}` +
    `${skippedTopblastCap ? ` (${skippedTopblastCap} spike sauté(s) : cap ${config.maxTopblastPositions} atteint)` : ""}` +
    `${skippedBlacklisted ? ` (${skippedBlacklisted} token(s) blacklisté(s) post-close)` : ""}` +
    `${skippedNotYOnly ? ` (${skippedNotYOnly} non Y-only SOL ignoré(s))` : ""}` +
    `${skippedStaleSpike ? ` (${skippedStaleSpike} spike mort(s) — fenêtre fermée, pas d'entrée zombie)` : ""}` +
    `${skippedSoldeGuard ? ` (${skippedSoldeGuard} skip garde de solde)` : ""}.`
);

// Petit état du portefeuille (table RÉELLE en régime réel — cohérent avec le
// dédoublage ci-dessus).
const summary = (
  config.realMode
    ? db
        .prepare(
          `SELECT COUNT(*) n, COALESCE(SUM(deposit_usd),0) inv, COALESCE(SUM(last_value_usd),0) val
           FROM real_positions WHERE status='open'`
        )
        .get()
    : db
        .prepare(
          `SELECT COUNT(*) n, COALESCE(SUM(deposit_usd),0) inv, COALESCE(SUM(last_value_usd),0) val
           FROM paper_positions WHERE status='open'`
        )
        .get()
) as { n: number; inv: number; val: number };
console.log(`Portefeuille : ${summary.n} positions, ${summary.inv.toFixed(0)}$ investis, ${summary.val.toFixed(0)}$ de valeur.`);
