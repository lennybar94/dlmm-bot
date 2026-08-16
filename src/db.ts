import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

const dbPath = path.join(config.dataDir, "dlmm-bot.db");
export const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS pool_scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scanned_at INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  name TEXT,
  token_x_symbol TEXT,
  token_y_symbol TEXT,
  tvl REAL,
  volume_1h REAL,
  volume_30m REAL,
  volume_24h REAL,
  fee_tvl_ratio_1h REAL,
  fee_tvl_ratio_30m REAL,
  fee_tvl_ratio_24h REAL,
  fee_apr_24h REAL,
  farm_apr REAL,
  base_fee_pct REAL,
  dynamic_fee_pct REAL,
  bin_step INTEGER,
  launchpad TEXT,
  is_blacklisted INTEGER,
  current_price REAL,
  vol_24h REAL,
  score REAL,
  signals TEXT,
  strategy_hint TEXT,
  pool_age_days REAL,
  created_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_pool_scans_addr ON pool_scans(pool_address, scanned_at);

CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  name TEXT,
  score REAL,
  fee_apr_24h REAL,
  tvl REAL,
  volume_24h REAL,
  signal_type TEXT,
  message TEXT
);
CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);

CREATE TABLE IF NOT EXISTS paper_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  name TEXT,
  strategy TEXT NOT NULL,
  deposit_usd REAL NOT NULL,
  min_bin_id INTEGER,
  max_bin_id INTEGER,
  bin_step INTEGER,
  entry_price REAL,
  entry_active_bin INTEGER,
  token_x_symbol TEXT,
  token_y_symbol TEXT,
  amount_x REAL,
  amount_y REAL,
  fees_earned_usd REAL DEFAULT 0,
  fees_claimed_usd REAL DEFAULT 0,
  status TEXT DEFAULT 'open',
  closed_at INTEGER,
  close_reason TEXT,
  last_mark_price REAL,
  last_value_usd REAL,
  last_il_usd REAL,
  rebalance_count INTEGER DEFAULT 0,
  day_start_price REAL,
  last_mark_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON paper_positions(status);

CREATE TABLE IF NOT EXISTS pnl_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at INTEGER NOT NULL,
  position_id INTEGER NOT NULL,
  price REAL,
  value_usd REAL,
  fees_usd REAL,
  il_usd REAL,
  net_pnl_usd REAL,
  in_range INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snapshots_pos ON pnl_snapshots(position_id, taken_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  position_id INTEGER,
  pool_address TEXT,
  type TEXT,
  message TEXT,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);

CREATE TABLE IF NOT EXISTS outcome_reviews (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  review_type TEXT NOT NULL,          -- 'closed' (à la fermeture) | 'weekly' (position ouverte ≥ 7j)
  reviewed_at INTEGER NOT NULL,
  pool_address TEXT,
  name TEXT,
  strategy TEXT,
  opened_at INTEGER,
  closed_at INTEGER,
  age_days REAL,
  deposit_usd REAL,
  value_usd REAL,
  fees_usd REAL,
  il_usd REAL,
  net_pnl_usd REAL,
  net_pnl_pct REAL,
  exit_reason TEXT,
  in_range_pct REAL,
  rebalance_count INTEGER,
  -- buckets d'évidence (caractéristiques d'entrée, dénormalisées)
  fee_tvl_ratio_24h REAL,
  vol_24h REAL,
  bin_step INTEGER,
  launchpad TEXT,
  pool_age_days REAL,
  tvl REAL
);
CREATE INDEX IF NOT EXISTS idx_reviews_pos ON outcome_reviews(position_id, review_type);
CREATE INDEX IF NOT EXISTS idx_reviews_reviewed ON outcome_reviews(reviewed_at);

CREATE TABLE IF NOT EXISTS rule_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  rules TEXT NOT NULL,
  reason TEXT
);

CREATE TABLE IF NOT EXISTS rule_changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  rule_set_version INTEGER,
  key TEXT,
  before_value REAL,
  after_value REAL,
  reason TEXT
);
`;

db.exec(SCHEMA);

// Migrations idempotentes (DB existantes créées avant l'ajout de colonnes)
const poolScanCols = db.prepare("PRAGMA table_info(pool_scans)").all() as { name: string }[];
if (!poolScanCols.some((c) => c.name === "pool_age_days")) {
  db.exec("ALTER TABLE pool_scans ADD COLUMN pool_age_days REAL");
}
if (!poolScanCols.some((c) => c.name === "created_at")) {
  db.exec("ALTER TABLE pool_scans ADD COLUMN created_at INTEGER");
}
if (!poolScanCols.some((c) => c.name === "volume_30m")) {
  db.exec("ALTER TABLE pool_scans ADD COLUMN volume_30m REAL");
}
if (!poolScanCols.some((c) => c.name === "fee_tvl_ratio_30m")) {
  db.exec("ALTER TABLE pool_scans ADD COLUMN fee_tvl_ratio_30m REAL");
}

export function setMeta(key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}

export function getMeta(key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function logEvent(
  type: string,
  message: string,
  opts: { positionId?: number | null; poolAddress?: string | null; payload?: unknown } = {}
): void {
  db.prepare(
    "INSERT INTO events (created_at, position_id, pool_address, type, message, payload) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(
    Date.now(),
    opts.positionId ?? null,
    opts.poolAddress ?? null,
    type,
    message,
    opts.payload ? JSON.stringify(opts.payload) : null
  );
}
