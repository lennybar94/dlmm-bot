// Monitor : boucle de marquage à la valeur de marché + triggers.
// Usage : `tsx scripts/monitor.ts` (une passe) ou `tsx scripts/monitor.ts --loop` (démon).

import { config } from "./config.js";
import { logEvent } from "./db.js";
import { markAll, getPortfolioSummary } from "./paper.js";
import { runScan } from "./scanner.js";

export async function runMonitorOnce(opts: { withScan?: boolean } = {}): Promise<void> {
  const t0 = Date.now();
  if (opts.withScan) {
    try {
      const scan = await runScan();
      logEvent(
        "monitor",
        `Scan : ${scan.poolsKept}/${scan.poolsSeen} pools retenus, top score ${scan.opportunities[0]?.score.toFixed(1) ?? "—"}`
      );
    } catch (err) {
      logEvent("monitor", `Scan échoué : ${String(err)}`);
    }
  }
  const marks = await markAll();
  const s = getPortfolioSummary();
  logEvent(
    "monitor",
    `Mark-to-market : ${marks.length} positions, valeur ${s.valueUsd.toFixed(0)}$ (investi ${s.investedUsd.toFixed(0)}$), frais cumulés ${(s.feesEarnedUsd + s.feesClaimedUsd).toFixed(2)}$, PnL net ${s.netPnlUsd.toFixed(2)}$ en ${((Date.now() - t0) / 1000).toFixed(1)}s`
  );
  console.log(
    `[monitor] ${marks.length} positions marquées | valeur ${s.valueUsd.toFixed(0)}$ | PnL net ${s.netPnlUsd.toFixed(2)}$ | frais ${(s.feesEarnedUsd + s.feesClaimedUsd).toFixed(2)}$`
  );
}

export async function runMonitorLoop(): Promise<void> {
  console.log(`[monitor] boucle démarrée, intervalle ${config.monitorIntervalMin} min`);
  for (;;) {
    try {
      await runMonitorOnce({ withScan: true });
    } catch (err) {
      logEvent("monitor", `Erreur boucle : ${String(err)}`);
    }
    await new Promise((r) => setTimeout(r, config.monitorIntervalMin * 60_000));
  }
}
