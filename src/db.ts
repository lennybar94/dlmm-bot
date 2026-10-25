import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { config } from "./config.js";

fs.mkdirSync(config.dataDir, { recursive: true });

// ⚠️ LAB : base dédiée via DLMM_DB_PATH (chemin complet, posé par lab/run.sh).
// dotenv NE REMPLACE PAS une variable déjà présente dans process.env — run.sh
// l'exporte AVANT de lancer node, donc le .env du lab ne peut pas l'écraser.
const dbPath = process.env.DLMM_DB_PATH
  ? path.resolve(process.env.DLMM_DB_PATH)
  : path.join(config.dataDir, "dlmm-bot.db");
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

-- Monitor accéléré (RocketScan, 2026-08-23) : observations 60 s du volume des
-- pools chaudes (top N par score) — deltas fins pour l'exit « cooling off »
-- (les scans 5 min seuls donnent des deltas trop grossiers pour le timing du
-- post, qui rafraîchit toutes les 5 s).
CREATE TABLE IF NOT EXISTS accel_observations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  volume_24h REAL,
  volume_30m REAL,
  volume_1h REAL
);
CREATE INDEX IF NOT EXISTS idx_accel_obs ON accel_observations(pool_address, taken_at);

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

CREATE TABLE IF NOT EXISTS real_positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  opened_at INTEGER NOT NULL,
  pool_address TEXT NOT NULL,
  name TEXT,
  strategy TEXT NOT NULL,
  deposit_usd REAL NOT NULL,
  position_pubkey TEXT NOT NULL,
  sig TEXT,
  min_bin_id INTEGER,
  max_bin_id INTEGER,
  bin_step INTEGER,
  entry_price REAL,
  token_x_symbol TEXT,
  token_y_symbol TEXT,
  amount_x REAL,
  amount_y REAL,
  status TEXT DEFAULT 'open',
  closed_at INTEGER,
  close_reason TEXT,
  last_value_usd REAL,
  last_mark_at INTEGER
);

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

-- Blacklist post-close (playbook gud, 2026-08-24) : « dead chart = dead
-- position » — un token fermé avec un volume 24h < seuil est blacklisté
-- POST_CLOSE_BLACKLIST_HOURS pour ne pas ré-entrer sur un chart mort
-- (leçon omo : 6 ré-ouvertures sur le même token en 24 h). Clé = symbol
-- token (minuscule), cohérente avec la dédup open-paper.
CREATE TABLE IF NOT EXISTS token_blacklist (
  token_key TEXT PRIMARY KEY,
  blacklisted_at INTEGER NOT NULL,
  until INTEGER NOT NULL,
  reason TEXT,
  pool_address TEXT
);
CREATE INDEX IF NOT EXISTS idx_blacklist_until ON token_blacklist(until);
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

