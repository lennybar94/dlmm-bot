// Scan des opportunités DLMM : `npm run scan:pools`
import { runScan } from "../src/scanner.js";

const result = await runScan();
console.log(
  `Scan terminé : ${result.poolsSeen} pools vus, ${result.poolsKept} retenus, ${result.opportunities.length} scorés.`
);
for (const opp of result.opportunities.slice(0, 10)) {
  const p = opp.pool;
  console.log(
    `  ${opp.score.toFixed(1).padStart(5)} | ${p.name.padEnd(20)} | APR fees ${(p.fee_apr_24h * 100).toFixed(0).padStart(5)}% | TVL ${(p.tvl / 1e6).toFixed(2)}M$ | vol24h ${(p.volume_24h / 1e6).toFixed(2)}M$ | σ ${(opp.vol_24h * 100).toFixed(0)}% | bins [${opp.strategyHint.minBinId}..${opp.strategyHint.maxBinId}]`
  );
}
