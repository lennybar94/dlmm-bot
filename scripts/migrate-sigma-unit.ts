// Conversion d'unité σ — LA unique façon de migrer (audit PR #3). db.ts ne migre plus seul.
// Usage : npm run migrate:sigma-unit -- --db=<chemin> --confirm-backup
import { db, migrateSigmaUnit, sigmaUnitStatus } from "../src/db.js";

const argv = process.argv.slice(2);
const confirm = argv.includes("--confirm-backup");
const dbArg = argv.map((a) => a.match(/^--db=(.*)$/)).find(Boolean)?.[1];
if (dbArg) console.log(`base visée (DLMM_DB_PATH) : ${process.env.DLMM_DB_PATH ?? "(défaut config)"}`);

const before = sigmaUnitStatus();
if (before.migratedAt) {
  console.log(`Déjà migré le ${new Date(before.migratedAt).toISOString()} — aucun traitement.`);
  process.exit(0);
}
console.log("max vol_24h avant :", (db.prepare(`SELECT MAX(vol_24h) m FROM pool_scans WHERE vol_24h>0`).get() as { m: number }).m?.toFixed(4));
const r = migrateSigmaUnit({ confirmedBackup: confirm });
console.log(r.ok ? "OK —" : "REFUSÉ —", r.message);
if (!r.ok && !confirm)
  console.log("\nRappel : copie d'abord → cp data/dlmm-bot.db data/dlmm-bot.db.pre-s1-$(date +%Y%m%d-%H%M)\npuis relancer avec --confirm-backup.");
process.exit(r.ok ? 0 : 1);
