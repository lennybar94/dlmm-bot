// PILOTE L4-B — ouverture contrôlée d'UNE position balancée (spot-spread) sur
// un token établi en tendance. Specs : NOTES-20260829-l4b-pilot-specs.md.
// Modèle : scripts/_pilot-open.ts (dry-run par défaut, --confirm explicite).
//
// Chemin (confirmé) : 1) inventaire pilot_inventory (pending — garde sweep)
// → 2) achat SOL→X (src/swap.ts) → 3) ouverture balancée realOpenPosition
// (hint spot-spread, oneSided "none" — la math paper projette x0/y0 sur la
// courbe) → 4) real_positions pilot=1 + mark immédiate → 5) inventory deposited.
//
// Usage :
//   npx tsx scripts/l4b-open.ts --pick=<pool_addr> --usd=500            # DRY-RUN (aucune tx)
//   REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE \
//     npx tsx scripts/l4b-open.ts --pick=<pool_addr> --usd=500 --confirm=REAL-OPEN  # ENVOIE
import { createRequire } from "node:module";
import { db, isTokenBlacklisted, isPilotInventoryPending } from "../src/db.js";
import { config } from "../src/config.js";
import { fetchPool, fetchOhlcv } from "../src/api.js";
import { getSolPriceUsd } from "../src/export.js";
import {
  buildStrategyHint,
  analyzeTrend,
  realizedVolatility,
  binIdFromPrice,
} from "../src/strategies.js";
import { buildLiquidity, estimateYUsd } from "../src/paper.js";
import { realOpenPosition } from "../src/real.js";
import { swapSolForToken, tokenBalanceOf } from "../src/swap.js";
import { swapSolForStable, USDC_MINT, USDT_MINT } from "../src/swap-stable.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Keypair, PublicKey, Connection } = require("@solana/web3.js") as any;

const PILOT = config.walletAddress;
const MINT_RESERVE_PCT = 0.02; // marge slippage sur l'achat (2 %)
const FEE_BUF_SOL = 0.1; // frais de tx (2 swaps + ouverture)
const MIN_POOL_AGE_DAYS = 7;
const MIN_TVL_USD = 100_000;
const MIN_VOL24H_USD = 1_000_000;
const MAX_ENTRY_RSI = 70; // pas de blow-off (même garde que bidask-dip)
const PILOT_USD_STANDARD = 500; // mise par défaut (classe exploratoire satsmonkes)
// Anti-ré-entrée manche tendance : fenêtre lue depuis la config (défaut 14 j).
// Contre-factuel 14/09 sur les 11 closes du pilote : 4 tokens rejoués, dont 3
// ré-entrées ≤ 7 j coûtant −49,6$ net (HYPE 2 −18,8 / ANSEM 2 −50,9 / gain
// ANTHROPIC 2 manqué +20,1) + cbBTC rejoué à 9 j (−13,4$) attrapé par 14 j.
const PILOT_REENTRY_DAYS = config.pilotReentryCooldownDays;

const args = process.argv.slice(2);
const pick = args.find((a) => a.startsWith("--pick="))?.split("=")[1] ?? "";
const usdArg = args.find((a) => a.startsWith("--usd="))?.split("=")[1];
// NaN = pas de --usd → palier AUTOMATIQUE décidé après le fetch du pool
// (major 1 000$ / standard 500$). Un --usd explicite reste souverain.
let usd = usdArg !== undefined ? parseFloat(usdArg) : NaN;
const send = args.includes("--confirm=REAL-OPEN");

if (!pick) {
  console.error("⛔ --pick=<pool_addr> requis.");
  process.exit(1);
}
if (!Number.isNaN(usd) && !(usd >= 100 && usd <= 1000)) {
  console.error("⛔ --usd doit être entre 100 et 1000 (pilote petit capital).");
  process.exit(1);
}

