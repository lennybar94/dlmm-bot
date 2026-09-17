// Scan pur — écrit pool_scans sans AUCUNE logique paper (markAll/portfolio).
// Remplace le cron `dlmm-run.sh monitor` (retiré 18/09 : son volet paper marquait
// 0 position depuis le 25/08 tout en écrivant les scans dont dépendent open:paper,
// real-monitor (fee-decline), accel-monitor, earlywatch et le dashboard).
import { runScan } from "../src/scanner.js";
import { logEvent } from "../src/db.js";

const scan = await runScan();
logEvent(
  "scan",
  `Scan terminé : ${scan.poolsSeen} pools vus, ${scan.poolsKept} retenus, ${scan.opportunities.length} opportunités scorées.`
);
console.log(
  `[scan-only] ${scan.poolsSeen} vues · ${scan.poolsKept} retenues · top score ${scan.opportunities[0]?.score.toFixed(1) ?? "—"}`
);
