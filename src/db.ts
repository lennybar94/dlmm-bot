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
  sigma_intraday REAL,
  s1_r24 REAL,
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
  sigma_intraday REAL,
  s1_r24 REAL,
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

// Colonnes de mesure S1 (étape 3/4).
if (!poolScanCols.some((c) => c.name === "sigma_intraday")) {
  db.exec("ALTER TABLE pool_scans ADD COLUMN sigma_intraday REAL");
}
if (!poolScanCols.some((c) => c.name === "s1_r24")) {
  db.exec("ALTER TABLE pool_scans ADD COLUMN s1_r24 REAL");
}

// ── Unité σ : LA MIGRATION N'AUTOMATIQUE (audit PR #3, point important) ──
// pool_scans.vol_24h et outcome_reviews.vol_24h historiques sont sur l'échelle GONFLÉE ×√24.
// Les seuils étant en σ daily direct, un ancien 0,15 serait lu « > 6 % » au lieu de « moyen »
// et le tuner apprendrait sur des bandes fausses. La conversion est IRRÉVERSIBLE et main
// relit mal une base déjà convertie : elle ne doit donc JAMAIS se déclencher par un simple
// import de db.ts (dashboard, rapport, real-monitor sur la mauvaise base suffisaient).
// → commande explicite : npm run migrate:sigma-unit   (scripts/migrate-sigma-unit.ts)
// Le marqueur meta sigma_unit_fix_at sert à la fois de preuve et de garde anti-double-pass.
const SIGMA_MIGRATION_KEY = "sigma_unit_fix_at";

/** État de la base vis-à-vis de l'unité σ (utilisé par le script de migration). */
export function sigmaUnitStatus(): { migratedAt: number | null } {
  const row = sigmaUnitStatusRaw() as
    | { value: string }
    | undefined;
  return { migratedAt: row ? Number(row.value) : null };
}

/** Convertit une seule fois vol_24h (÷√24). Refuse si déjà fait ; exige une sauvegarde. */
export function migrateSigmaUnit(opts: { confirmedBackup: boolean }): { ok: boolean; message: string } {
  if (!opts.confirmedBackup)
    return { ok: false, message: "Refusé : sauvegarde du fichier .env/DB non confirmée (--confirm-backup)." };
  const cur = sigmaUnitStatusRaw() as { value: string } | undefined;
  if (cur) return { ok: false, message: `Déjà migré (${cur.value}) — aucun traitement.` };
  const cut = Date.now();
  const sq = Math.sqrt(24);
  db.transaction(() => {
    const a = db.prepare(
      `UPDATE pool_scans SET vol_24h = vol_24h / ? WHERE scanned_at < ? AND vol_24h IS NOT NULL AND vol_24h > 0`
    ).run(sq, cut);
    const b = db.prepare(
      `UPDATE outcome_reviews SET vol_24h = vol_24h / ? WHERE reviewed_at < ? AND vol_24h IS NOT NULL AND vol_24h > 0`
    ).run(sq, cut);
    db.prepare(
      `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(SIGMA_MIGRATION_KEY, String(cut));
    setMeta("sigma_unit_migration_rows", `${a.changes}+${b.changes}`);
  })();
  const rows = getMeta("sigma_unit_migration_rows") ?? "?";
  return { ok: true, message: `vol_24h divisé par √24 — lignes traitées ${rows}, marqueur ${cut}.` };
}

// ── Garde d'échelle sur les données LUES (audit PR #3, points 1 à 3) ──
// Les seuils de bande sont en σ journalier DIRECT depuis le fix √24. Une base qui
// contient encore des vol_24h gonflés ×√24 ferait classer presque tout en « élevé » par
// le tuner, qui peut réécrire seul les règles de stratégie. La migration ne partant plus
// toute seule, il faut refuser de LIRE ces bases-là.
//
// ⚠️ Le repère est le CONTENU, jamais une date. Deux raisons, toutes deux mesurées :
//   · la coupure du premier essai (1792500000000) valait en réalité 20/10 12:40 UTC, alors
//     que le commentaire annonçait « 25/10 ~16h30 CET » ; et le dernier scan de l'archive
//     est 20/10 18:35, donc APRÈS cette coupure → la garde aurait déclaré « rien à
//     convertir » et posé le marqueur sur 711 361 lignes non converties.
//   · une date ne dit pas si une base est convertie : après une exécution accidentelle du
//     code de main, d'anciennes ET de nouvelles lignes coexistent, toutes gonflées.
// Règle : marqueur absent + au moins une ligne vol_24h > 0 → REFUS. Marqueur absent +
// aucune ligne → on pose le marqueur (base neuve : rien à convertir, et il est posé avant
// la première écriture, donc elle ne sera jamais refusée ensuite).
/** Lecture directe du marqueur (SIGMA_MIGRATION_KEY est déclaré plus bas dans le fichier). */
function sigmaUnitStatusRaw(): { value: string } | undefined {
  return db.prepare(`SELECT value FROM meta WHERE key = 'sigma_unit_fix_at'`).get() as { value: string } | undefined;
}

/** true si la base contient des volatilités non converties (échelle gonflée ×√24). */
export function sigmaUnitNeedsMigration(): boolean {
  if (sigmaUnitStatusRaw() !== undefined) return false;
  const rows = db.prepare(`SELECT COUNT(*) c FROM pool_scans WHERE vol_24h IS NOT NULL AND vol_24h > 0`).get() as { c: number };
  return rows.c > 0;
}

/** Sur base vide uniquement : pose le marqueur, puisqu'il n'y a rien à convertir. */
export function ensureSigmaUnitMarker(): void {
  if (sigmaUnitStatusRaw() !== undefined) return;
  const rows = db.prepare(`SELECT COUNT(*) c FROM pool_scans WHERE vol_24h IS NOT NULL AND vol_24h > 0`).get() as { c: number };
  if (rows.c === 0) {
    setMeta(SIGMA_MIGRATION_KEY, String(Date.now()));
    setMeta("sigma_unit_note", "base sans aucune volatilité stockée : marqueur posé sans conversion");
  }
}

/** Refuse de lire/écrire sur une base dont le vol_24h est sur l'ancienne échelle. */
export function assertSigmaUnitMigrated(who: string): void {
  if (!sigmaUnitNeedsMigration()) return;
  const rows = (db.prepare(`SELECT COUNT(*) c FROM pool_scans WHERE vol_24h IS NOT NULL AND vol_24h > 0`).get() as { c: number }).c;
  throw new Error(
    `[ÉCHELLE σ] ${who} refuse de démarrer : cette base contient ${rows} lignes de vol_24h ` +
      `sur l'ANCIENNE échelle (σ gonflé ×√24) et le marqueur meta '${SIGMA_MIGRATION_KEY}' est ` +
      `absent. Le tuner classifierait ces lignes dans de fausses bandes et pourrait réécrire ` +
      `les règles de stratégie dessus. Sauvegarder puis convertir :\n` +
      `  cp <db> <db>.pre-s1-$(date +%Y%m%d-%H%M)\n` +
      `  npm run migrate:sigma-unit -- --confirm-backup\n` +
      `(DLMM_DB_PATH actuel : ${process.env.DLMM_DB_PATH ?? "défaut data/dlmm-bot.db"})`
  );
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
