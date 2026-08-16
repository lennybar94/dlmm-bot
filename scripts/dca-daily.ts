// DCA quotidien paper : ajoute DCA_DAILY_USD de quote (SOL) à chaque position
// bidask-dip ouverte. Playbook Djedje20x (auto-fill). Usage : `npm run dca:daily`
import { config } from "../src/config.js";
import { dcaAllOpen, getPortfolioSummary } from "../src/paper.js";

if (!config.dcaEnabled) {
  console.log("[dca] DCA_ENABLED=false — rien à faire. Active dans .env pour lancer.");
  process.exit(0);
}

const results = dcaAllOpen();
const s = getPortfolioSummary();
console.log(
  `[dca] ${results.length} position(s) bidask-dip alimentée(s) à ${config.dcaDailyUsd}$ chacune (${results.map((r) => `#${r.positionId}:+${r.addedUsd}$`).join(", ") || "—"}).`
);
console.log(`[dca] Portefeuille : ${s.open} positions, ${s.investedUsd.toFixed(0)}$ investis.`);