// ── Migration d'UNITÉ (fix 25/10, étape 2/4) ──
// pool_scans.vol_24h et outcome_reviews.vol_24h historiques sont sur l'échelle GONFLÉE ×√24
// (bougies DAILY traitées en horaires). Les seuils étant désormais en σ daily direct, un
// ancien 0,15 serait classé « > 6 % » au lieu de « moyen » : le tuner apprendrait sur des
// bandes fausses. Division UNE SEULE FOIS par √24, idempotente via meta.
// ⚠️ IRRÉVERSIBLE sur la base touchée : sauvegarder le fichier AVANT la première exécution
// (procédure dans la PR). Le code de main relit mal une base déjà migrée.
if (!getMeta("sigma_unit_fix_at")) {
  const cut = Date.now();
  const sq = Math.sqrt(24);
  db.transaction(() => {
    db.prepare(
      `UPDATE pool_scans SET vol_24h = vol_24h / ? WHERE scanned_at < ? AND vol_24h IS NOT NULL AND vol_24h > 0`
    ).run(sq, cut);
    db.prepare(
      `UPDATE outcome_reviews SET vol_24h = vol_24h / ? WHERE reviewed_at < ? AND vol_24h IS NOT NULL AND vol_24h > 0`
    ).run(sq, cut);
    setMeta("sigma_unit_fix_at", String(cut));
  })();
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

/** Blackliste un token (clé = symbol minuscule) pour `hours` heures. */
export function blacklistToken(
  tokenKey: string,
  hours: number,
  reason: string,
  poolAddress?: string | null
): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO token_blacklist (token_key, blacklisted_at, until, reason, pool_address)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(token_key) DO UPDATE SET
       blacklisted_at = excluded.blacklisted_at,
       until = excluded.until,
       reason = excluded.reason,
       pool_address = excluded.pool_address`
  ).run(tokenKey.toLowerCase(), now, now + hours * 3_600_000, reason, poolAddress ?? null);
}

/** Retourne l'entrée blacklist encore active pour ce token, ou null. */
export function isTokenBlacklisted(
  tokenKey: string
): { until: number; reason: string } | null {
  const row = db
    .prepare(`SELECT until, reason FROM token_blacklist WHERE token_key = ? AND until > ?`)
    .get(tokenKey.toLowerCase(), Date.now()) as { until: number; reason: string } | undefined;
  return row ?? null;
}

// Quotes de base — ne JAMAIS les blacklister : ils peuvent apparaître en
// token_x de pools (ex. SOL-USDC, SOL-cbBTC… 14 235 scans « SOL » en X sur 7 j
// — revue 2026-08-24) et un close à petit volume les blacklisterait, bloquant
// TOUT le book (les candidats open-paper prennent la clé = token_x.symbol).
export const RESERVED_QUOTE_TOKENS = new Set(["sol", "wsol", "usdc", "usdt"]);

/** True si le token peut être blacklisté (pas une quote réservée). */
export function isBlacklistableToken(tokenKey: string): boolean {
  return !RESERVED_QUOTE_TOKENS.has(tokenKey.toLowerCase());
}

// --- Migration L4-B (pilote token, 2026-08-29) ---
// Flag `pilot` sur real_positions : isole les positions du pilote (spot/curve
// balancés sur tokens établis) des stats du book Y-only. Table pilot_inventory :
// inventaire token acheté EN ATTENTE de dépôt — le sweep des résidus doit
// l'exclure (un token acheté pour une position pilote n'est PAS un résidu).
const realPositionCols = db
  .prepare("PRAGMA table_info(real_positions)")
  .all() as { name: string }[];
if (!realPositionCols.some((c) => c.name === "pilot")) {
  db.exec("ALTER TABLE real_positions ADD COLUMN pilot INTEGER DEFAULT 0");
}
if (!realPositionCols.some((c) => c.name === "invested_sol")) {
  // Capital TOTAL engagé (SOL) pour une position — pour le pilote L4-B
  // balancé, le ref du PnL = achat du token X + dépôt SOL (amount_y seul
  // sous-estime — le token X est ACHETÉ, pas seulement déposé). NULL pour
  // les positions du book (ref = amount_y, comportement historique).
  db.exec("ALTER TABLE real_positions ADD COLUMN invested_sol REAL");
}

db.exec(`CREATE TABLE IF NOT EXISTS pilot_inventory (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mint TEXT NOT NULL,
  pool_address TEXT NOT NULL,
  symbol TEXT,
  amount_raw TEXT NOT NULL,
  amount_ui REAL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | deposited | swept | failed
  created_at INTEGER NOT NULL,
  updated_at INTEGER
)`);
db.exec("CREATE INDEX IF NOT EXISTS idx_pilot_inv_status ON pilot_inventory(status)");

/** Inventaire pilote en attente de dépôt pour ce mint (garde sweep) ? */
export function isPilotInventoryPending(mint: string): boolean {
  const row = db
    .prepare("SELECT 1 FROM pilot_inventory WHERE mint = ? AND status = 'pending' LIMIT 1")
    .get(mint) as { 1: number } | undefined;
  return !!row;
}