// --- Pool + tendance (le pool peut être REJETÉ par le scan — on le charge direct) ---
const p = await fetchPool(pick);
const candles = await fetchOhlcv(pick);
const vol = realizedVolatility(candles);
const trend = analyzeTrend(candles);
const yUsd = estimateYUsd(p);
// Palier de mise automatique (L4-B « étendue » v2, 2026-09-14) : classe
// « major » du sizing satsmonkes (TVL ≥ 500k$ ET vol24h ≥ 5M$) → 1 000$ ;
// sinon 500$ (classe exploratoire). La garde de manche ci-dessous borne
// toujours le total (0.8 × TREND_SLEEVE_SHARE × total SOL).
const isMajor = p.tvl >= config.pilotMajorMinTvl && p.volume_24h >= config.pilotMajorMinVolume24h;
if (Number.isNaN(usd)) usd = isMajor ? config.pilotUsdMajor : PILOT_USD_STANDARD;
const depositY = usd / yUsd;
const activeBinId = binIdFromPrice(p.current_price, p.bin_step);
const hint = buildStrategyHint(p, activeBinId, vol, "spot-spread", p.current_price, candles);
const symY0 = (p.token_y.symbol ?? "").toUpperCase();
const yIsStablePlan = symY0 === "USDC" || symY0 === "USDT";
// ⚠️ Échelle vérifiée 27/09 (dry-run TRUMP-USDC → « prix 2,11 SOL/TRUMP ») :
// current_price est TOUJOURS en SOL UI, y compris sur les pools X-USDC. La math
// paper reste donc en SOL UI (depositY inchangé) ; seul le PAIEMENT du côté Y
// diffère : y0 SOL d'équivalent → achetés en USDC au prix SOL-$ du jour.
// depositY est en unités de la devise Y (estimateYUsd ≈ 1$ pour un stable).
// La math paper travaille en SOL UI → conversion $→SOL indispensable ici, sinon
// le dépôt est surdimensionné d'un facteur prixSOL (bug dry-run SKHY 27/09).
const symYpre = (p.token_y.symbol ?? "").toUpperCase();
const yIsStablePre = symYpre === "USDC" || symYpre === "USDT";
const solUsdPre = await getSolPriceUsd();
if (yIsStablePre && !solUsdPre) {
  console.error("⛔ Prix SOL indisponible — abandon.");
  process.exit(1);
}
const depositYSol = yIsStablePre ? depositY / (solUsdPre as number) : depositY;
const liq = buildLiquidity({
  depositY: depositYSol,
  price: p.current_price,
  minBinId: hint.minBinId,
  maxBinId: hint.maxBinId,
  binStep: p.bin_step,
  oneSided: "none",
});
const x0 = liq.x0; // tokens à détenir (achat)
const y0ui = liq.y0; // équivalent SOL du côté Y (devise de paiement gérée en 2bis)
const y0 = y0ui; // alias historique (affichages)
// Élargissement 27/09 (go David) : pools tendance stables (TRUMP-USDC…). Le
// wallet ne tient que du SOL → on swappe une partie SOL→stable via un pool
// majeur SOL-USDC/USDT (slippage 100 bps max). Besoin exprimé en SOL :
// dépôt Y en $ ÷ prix SOL + marge. Pour les pools SOL-quotés, inchangé.
const symY = (p.token_y.symbol ?? "").toUpperCase();
const yIsStable = symY === "USDC" || symY === "USDT";
// ⚠️ Échelle des prix (re-vérifiée 27/09, dry-run SKHY = 65 SOL/SKHY) :
// p.current_price est TOUJOURS en SOL UI, même sur un pool X-USDC. Donc x0/y0
// de la math paper sont déjà en SOL — il faut DIVISER par le prix SOL quand on
// paie en stable ($ UI), et non pas comme avant où buySol/wantUsd multipliaient
// deux fois le prix SOL (besoin gonflé ×prix² → ~80 k$ simulés pour 500 $).
const solUsdForPlan = await getSolPriceUsd();
if (yIsStable && !solUsdForPlan) {
  console.error("⛔ Prix SOL indisponible — impossible de dimensionner le côté stable. Abandon.");
  process.exit(1);
}
const buySol = x0 * p.current_price * (1 + MINT_RESERVE_PCT); // SOL pour l'achat X
const yNeedSol = y0ui; // équivalent SOL du dépôt Y (payé en stable si pool stable)
const needSol = buySol + yNeedSol * (yIsStable ? 1.005 : 1) + FEE_BUF_SOL;
// Élargissement de range sur demande David (28/09) : le preset spot-spread du
// pilote donne ±10-15 bins → ≈±7 % sur un bin_step 80. Les données disent que
// 33 % des closes meurent « hors range » et que la manche passe 45 % de son
// temps hors range → multiplicateur de bins par pool via env PILOT_SPREAD_MULT_<SYM>
// (>1), clamp on-chain 69 bins conservé. Sans env = comportement strictement inchangé.
const spreadMultKey = `PILOT_SPREAD_MULT_${(p.token_x.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
const spreadMult = (() => { const v = Number(process.env[spreadMultKey] || ""); return Number.isFinite(v) && v > 1 ? v : 1; })();
const spreadRaw0 = Math.abs(hint.maxBinId - hint.minBinId);
const spreadRaw = Math.round(spreadRaw0 * spreadMult);
const spread = Math.min(spreadRaw, 69);
const cov = (1 - Math.pow(1 + p.bin_step / 10000, -spread)) * 100;

console.log(`=== PILOTE L4-B — ${p.name} (${pick}) ===`);
console.log(`TVL ${Math.round(p.tvl)}$ · vol24h ${Math.round(p.volume_24h)}$ · âge ${p.pool_age_days.toFixed(1)} j · prix ${p.current_price} SOL/${p.token_x.symbol ?? "X"}`);
console.log(`Tendance : drift24h ${trend.drift24h !== null ? (trend.drift24h * 100).toFixed(1) + "%" : "n/a"} · RSI ${trend.rsiNow?.toFixed(0) ?? "n/a"}${trend.rsiRising ? " ↗" : trend.rsiNow !== null ? " ↘" : ""} · ${trend.priceAboveSma === null ? "MA7 n/a" : trend.priceAboveSma ? "prix > MA7" : "prix < MA7"}`);

// --- Critères durs (spec section 4 — sélection humaine mais gardes bloquantes) ---
// Anti-ré-entrée (L4-B v2, 14/09) : toute tentative pilote sur ce TOKEN dans la
// fenêtre bloque une nouvelle entrée — la concentration est le vrai risque de
// cette manche (27 pools conformes seulement sur 14 j, dont MET/cbBTC/HYPE/JUP
// reviennent à chaque scan).
const symXCmp = (p.token_x.symbol ?? "").toLowerCase();
const priorPilot =
  symXCmp.length > 0
    ? (db
        .prepare(
          `SELECT id, datetime(opened_at/1000,'unixepoch','localtime') AS d, status, close_reason
           FROM real_positions
           WHERE pilot=1 AND LOWER(COALESCE(token_x_symbol,''))=?
             AND opened_at > ? ORDER BY opened_at DESC LIMIT 1`
        )
        .get(symXCmp, Date.now() - PILOT_REENTRY_DAYS * 86_400_000) as
        | { id: number; d: string; status: string; close_reason: string | null }
        | undefined)
    : undefined;

const checks: { label: string; ok: boolean; detail: string }[] = [
  { label: "âge ≥ 7 j", ok: p.pool_age_days >= MIN_POOL_AGE_DAYS, detail: `${p.pool_age_days.toFixed(1)} j` },
  { label: "TVL ≥ 100k$", ok: p.tvl >= MIN_TVL_USD, detail: `${Math.round(p.tvl)}$` },
  { label: "vol24h ≥ 1M$", ok: p.volume_24h >= MIN_VOL24H_USD, detail: `${Math.round(p.volume_24h)}$` },
  { label: "pas de tendance baissière confirmée", ok: !trend.downTrend, detail: trend.downTrend ? "downTrend (drift<0, RSI↘, prix<MA7)" : "OK" },
  { label: "RSI < 70 (pas de blow-off)", ok: trend.rsiNow === null || trend.rsiNow < MAX_ENTRY_RSI, detail: trend.rsiNow?.toFixed(0) ?? "n/a" },
  { label: "token non blacklisté", ok: !isTokenBlacklisted(p.token_x.symbol ?? p.name), detail: isTokenBlacklisted(p.token_x.symbol ?? p.name) ? "blacklisté/cooldown" : "OK" },
  {
    label: `aucune tentative pilote sur ce token depuis ${PILOT_REENTRY_DAYS} j`,
    ok: !priorPilot,
    detail: priorPilot
      ? `#${priorPilot.id} ouverte le ${priorPilot.d} (${priorPilot.status === "open" ? "encore ouverte" : priorPilot.close_reason ?? "close"})`
      : "OK",
  },
];
let hardFail = false;
for (const c of checks) {
  console.log(`  ${c.ok ? "✓" : "✗"} ${c.label} — ${c.detail}`);
  if (!c.ok) hardFail = true;
}
const openPilotSamePool = db
  .prepare("SELECT id FROM real_positions WHERE status='open' AND pilot=1 AND pool_address=?")
  .get(pick) as { id: number } | undefined;
