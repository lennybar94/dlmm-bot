// Shadow RÉEL contrôlé — ouvre UNE position réelle minuscule (défaut 45 $) sur une
// opportunité Y-only (bidask-dip / topblast → quote = SOL ; le wallet chaud ne détient
// que du SOL, pas de jetons meme).
//
// SÉCURITÉ : le .env reste REAL_MODE=false (le cron open:paper horaire reste 100 % paper).
// REAL_MODE/REAL_CONFIRM sont activés dans le PROCESS SEULEMENT, et uniquement avec
// --confirm=SHADOW-REAL. Sans ce flag : dry-run, AUCUNE transaction.
//
// Usage :
//   npm run real:shadow                        # dry-run : plan de la 1re opportunité Y-only
//   npm run real:shadow -- --usd=45 --index=2  # dry-run sur la 2e
//   npm run real:shadow -- --confirm=SHADOW-REAL --usd=45 [--index=1]  # ENVOIE la tx
import process from "node:process";

const argv = process.argv.slice(2);
const usd = Number(argv.find((a) => a.startsWith("--usd="))?.split("=")[1] ?? 45);
const index = Number(argv.find((a) => a.startsWith("--index="))?.split("=")[1] ?? 1);
const confirmFlag = argv.find((a) => a.startsWith("--confirm="))?.split("=")[1] ?? "";
const send = confirmFlag === "SHADOW-REAL";

if (!Number.isFinite(usd) || usd <= 0 || usd > 100) {
  console.error(`--usd invalide (${usd}) — attendu entre 1 et 100 $`);
  process.exit(1);
}

if (send) {
  process.env.REAL_MODE = "true";
  process.env.REAL_CONFIRM = "CONFIRMED-REAL-MODE";
}

const { runScan } = await import("../src/scanner.js");
const { db } = await import("../src/db.js");
const { STRATEGY_PRESETS, binIdFromPrice } = await import("../src/strategies.js");
const { buildLiquidity, estimateYUsd } = await import("../src/paper.js");
const { realOpenPosition } = await import("../src/real.js");

console.log(send ? "🔴 MODE ENVOI — transaction RÉELLE" : "🟡 DRY-RUN — aucune transaction");
console.log(`Dépôt cible : ${usd} $ | index opportunité : ${index}`);
console.log("Scan des opportunités (Data API, lecture seule)...");
const scan = await runScan();

// Y-only : quote = SOL (le wallet chaud ne détient que du SOL)
const sol = scan.opportunities.filter(
  (o) =>
    (o.pool.token_y?.symbol ?? "").toUpperCase() === "SOL" &&
    (o.strategyHint.strategy === "bidask-dip" || o.strategyHint.strategy === "topblast")
);
console.log(`Opportunités totales : ${scan.opportunities.length} — Y-only (SOL) : ${sol.length}`);
if (sol.length === 0) {
  console.error("Aucune opportunité Y-only SOL — rien à ouvrir");
  process.exit(1);
}
if (index < 1 || index > sol.length) {
  console.error(`--index=${index} hors bornes (1-${sol.length})`);
  process.exit(1);
}

const opp = sol[index - 1];
const p = opp.pool;
const hint = opp.strategyHint;
const preset = STRATEGY_PRESETS[hint.strategy] ?? STRATEGY_PRESETS["spot-spread"];
const yUsd = estimateYUsd(p);
const depositY = usd / yUsd;
const activeBinData = binIdFromPrice(p.current_price, p.bin_step);
const minBinIdHint = hint.minBinId ?? activeBinData - 10;
const maxBinIdHint = hint.maxBinId ?? activeBinData + 10;
const liq = buildLiquidity({
  depositY,
  price: p.current_price,
  minBinId: minBinIdHint,
  maxBinId: maxBinIdHint,
  binStep: p.bin_step,
  oneSided: preset.oneSided,
});

console.log("------------------------------------------");
console.log(`Pool      : ${p.name} (${p.address})`);
console.log(`Tokens    : X=${p.token_x.symbol} / Y=${p.token_y.symbol}`);
console.log(`Stratégie : ${hint.strategy} — ${preset.description ?? ""}`);
console.log(`Prix      : ${p.current_price} | bin_step ${p.bin_step} | TVL ${Math.round(p.tvl)}$`);
console.log(`Dépôt     : ${usd}$ ≈ ${depositY.toFixed(4)} ${p.token_y.symbol} (yUsd=${yUsd.toFixed(2)}$)`);
console.log(
  `Montants  : X=${(liq.x0 ?? 0).toFixed(6)} ${p.token_x.symbol} | Y=${(liq.y0 ?? 0).toFixed(6)} ${p.token_y.symbol} (oneSided=${preset.oneSided})`
);
console.log(`Range hint: bins [${minBinIdHint}, ${maxBinIdHint}] (spread ${maxBinIdHint - minBinIdHint})`);
console.log(`Score     : ${opp.score.toFixed(1)}`);
console.log("------------------------------------------");

if (!send) {
  console.log("DRY-RUN terminé. Pour ENVOYER : relancer avec --confirm=SHADOW-REAL.");
  process.exit(0);
}

const r = await realOpenPosition(opp, usd);
db.prepare(
  `INSERT INTO real_positions
   (opened_at, pool_address, name, strategy, deposit_usd, position_pubkey, sig,
    min_bin_id, max_bin_id, bin_step, entry_price, token_x_symbol, token_y_symbol,
    amount_x, amount_y, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
).run(
  Date.now(),
  p.address,
  p.name,
  hint.strategy,
  usd,
  r.positionPubkey,
  r.sig,
  r.minBinId,
  r.maxBinId,
  p.bin_step,
  r.entryPrice,
  p.token_x.symbol ?? null,
  p.token_y.symbol ?? null,
  r.amountX,
  r.amountY
);
console.log(`✅ Position RÉELLE ouverte : ${p.name} — ${hint.strategy}`);
console.log(`   positionPubkey : ${r.positionPubkey}`);
console.log(`   sig            : ${r.sig}`);
console.log(`   montants       : ${r.amountX} ${p.token_x.symbol} / ${r.amountY} ${p.token_y.symbol}`);
console.log(`   range bins     : [${r.minBinId}, ${r.maxBinId}]`);
console.log(`   entrée         : ${r.entryPrice}`);
console.log("Kill-switch si besoin :");
console.log(`   npm run real:close -- --pubkey ${r.positionPubkey} --pool ${p.address} --bps 10000`);
