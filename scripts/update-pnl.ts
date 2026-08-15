// Mark-to-market paper : `npm run update:pnl`
import { markAll, getPortfolioSummary } from "../src/paper.js";

const results = await markAll();
const s = getPortfolioSummary();
console.log(`Mark de ${results.length} positions terminé.`);
console.log(
  `  Valeur ${s.valueUsd.toFixed(0)}$ (investi ${s.investedUsd.toFixed(0)}$) | PnL net ${s.netPnlUsd >= 0 ? "+" : ""}${s.netPnlUsd.toFixed(2)}$ | frais cumulés ${(s.feesEarnedUsd + s.feesClaimedUsd).toFixed(2)}$ | IL total ${s.valueUsd - s.investedUsd - s.feesEarnedUsd - s.feesClaimedUsd >= 0 ? "+" : ""}${(s.valueUsd - s.investedUsd - s.feesEarnedUsd - s.feesClaimedUsd).toFixed(2)}$ | rebalances ${s.rebalances}`
);