if (openPilotSamePool) {
  console.log(`  ✗ déjà une position pilote OUVERTE sur ce pool (id ${openPilotSamePool.id}) — dédup.`);
  hardFail = true;
}
if (hardFail) {
  console.error("\n⛔ Critère(s) non satisfait(s) — pas d'ouverture (sélection humaine disciplinée).");
  process.exit(1);
}

// Marge de slippage par pool (env PILOT_SLIPPAGE_BPS:<SYM>=…, sinon défauts
// swap.ts/swap-stable.ts). ANTHROPIC est notoirement glissant sur nos achats
// SOL→X — demande David 27/09 : élargir sa marge pour ne pas mourir en « reçu
// insuffisant » à chaque tentative.
const slipOverride = (() => {
  const key = `PILOT_SLIPPAGE_BPS_${(p.token_x.symbol ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  const v = Number(process.env[key] || "");
  return Number.isFinite(v) && v > 0 ? v : undefined;
})();

// --- Plan ---
console.log(`\n--- PLAN (spot-spread balancé, ${usd}$)${slipOverride ? ` · slippage ${slipOverride} bps (${p.token_x.symbol})` : ""} ---`);
console.log(`Dépôt : ${x0.toLocaleString("fr-FR")} ${p.token_x.symbol ?? "X"} + ${y0.toFixed(4)} SOL (projeté sur la courbe)`);
console.log(`Achat : ${buySol.toFixed(4)} SOL → ${(x0 * (1 + MINT_RESERVE_PCT)).toLocaleString("fr-FR")} ${p.token_x.symbol} (marge ${MINT_RESERVE_PCT * 100}%)`);
console.log(`Besoin total : ${needSol.toFixed(4)} SOL (achat ${buySol.toFixed(4)} + dépôt ${y0.toFixed(4)} + frais ${FEE_BUF_SOL})`);
console.log(`Range : ${spread} bins (≈ ±${(cov / 2).toFixed(0)}% autour du prix${spread < spreadRaw ? `, clampé depuis ${spreadRaw}` : ""}) · bin_step ${p.bin_step}${spreadMult > 1 ? ` · ×${spreadMult} range (${spreadMultKey})` : ""}`);

// --- Gardes solde + garde 80 % ---
const conn = new Connection(config.rpcUrl, "confirmed");
const signer = Keypair.fromSecretKey(Buffer.from(config.walletPrivateKey, "base64"));
if (signer.publicKey.toBase58() !== PILOT) {
  console.error(`⛔ Clé dérivée ${signer.publicKey.toBase58()} ≠ wallet pilote ${PILOT} — abandon.`);
  process.exit(1);
}
const freeSol = (await conn.getBalance(signer.publicKey)) / 1e9;
// Plancher de thésaurisation (go David 06/10) : l'ouverture pilote ne peut
// jamais entamer la réserve native sous WALLET_THESAR_FLOOR_SOL.
if (config.walletThesarFloorSol > 0 && freeSol - needSol < config.walletThesarFloorSol - 0.005) {
  console.error(`\n🔒 plancher thésaurisation ${config.walletThesarFloorSol} SOL : libre ${freeSol.toFixed(2)} − besoin ${needSol.toFixed(2)} sous le plancher — pas d'ouverture.`);
  process.exit(0);
}
// Manches book hybride (01/09, go David) : la manche tendance (CE script)
// dispose de TREND_SLEEVE_SHARE du capital TOTAL ; la manche memes (open-paper)
// est bornée à (1−share). Garde tendance : déployé tendance + besoin ≤
// 0.8 × budget tendance.
const deployedTrend = (db
  .prepare("SELECT COALESCE(SUM(amount_y),0) s FROM real_positions WHERE status='open' AND pilot=1")
  .get() as { s: number }).s;
const deployedMemes = (db
  .prepare("SELECT COALESCE(SUM(amount_y),0) s FROM real_positions WHERE status='open' AND (pilot IS NULL OR pilot = 0)")
  .get() as { s: number }).s;
const totalSol = freeSol + deployedTrend + deployedMemes;
const trendBudget = totalSol * config.trendSleeveShare;
const guardPct = trendBudget > 0 ? (deployedTrend + needSol) / (0.8 * trendBudget) : 0;
console.log(`Solde libre ${freeSol.toFixed(2)} SOL · manche memes déployée ${deployedMemes.toFixed(2)} · manche tendance déployée ${deployedTrend.toFixed(2)} · total ${totalSol.toFixed(2)} · garde manche tendance après ouverture : ${(guardPct * 100).toFixed(0)}% (budget ${trendBudget.toFixed(2)} SOL = ${(config.trendSleeveShare * 100).toFixed(0)}% du total)`);
if (freeSol < needSol) {
  console.error(`\n⛔ Solde libre insuffisant (${freeSol.toFixed(2)} < ${needSol.toFixed(2)}) — pas d'ouverture.`);
  process.exit(1);
}
if (guardPct > 1) {
  console.error(`\n⛔ Garde manche tendance dépassée (déployé tendance + besoin > 80 % du budget tendance ${trendBudget.toFixed(2)} SOL) — top-up ou fermeture de memes requis.`);
  process.exit(1);
}

if (!send) {
  console.log(`\nDRY-RUN — aucune tx envoyée.`);
  console.log(`Pour EXÉCUTER : REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE npx tsx scripts/l4b-open.ts --pick=${pick} --usd=${usd} --confirm=REAL-OPEN`);
  process.exit(0);
}

// ================= EXÉCUTION =================
console.log("\n=== EXÉCUTION (confirmé) ===");
const xMint = p.token_x.address;
const xDecimals = p.token_x.decimals ?? 9;
const xSymbol = p.token_x.symbol ?? "X";
const buyTargetRaw = BigInt(Math.floor(x0 * (1 + MINT_RESERVE_PCT) * 10 ** xDecimals));

// 1) Inventaire pending (garde sweep : ce token n'est PAS un résidu à swapper)
db.prepare(
  `INSERT INTO pilot_inventory (mint, pool_address, symbol, amount_raw, amount_ui, status, created_at)
   VALUES (?, ?, ?, ?, ?, 'pending', ?)`
).run(xMint, pick, xSymbol, buyTargetRaw.toString(), Number(buyTargetRaw) / 10 ** xDecimals, Date.now());
console.log(`1) Inventaire pending : ${xSymbol} (${xMint.slice(0, 8)}…) — protégé du sweep.`);

// 2bis) Achat du côté Y stable si besoin (SOL → USDC/USDT via pool majeur).
// Élargissement 27/09 : les gros pools tendance stables (TRUMP-USDC, PENGU-USDC…)
// sont maintenant jouables par le pilote. Slippage 100 bps max + double lecture
// du solde (pattern sell-omo) ; échec = inventaire failed, aucune ouverture.
// ⚠️ y0 est une projection paper ; pour un dépôt balancé exact on recalculera
// rawY à partir du stable RÉCEMMENT reçu (après-vente) × ratio liq.x0/liq.y0.
let yDepositRaw = 0n; // résolu après l'achat du stable
if (yIsStable) {
  const stableMint = symY === "USDC" ? USDC_MINT : USDT_MINT;
  const stableDec = p.token_y.decimals ?? 6;
  // Pré-chargement TOTAL go David 04/10 : on achète Y-dépôt + X-budget en un
  // seul swap SOL→stable. Avant : seule la part Y était financée, et l'achat X
  // dépendait d'un solde USDC résiduel du wallet → « aucun stable excédentaire »
  // (14+ rejets des 01-04/10, ex JLP #152 à 09:42 avec wallet USDC ≈ 0).
  const solForStable = (yNeedSol + buySol) * 1.002; // marge slippage quote
  const routePool =
    symY === "USDC"
      ? process.env.PILOT_USDC_POOL || "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6" // DLMM SOL-USDC bin_step 4 (~7 M$ TVL) ; remplace le pool Raydium 5Q544... introuvable depuis la migration Meteora (Invalid account discriminator, 03/10)
      : process.env.PILOT_USDT_POOL || "";
  if (!routePool) {
    console.error("⛔ Pas de pool de routage pour acheter USDT — configure PILOT_USDT_POOL.");
    process.exit(1);
  }
  // cible en $ UI = équivalent SOL du dépôt × prixSOL (y0 est en SOL UI)
  const yTargetUi = (y0 + buySol) * (solUsdForPlan as number); // dépôt Y + budget X
  try {
    const before = await tokenBalanceOf(conn, signer.publicKey, stableMint);
    const rs = await swapSolForStable({
      poolAddress: routePool,
      stableMint,
      stableDecimals: stableDec,
      solAmount: solForStable,
    });
    await new Promise((res) => setTimeout(res, 3000));
    const after = await tokenBalanceOf(conn, signer.publicKey, stableMint);
    const gotUi = Number(after - before) / 10 ** stableDec;
    console.log(`2bis) Stable OK — sig ${rs.sig} — reçu ${gotUi.toLocaleString("fr-FR")} ${symY} (cible ≈ ${yTargetUi.toFixed(2)} ${symY})`);
    if (after - before < BigInt(Math.floor(yTargetUi * 0.99 * 10 ** stableDec))) {
      db.prepare(`UPDATE pilot_inventory SET status='failed', updated_at=? WHERE mint=? AND status='pending'`).run(Date.now(), xMint);
      console.error("⛔ Stable reçu insuffisant — inventaire failed, AUCUNE ouverture.");
      process.exit(1);
    }
    const receivedRaw = after - before;
    // FIX incident wNEAR 29/09 : le dépôt Y doit être l'INTÉGRALITÉ du budget
    // stable achetés (moins une petite réserve de frais), pas un ratio paper
    // entre unités incompatibles. La part X du dépôt proviendra de l'achat 2)
    // financé par le surplus stable ; on ne touche donc PAS encore ici — la
    // valeur finale est prise APRÈS l'achat X : solde stable restant complet.
    // ⚠️ FIX 05/10 (TRUMP #213-#219, PENGU #208-#214) : yDepositRaw valait
    // receivedRaw = INTÉGRALITÉ des USDC achetés → spendable = solde − dépôt ≈ 0
    // et l'achat X mourait « aucun stable excédentaire ». Le dépôt Y réel doit
    // être la part stable du budget (yNeedSol SOL × prix $), pas tout le reçu.
    const planUi = Math.floor(yTargetUi * 10 ** stableDec);
    const floorYDeposit = BigInt(Math.floor(y0 * (solUsdForPlan as number) * 10 ** stableDec));
    yDepositRaw = receivedRaw > planUi ? BigInt(planUi) : floorYDeposit;
    if (yDepositRaw <= 0n) {
      db.prepare(`UPDATE pilot_inventory SET status='failed', updated_at=? WHERE mint=? AND status='pending'`).run(Date.now(), xMint);
      console.error("⛔ Stable insuffisant pour équilibrer X — AUCUNE ouverture.");
      process.exit(1);
    }
  } catch (err) {
    db.prepare(`UPDATE pilot_inventory SET status='failed', updated_at=? WHERE mint=? AND status='pending'`).run(Date.now(), xMint);
    console.error(`⛔ Achat stable échoué : ${String(err)} — inventaire failed.`);
    process.exit(1);
  }
}

// 2) Achat de X :
//   - pool SOL-quoté : swap direct SOL→X dans le pool cible (inchangé).
//   - pool stable (27/09) : on a acheté USDC en 2bis ; l'achat X se fait donc
//     USDC→X via le pool cible (même mécanisme DLMM, monnaie d'entrée stable).
// ⚠️ Mur SOL-USDC du 04/10 (run 10:26) : quand X = wSOL (So1111…), Jupiter
  // crédite le LAMPORT NATIF du wallet, pas l'ATA wSOL → tokenBalanceOf lisait
  // « 0 reçu » et rejetait en faux slippage. Mesure par delta de solde natif
  // pour ce cas ; tout autre token garde la lecture ATA inchangée.
const xIsNativeSol = xMint.startsWith("So11111111111111111111111111111");
const balOf = async (): Promise<bigint> =>
  xIsNativeSol ? BigInt(await conn.getBalance(signer.publicKey)) : await tokenBalanceOf(conn, signer.publicKey, xMint);
try {
  const before = await balOf();
  let r;
  if (yIsStable) {
    // import dynamique évite une dépendance circulaire potentielle
    const { swapStableForToken } = await import("../src/swap-stable.js");
    const decY = p.token_y.decimals ?? 6;
    const stableMint = symY === "USDC" ? USDC_MINT : USDT_MINT;
    const stableBalRaw = await tokenBalanceOf(conn, signer.publicKey, stableMint);
    // Budget achat X en $ UI (=stable) : x0 × prix ($ pour pool stable) × (1+réserve)
    // Budget achat X exprimé en stable ($) : buySol SOL × prix SOL-$ (+ réserve déjà dans buySol)
    const wantUsd = buySol * (solUsdForPlan as number);
    // On garde yDepositRaw côté dépôt ; tout le surplus stable va à l'achat X.
    const spendableRaw = stableBalRaw > yDepositRaw ? stableBalRaw - yDepositRaw : 0n;
    const wantRaw = BigInt(Math.floor(wantUsd * 10 ** decY));
    const spendRaw = wantRaw < spendableRaw ? wantRaw : spendableRaw;
    if (spendRaw <= 0n) throw new Error("aucun stable excédentaire pour acheter X");
    r = await swapStableForToken({
      poolAddress: pick,
      xMint,
      xDecimals,
      stableMint,
      stableDecimals: decY,
      stableAmountUi: Number(spendRaw) / 10 ** decY,
      ...(slipOverride ? { slippageBps: slipOverride } : {}),
    });
  } else {
    r = await swapSolForToken({
      poolAddress: pick,
      xMint,
      xDecimals,
      solAmount: buySol,
      ...(slipOverride ? { slippageBps: slipOverride } : {}),
    });
  }
  await new Promise((res) => setTimeout(res, 3000));
  const after = await balOf();
  const received = Number(after - before) / 10 ** xDecimals;
  console.log(`2) Achat OK — sig ${r.sig} — reçu ${received.toLocaleString("fr-FR")} ${xSymbol} (cible ≥ ${x0.toLocaleString("fr-FR")})`);
  if (after - before < BigInt(Math.floor(x0 * 10 ** xDecimals))) {
    db.prepare(`UPDATE pilot_inventory SET status='failed', updated_at=? WHERE mint=? AND status='pending'`).run(Date.now(), xMint);
    console.error("⛔ Token reçu insuffisant (slippage) — inventaire marqué failed, AUCUNE ouverture.");
    process.exit(1);
  }
} catch (err) {
  db.prepare(`UPDATE pilot_inventory SET status='failed', updated_at=? WHERE mint=? AND status='pending'`).run(Date.now(), xMint);
  console.error(`⛔ Achat échoué : ${String(err)} — inventaire failed.`);
  process.exit(1);
}

// 2ter) Verrouillage du dépôt Y stable = solde restant réel après achat X.
// Garde d'équilibre : la valeur $ du dépôt final (X wallet + Y solde) doit être
// proche du plan `usd` — sinon on refuse (c'est exactement ce qui manquait lors
// de l'incident : 100 $ déposés pour un plan de 500 $, sans alerte).
if (yIsStable) {
  const decYlock = p.token_y.decimals ?? 6;
  const stableMintLock = symY === "USDC" ? USDC_MINT : USDT_MINT;
  const stableLeftRaw = await tokenBalanceOf(conn, signer.publicKey, stableMintLock);
  const reserveRaw = BigInt(Math.floor(Number(stableLeftRaw) * 0.003)); // 0,3 % coussin realloc/frais
  yDepositRaw = stableLeftRaw > reserveRaw ? stableLeftRaw - reserveRaw : 0n;
  const xWalletUi = Number(await balOf()) / 10 ** xDecimals;
  const depositUsdReal = xWalletUi * p.current_price + Number(yDepositRaw) / 10 ** decYlock;
  console.log(`2ter) Dépôt vérifié : ${xWalletUi.toLocaleString("fr-FR")} ${xSymbol} + ${(Number(yDepositRaw) / 10 ** decYlock).toLocaleString("fr-FR")} ${symY} ≈ ${depositUsdReal.toFixed(0)}$ (plan ${usd}$)`);
  if (Math.abs(depositUsdReal - usd) / usd > 0.1) {
    db.prepare(`UPDATE pilot_inventory SET status='failed', updated_at=? WHERE mint=? AND status='pending'`).run(Date.now(), xMint);
    console.error(`⛔ Écart dépôt/plan > 10 % (${depositUsdReal.toFixed(0)} vs ${usd}) — AUCUNE ouverture (garde anti-amputation 29/09).`);
    process.exit(1);
  }
}

// 3) Ouverture balancée (l'opp est reconstruit : hint spot-spread)
const opp = {
  pool: p,
  vol_24h: vol,
  score: 0,
  signals: [],
  strategyHint: hint,
};
let r;
try {
  // Sur pool stable : dépôt = soldes RÉELS du wallet (X complet + Y verrouillé),
  // passés explicitement — plus aucune re-projection paper (source de l'amputation).
  let override: { yOverrideRaw?: bigint; xOverrideRaw?: bigint } = {};
  if (yIsStable) {
    const xWalletRaw = await balOf();
    // réserve X 0,5 % (les dusts partiront au sweep post-close)
    const xReserve = BigInt(Math.floor(Number(xWalletRaw) * 0.005));
    override = { yOverrideRaw: yDepositRaw, xOverrideRaw: xWalletRaw > xReserve ? xWalletRaw - xReserve : 0n };
  }
  r = await realOpenPosition(opp, usd, override);
} catch (err) {
  db.prepare(`UPDATE pilot_inventory SET status='failed', updated_at=? WHERE mint=? AND status='pending'`).run(Date.now(), xMint);
  console.error(`⛔ Ouverture échouée : ${String(err)} — inventaire failed (le token reste au wallet, revoir le plan).`);
  process.exit(1);
}

// 4) Position + mark immédiate (watchdog — leçon 23/08)
const posId = Number(
  (db
    .prepare(
      `INSERT INTO real_positions
       (opened_at, pool_address, name, strategy, deposit_usd, position_pubkey, sig,
        min_bin_id, max_bin_id, bin_step, entry_price, token_x_symbol, token_y_symbol,
        amount_x, amount_y, status, pilot, invested_sol)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, ?)`
    )
    .run(Date.now(), pick, p.name, "spot-spread", usd, r.positionPubkey, r.sig,
      r.minBinId, r.maxBinId, p.bin_step, r.entryPrice,
      p.token_x.symbol ?? null, p.token_y.symbol ?? null, r.amountX, r.amountY,
      buySol + (yIsStable ? yNeedSol : y0))
    .lastInsertRowid as number)
);
db.prepare(
  `INSERT INTO real_marks (taken_at, position_id, price, value_usd, fees_usd, net_pnl_usd, in_range)
   VALUES (?, ?, ?, ?, 0, 0, 1)`
).run(Date.now(), posId, r.entryPrice, usd);

// 5) Inventaire déposé
db.prepare(`UPDATE pilot_inventory SET status='deposited', updated_at=? WHERE mint=? AND status='pending'`).run(Date.now(), xMint);

console.log(`3) OUVERT PILOTE : ${p.name} — spot-spread — ${usd}$ (pilot=1, id ${posId})`);
console.log(`   position pubkey : ${r.positionPubkey}`);
console.log(`   sig             : ${r.sig}`);
console.log(`   range bins      : ${r.minBinId} → ${r.maxBinId} (bin_step ${p.bin_step})`);
console.log(`   amounts         : X=${r.amountX} ${xSymbol} · Y=${r.amountY} SOL`);
console.log(`\n  KILL-SWITCH (si besoin) :`);
console.log(`  REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE npm run real:close -- --id ${posId} --bps 10000`);
console.log(`  (le close rendra le token → sweep normal vers SOL ; le surplus d'achat ~2% reste au wallet)`);
