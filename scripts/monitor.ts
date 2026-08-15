// Monitor : une passe (`npm run monitor`) ou boucle (`npm run monitor -- --loop`)
import { runMonitorOnce, runMonitorLoop } from "../src/monitor.js";

const loop = process.argv.includes("--loop");
if (loop) await runMonitorLoop();
else await runMonitorOnce({ withScan: true });
