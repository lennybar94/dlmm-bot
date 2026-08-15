// Règles dynamiques du bot : un jeu de règles versionné, ajusté par le tuner
// à partir des outcome reviews (boucle d'apprentissage). Les valeurs par défaut
// reflètent le .env ; chaque réglage auto produit un nouveau version avec raison.

import { db } from "./db.js";
import { config } from "./config.js";

export interface RuleSet {
  version: number;
  createdAt: number;
  // pondérations du score d'opportunité
  wApr: number;
  wVolStability: number;
  wTvl: number;
  wBase: number;
  farmBonus: number;
  volPenalty: number;
  // filtres
  minFeeTvlRatio24h: number; // % fees/TVL 24h minimum
  // gestion des positions
  rebalanceThreshold: number;
  // choix de stratégie par bande de volatilité journalière
  strategyByVol: { low: string; mid: string; high: string };
  reason?: string;
}

export const DEFAULT_RULES: RuleSet = {
  version: 1,
  createdAt: 0,
  wApr: 60,
  wVolStability: 20,
  wTvl: 15,
  wBase: 5,
  farmBonus: 0.05,
  volPenalty: -0.1,
  minFeeTvlRatio24h: config.minFeeTvlRatio24h,
  rebalanceThreshold: config.rebalanceThreshold,
  strategyByVol: { low: "curve", mid: "spot-spread", high: "spot-wide" },
  reason: "règles initiales (défauts .env)",
};

const insertSet = db.prepare(
  "INSERT INTO rule_sets (version, created_at, rules, reason) VALUES (?, ?, ?, ?)"
);

/** Dernier jeu de règles connu (sinon défauts, persistés en version 1). */
export function getRules(): RuleSet {
  const row = db
    .prepare("SELECT rules FROM rule_sets ORDER BY version DESC LIMIT 1")
    .get() as { rules: string } | undefined;
  if (row) {
    try {
      return JSON.parse(row.rules) as RuleSet;
    } catch {
      // règles corrompues → on repart des défauts
    }
  }
  const defaults = { ...DEFAULT_RULES, createdAt: Date.now() };
  insertSet.run(1, defaults.createdAt, JSON.stringify(defaults), defaults.reason ?? null);
  return defaults;
}

/** Applique un changement de règle : nouveau version + trace (before/after/reason). */
export function applyRuleChange(
  key: keyof RuleSet | string,
  before: unknown,
  after: unknown,
  reason: string
): RuleSet {
  const current = getRules();
  const next = { ...current, [key]: after, version: current.version + 1, createdAt: Date.now(), reason };
  const beforeVal = typeof before === "number" ? before : null;
  const afterVal = typeof after === "number" ? after : null;
  insertSet.run(next.version, next.createdAt, JSON.stringify(next), reason);
  db.prepare(
    "INSERT INTO rule_changes (created_at, rule_set_version, key, before_value, after_value, reason) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(Date.now(), next.version, String(key), beforeVal, afterVal, reason);
  return next;
}

/** Historique des changements de règles. */
export function getRuleChanges(limit = 25): {
  created_at: number;
  rule_set_version: number;
  key: string;
  before_value: number | null;
  after_value: number | null;
  reason: string;
}[] {
  return db
    .prepare(
      "SELECT created_at, rule_set_version, key, before_value, after_value, reason FROM rule_changes ORDER BY id DESC LIMIT ?"
    )
    .all(limit) as {
    created_at: number;
    rule_set_version: number;
    key: string;
    before_value: number | null;
    after_value: number | null;
    reason: string;
  }[];
}

/** Stratégie à utiliser selon la volatilité journalière (règles apprises). */
export function strategyForVolatility(volDaily: number, rules = getRules()): string {
  if (volDaily < 0.1) return rules.strategyByVol.low;
  if (volDaily < 0.3) return rules.strategyByVol.mid;
  return rules.strategyByVol.high;
}
