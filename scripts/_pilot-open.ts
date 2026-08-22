// PILOTE RÉEL — ouverture contrôlée d'UNE position (jetable, à supprimer après).
// Modèle : scripts/real-shadow.ts (dry-run par défaut, confirm explicite).
// Différence : sizing satsmonkes complet (depositForPool) au lieu du cap 100 $.
//
// Usage :
//   npx tsx scripts/_pilot-open.ts                          # dry-run : top 6 candidats Y-only SOL bidask-dip, AUCUNE tx
//   REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE \
//     npx tsx scripts/_pilot-open.ts --pick=<pool_addr> --confirm=REAL-OPEN   # ENVOIE (process-local, .env intact)
import { Keypair } from "@solana/web3.js";
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { runScan } from "../src/scanner.js";
import { depositForPool } from "../src/strategies.js";
import { STRATEGY_PRESETS } from "../src/strategies.js";
import { estimateYUsd } from "../src/paper.js";
import { realOpenPosition } from "../src/real.js";

const args = process.argv.slice(2);
const pick = args.find((a) => a.startsWith("--pick="))?.split("=")[1] ?? "";
const confirmFlag = args.find((a) => a.startsWith("--confirm="))?.split("=")[1] ?? "";
const send = confirmFlag === "REAL-OPEN";

function className(dep: number): string {
  if (dep === config.satsSizeMajorUsd) return "major";
  if (dep === config.satsSizeExploratoryUsd) return "exploratoire";
  return "conviction";
}

const scan = await runScan();
const sol = scan.opportunities
  .filter((o) => {
    const y = (o.pool.token_y.symbol ?? "").toUpperCase();
    return (y === "SOL" || y === "WSOL") && o.strategyHint.strategy === "bidask-dip";
  })
  .sort((a, b) => b.score - a.score);

if (sol.length === 0) {
  console.log("Aucun candidat Y-only SOL bidask-dip dans ce scan.");
  process.exit(0);
}

if (!send) {
  console.log(`DRY-RUN — ${sol.length} candidat(s) Y-only SOL bidask-dip (scan ${new Date().toISOString()}) :\n`);
  for (const o of sol.slice(0, 6)) {
    const p = o.pool;
    const dep = depositForPool(p);
    const yUsd = estimateYUsd(p);
    const depositY = dep / yUsd;
    const h = o.strategyHint;
    const spreadRaw = Math.abs(h.maxBinId - h.minBinId);
    const spread = Math.min(spreadRaw, 69); // limite on-chain (probe 22/08)
    const cov = (1 - Math.pow(1 + p.bin_step / 10000, -spread)) * 100;
    console.log(
      `  #${p.name}  score=${o.score.toFixed(1)}  [${className(dep)} ${dep}$]` +
        `\n     ${p.address}` +
        `\n     tvl=${Math.round(p.tvl)}$ vol24=${Math.round(p.volume_24h)}$ ftr24=${(p.fee_tvl_ratio_24h ?? 0).toFixed(2)}%` +
        `\n     dep=${dep}$ ≈ ${depositY.toFixed(4)} SOL (yUsd=${yUsd.toFixed(2)}$) · spread ${spread} bins (≈ −${cov.toFixed(0)} % sous le prix${spread < spreadRaw ? `, clampé depuis ${spreadRaw}` : ""})` +
        `\n     dipTarget=${(h.dipTarget ?? 0).toFixed(3)} drawdown24h=${((h.drawdown24h ?? 0) * 100).toFixed(1)}%` +
        (h.fibZone ? ` fibZone=${h.fibZone.level50}→${h.fibZone.level786}` : "") +
        `\n`
    );
  }
  console.log(`Pour ENVOYER (une seule position) :`);
  console.log(`  REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE npx tsx scripts/_pilot-open.ts --pick=<pool_addr> --confirm=REAL-OPEN`);
  process.exit(0);
}

// ---- Phase envoi ----
const opp = sol.find((o) => o.pool.address === pick);
if (!opp) {
  console.error(`--pick=${pick} introuvable parmi les candidats Y-only SOL bidask-dip.`);
  process.exit(1);
}
const p = opp.pool;
const dep = depositForPool(p);
console.log(`OUVERTURE RÉELLE : ${p.name} (${p.address}) — ${opp.strategyHint.strategy} — ${className(dep)} ${dep}$`);
console.log(`  Vérification solde wallet avant envoi…`);

const pubkey = Keypair.fromSecretKey(
  Uint8Array.from(Buffer.from(config.walletPrivateKey, "base64"))
).publicKey.toBase58();
const rpcRes = await fetch(config.rpcUrl, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getBalance", params: [pubkey] }),
}).catch(() => null);
let balanceSol: number | null = null;
if (rpcRes) {
  const j = (await rpcRes.json()) as { result?: { value?: number } };
  balanceSol = j.result?.value ? j.result.value / 1e9 : null;
}
if (balanceSol !== null) {
  const yUsd = estimateYUsd(p);
  const needSol = dep / yUsd + 0.05;
  console.log(`  Solde wallet ${pubkey} : ${balanceSol.toFixed(4)} SOL — besoin ≈ ${needSol.toFixed(4)} SOL (dépôt + fees)`);
  if (balanceSol < needSol) {
    console.error("  ⛔ Solde insuffisant — abandon.");
    process.exit(1);
  }
}

const r = await realOpenPosition(opp, dep);
db.prepare(
  `INSERT INTO real_positions
   (opened_at, pool_address, name, strategy, deposit_usd, position_pubkey, sig,
    min_bin_id, max_bin_id, bin_step, entry_price, token_x_symbol, token_y_symbol,
    amount_x, amount_y, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')`
).run(
  Date.now(), p.address, p.name, opp.strategyHint.strategy, dep,
  r.positionPubkey, r.sig, r.minBinId, r.maxBinId, p.bin_step, r.entryPrice,
  p.token_x.symbol ?? null, p.token_y.symbol ?? null, r.amountX, r.amountY
);
console.log(`✅ OUVERT RÉEL : ${p.name} — ${opp.strategyHint.strategy} — ${dep.toFixed(0)}$`);
console.log(`  position pubkey : ${r.positionPubkey}`);
console.log(`  sig             : ${r.sig}`);
console.log(`  range bins      : ${r.minBinId} → ${r.maxBinId} (bin_step ${p.bin_step})`);
console.log(`  entry price     : ${r.entryPrice}`);
console.log(`  amounts         : X=${r.amountX} ${p.token_x.symbol} · Y=${r.amountY} ${p.token_y.symbol}`);
console.log(`\n  KILL-SWITCH (si besoin) :`);
console.log(`  REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE npm run real:close -- --pubkey ${r.positionPubkey} --pool ${p.address} --bps 10000`);
