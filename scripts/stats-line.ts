// Affiche LA ligne de stats 1D/1W/1M/1Y/ALL (PnL/Fees/Profit) — exactement celle
// qui est ajoutée au bas de chaque alerte Telegram par src/telegram.ts.
// Sert aux messages composés à la main (jobs Hermes, digests) qui ne passent pas
// par sendTelegram. Usage : npm run stats:line
import { periodStatsLine } from "../src/telegram.js";

const line = await periodStatsLine();
if (!line) {
  console.error("ligne de stats indisponible (RPC/dashboard)");
  process.exit(1);
}
console.log(line);
