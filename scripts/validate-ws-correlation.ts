// Validation de corrélation ws-pool-monitor vs sources existantes (2026-08-25,
// phase 2 pré-branchement — discipline omo : on ne câble un exit que sur une
// source validée). Lecture seule.
//
// 1) Volume : corrélation de Spearman entre (a) les événements ws agrégés par
//    bucket de 5 min (pool_events_rt) et (b) le delta de volume_24h entre scans
//    consécutifs (pool_scans) — même fenêtre.
// 2) Bin : accord entre l'in_range calculé depuis le bin ws (min ≤ bin ≤ max)
//    et l'in_range des marks réels (SDK on-chain) — le taux d'accord décide si
//    le bin ws peut remplacer getActiveBin.
import { db } from "../src/db.js";

interface Bucket {
  t: number;
  ws: number;
  scan: number;
}

function spearman(a: number[], b: number[]): number {
  if (a.length < 4 || a.length !== b.length) return NaN;
  const rank = (arr: number[]): number[] => {
    const idx = arr.map((v, i) => [v, i] as const).sort((x, y) => x[0] - y[0]);
    const r = new Array<number>(arr.length);
    let i = 0;
    while (i < idx.length) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const ma = ra.reduce((s, v) => s + v, 0) / n;
  const mb = rb.reduce((s, v) => s + v, 0) / n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    cov += (ra[i] - ma) * (rb[i] - mb);
    va += (ra[i] - ma) ** 2;
    vb += (rb[i] - mb) ** 2;
  }
  return cov / Math.sqrt(va * vb);
}

const pools = db
  .prepare(`SELECT DISTINCT pool_address FROM pool_events_rt`)
  .all() as { pool_address: string }[];

console.log("=== CORRÉLATION ws vs scan (volume par bucket 5 min) ===");
for (const { pool_address: addr } of pools) {
  const evs = db
    .prepare(`SELECT ts FROM pool_events_rt WHERE pool_address = ? ORDER BY ts`)
    .all(addr) as { ts: number }[];
  const scans = db
    .prepare(
      `SELECT scanned_at, volume_24h FROM pool_scans WHERE pool_address = ? ORDER BY scanned_at`
    )
    .all(addr) as { scanned_at: number; volume_24h: number }[];
  if (evs.length < 5 || scans.length < 5) {
    console.log(`${addr.slice(0, 8)}… : échantillon insuffisant (ws=${evs.length}, scans=${scans.length})`);
    continue;
  }
  // buckets ws : 5 min
  const wsByBucket = new Map<number, number>();
  for (const e of evs) {
    const b = Math.floor(e.ts / 300_000) * 300_000;
    wsByBucket.set(b, (wsByBucket.get(b) ?? 0) + 1);
  }
  // buckets scan : delta volume_24h entre scans consécutifs, attribué au bucket du 2e scan
  const scanByBucket = new Map<number, number>();
  for (let i = 1; i < scans.length; i++) {
    const d = Math.max(0, Number(scans[i].volume_24h) - Number(scans[i - 1].volume_24h));
    scanByBucket.set(Math.floor(scans[i].scanned_at / 300_000) * 300_000, d);
  }
  // séries appariées sur les buckets communs
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [b, ws] of wsByBucket) {
    if (scanByBucket.has(b)) {
      xs.push(ws);
      ys.push(scanByBucket.get(b)!);
    }
  }
  const rho = spearman(xs, ys);
  console.log(
    `${addr.slice(0, 8)}… : ρ=${Number.isNaN(rho) ? "n/a" : rho.toFixed(2)} (${xs.length} buckets appariés, ${evs.length} évènements ws)`
  );
}

console.log("\n=== ACCORD BIN ws vs in_range SDK (marks réels) ===");
const pos = db
  .prepare(
    `SELECT rp.id, rp.name, rp.pool_address, rp.min_bin_id, rp.max_bin_id
     FROM real_positions rp WHERE rp.status = 'open'`
  )
  .all() as { id: number; name: string; pool_address: string; min_bin_id: number; max_bin_id: number }[];

for (const p of pos) {
  const marks = db
    .prepare(
      `SELECT taken_at, in_range FROM real_marks WHERE position_id = ? ORDER BY taken_at DESC LIMIT 60`
    )
    .all(p.id) as { taken_at: number; in_range: number }[];
  if (marks.length < 3) {
    console.log(`${p.name.padEnd(16)} : pas assez de marks (${marks.length})`);
    continue;
  }
  let agree = 0;
  let n = 0;
  for (const m of marks) {
    const bin = db
      .prepare(
        `SELECT active_bin_id FROM pool_events_rt WHERE pool_address = ? AND ts <= ? ORDER BY ts DESC LIMIT 1`
      )
      .get(p.pool_address, m.taken_at) as { active_bin_id: number | null } | undefined;
    if (!bin || bin.active_bin_id === null || bin.active_bin_id === undefined) continue;
    const wsInRange = bin.active_bin_id >= p.min_bin_id && bin.active_bin_id <= p.max_bin_id ? 1 : 0;
    if (wsInRange === m.in_range) agree++;
    n++;
  }
  const rate = n ? (100 * agree) / n : 0;
  console.log(`${p.name.padEnd(16)} : accord ${rate.toFixed(0)}% (${agree}/${n}) — bins ws ${p.min_bin_id}..${p.max_bin_id}`);
}
