// Ouvre des positions paper sur les meilleures opportunités du dernier scan.
// Usage : `npm run open:paper` (top MAX_POSITIONS) ou `--limit N` / `--strategy spot-wide`
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { runScan } from "../src/scanner.js";
import { openPaperPosition, getOpenPositions } from "../src/paper.js";

const args = process.argv.slice(2);
const limitArg = args.find((a) => a.startsWith("--limit="));
const limit = limitArg ? Number(limitArg.split("=")[1]) : config.maxPositions;

const openPositions = getOpenPositions();
const openAddresses = new Set(openPositions.map((p) => p.pool_address));
// Cap de diversification par token : max 1 position par token (les pools du même
// token — ex. 3× ANSEM-SOL — sont corrélés, zap-out groupé = chart cassé).
const openTokens = new Set(openPositions.map((p) => p.token_x_symbol?.toLowerCase() ?? p.name));
const slots = Math.max(0, config.maxPositions - openPositions.length);
if (slots <= 0) {
  console.log(`Portefeuille plein (${openPositions.length}/${config.maxPositions} positions) — rien à ouvrir.`);
  process.exit(0);
}

const scan = await runScan();
let opened = 0;
let skippedSameToken = 0;
for (const opp of scan.opportunities) {
  if (opened >= Math.min(limit, slots)) break;
  if (openAddresses.has(opp.pool.address)) continue;
  const tokenKey = opp.pool.token_x.symbol?.toLowerCase() ?? opp.pool.name;
  if (openTokens.has(tokenKey)) {
    skippedSameToken++;
    continue;
  }
  const r = openPaperPosition(opp);
  console.log(`  Ouvert #${r.positionId}: ${opp.pool.name} — ${opp.strategyHint.strategy}, ${config.depositUsdPerPosition}$ (score ${opp.score.toFixed(1)})`);
  openAddresses.add(opp.pool.address);
  openTokens.add(tokenKey);
  opened++;
}
console.log(`Terminé : ${opened} position(s) ouverte(s) sur ${config.depositUsdPerPosition}$ chacune${skippedSameToken ? ` (${skippedSameToken} pool(s) sauté(s) : token déjà en portefeuille)` : ""}.`);

// Petit état du portefeuille
const summary = db
  .prepare(
    `SELECT COUNT(*) n, COALESCE(SUM(deposit_usd),0) inv, COALESCE(SUM(last_value_usd),0) val
     FROM paper_positions WHERE status='open'`
  )
  .get() as { n: number; inv: number; val: number };
console.log(`Portefeuille : ${summary.n} positions, ${summary.inv.toFixed(0)}$ investis, ${summary.val.toFixed(0)}$ de valeur.`);
