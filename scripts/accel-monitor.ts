// Monitor accéléré (RocketScan, 2026-08-23) : le post rafraîchit toutes les
// 5 s, nos scans à 5 min / marks à 15 min — le seul vrai gap structurel est le
// TIMING. Ce script (cron * * * * * via dlmm-run.sh accel:monitor) surveille
// les pools CHAUDES (top N par score du dernier scan) et enregistre leur volume
// dans accel_observations (historique 60 s). ⚠️ Depuis le fix des faux positifs
// (2026-08-23 19:00), l'exit « cooling off » n'utilise QUE la série pool_scans
// (volumeSeriesScansOnly — source unique cohérente) : les accel_observations
// ne pilotent plus AUCUN exit. Les marks 60 s servent aux triggers de valeur
// (Bollinger/flip restent cadence-indépendants via recentMarkPricesSince).
// Les positions RÉELLES sont marquées par real-monitor (cron */5) — l'audit
// 2026-08-25 (post Nowload) a rapproché sa cadence de 15 min → 5 min.
import { config } from "../src/config.js";
import { db } from "../src/db.js";
import { fetchPool } from "../src/api.js";
import { getOpenPositions, markPosition } from "../src/paper.js";

const t0 = Date.now();

// Dernier scan disponible (le monitor */5 écrit pool_scans en continu).
const lastScan = db
  .prepare("SELECT MAX(scanned_at) AS m FROM pool_scans")
  .get() as { m: number | null };
if (!lastScan.m) {
  console.log("[accel-monitor] pas encore de scan — skip");
  process.exit(0);
}

// « Pools chaudes (top 5 par score) » — RocketScan. Score > 0 : les radar
// early (score 0) ne sont pas des cibles de position.
const top = db
  .prepare(
    `SELECT pool_address, name FROM pool_scans
     WHERE scanned_at = ? AND score > 0
     ORDER BY score DESC LIMIT ?`
  )
  .all(lastScan.m, config.accelMonitorTopN) as { pool_address: string; name: string | null }[];

if (top.length === 0) {
  console.log("[accel-monitor] dernier scan sans pool scorée — skip");
  process.exit(0);
}

const open = getOpenPositions();
const byPool = new Map(open.map((p) => [p.pool_address, p]));

const insObs = db.prepare(
  `INSERT INTO accel_observations (taken_at, pool_address, volume_24h, volume_30m, volume_1h)
   VALUES (?, ?, ?, ?, ?)`
);

let watched = 0;
let marked = 0;
for (const row of top) {
  try {
    const pool = await fetchPool(row.pool_address);
    insObs.run(t0, row.pool_address, pool.volume_24h, pool.volume_30m, pool.volume_1h);
    watched++;
    const pos = byPool.get(row.pool_address);
    if (pos) {
      await markPosition(pos);
      marked++;
    }
  } catch (err) {
    // Log console seulement (le wrapper écrit logs/accel-monitor.log) — pas
    // d'event DB par minute (spam) ; le watchdog dashboard couvre le cas KO.
    console.warn(`[accel-monitor] fetch/mark échoué pour ${row.name} : ${String(err).slice(0, 140)}`);
  }
  await new Promise((r) => setTimeout(r, config.apiRequestDelayMs));
}
console.log(
  `[accel-monitor] ${watched}/${top.length} pools chaudes observées (60 s), ${marked} position(s) marquée(s) en ${((Date.now() - t0) / 1000).toFixed(1)}s`
);
