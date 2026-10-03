// Init du LAB : crée lab.db (schéma complet via import src/db.js) et y copie
// les RÈGLES versionnées de la prod (rule_sets + rule_changes) pour que le lab
// démarre sur la même base d'apprentissage que la machine réelle. Le tuner du
// lab itérera sur la COPIE, jamais l'originale.
// Usage : lab/run.sh init   (DLMM_LAB_SRC=/chemin/vers/dlmm-bot.db pour pointer
// une autre base source ; par défaut data/dlmm-bot.db de ce repo).
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

if (!process.env.LAB_MODE) {
  console.error("⛔ Ce script ne tourne qu'en LAB_MODE (via lab/run.sh).");
  process.exit(1);
}

// (repo en "type":"module" → __dirname n'existe pas ; fix 03/10)
const botRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const srcPath =
  process.env.DLMM_LAB_SRC ?? path.join(botRoot, "data", "dlmm-bot.db");
const labDbPath = process.env.DLMM_DB_PATH;
if (!labDbPath) {
  console.error("⛔ DLMM_DB_PATH absent — lancer via lab/run.sh.");
  process.exit(1);
}

console.log(`Source (lecture seule) : ${srcPath}`);
console.log(`Lab                    : ${labDbPath}`);

// Import src/db.js APRÈS avoir posé les variables → le schéma complet est créé
// dans lab.db (CREATE TABLE IF NOT EXISTS partout).
await import("../src/db.js");

const src = new Database(srcPath, { readonly: true });
const lab = new Database(labDbPath);

const tables = ["rule_sets", "rule_changes"];
for (const t of tables) {
  const rows = src.prepare(`SELECT * FROM ${t}`).all() as Record<string, unknown>[];
  if (!rows.length) {
    console.log(`${t}: vide en source — rien à copier.`);
    continue;
  }
  const cols = Object.keys(rows[0]);
  const insert = lab.prepare(
    `INSERT OR REPLACE INTO ${t} (${cols.join(", ")}) VALUES (${cols.map((c) => "$" + c).join(", ")})`
  );
  lab.transaction(() => {
    lab.prepare(`DELETE FROM ${t}`).run();
    for (const r of rows) insert.run(r);
  })();
  console.log(`${t}: ${rows.length} ligne(s) copiée(s).`);
}

// Le dashboard (export.ts) lit real_marks : cette table est créée par le cron
// real-monitor en prod, jamais par src/db.ts → en lab elle doit être pré-créée
// (sinon /api/dashboard.json → 500 « no such table: real_marks » ; leçon 03/10).
lab.exec(`CREATE TABLE IF NOT EXISTS real_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at INTEGER NOT NULL,
  position_id INTEGER NOT NULL,
  price REAL,
  value_usd REAL,
  fees_usd REAL,
  net_pnl_usd REAL,
  in_range INTEGER
)`);
lab.exec(`CREATE INDEX IF NOT EXISTS idx_real_marks_pos ON real_marks(position_id, id)`);

// Snapshot des filtres actifs (traçabilité de l'expérience) : on consigne les
// valeurs courantes du config lab dans meta.
const { config } = await import("../src/config.js");
const snap = {
  taken_at: Date.now(),
  minTvl: config.minTvl,
  minVolume24hBidask: config.minVolume24hBidask,
  minDipDrawdown: config.minDipDrawdown,
  valueStopLoss: config.valueStopLoss,
  maxTopblastPositions: config.maxTopblastPositions,
  bookTakeProfitUsd: config.bookTakeProfitUsd,
  trendFilterShadow: config.trendFilterShadow,
  maxPositions: config.maxPositions,
};
lab
  .prepare(
    `INSERT INTO meta (key, value) VALUES ('lab_filters_snapshot', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  )
  .run(JSON.stringify(snap));
console.log("Snapshot des filtres consigné dans meta.lab_filters_snapshot.");

src.close();
lab.close();
console.log("✓ Lab initialisé. Prochaine étape : lab/run.sh monitor");
