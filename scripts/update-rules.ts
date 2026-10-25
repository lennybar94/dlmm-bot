// Boucle d'apprentissage : reviews hebdo + auto-réglage des règles : `npm run update:rules`
import { config } from "../src/config.js";
import { runWeeklyReviews } from "../src/review.js";
import { assertSigmaUnitMigrated } from "../src/db.js";
import { runTune } from "../src/tuner.js";

// Le tuner relit outcome_reviews.vol_24h pour classer par bande : refuser une base dont
// ces valeurs sont sur l'ancienne échelle (σ gonflé ×√24) — sinon il réécrirait les règles
// de stratégie sur des bandes fausses. (audit PR #3, point 1)
assertSigmaUnitMigrated("update:rules");
import { getRules, getRuleChanges } from "../src/rules.js";

const weekly = runWeeklyReviews(config.weeklyReviewDays);
if (weekly > 0) console.log(`${weekly} review(s) hebdomadaire(s) créée(s).`);

const tune = runTune();
console.log(`Tuning : ${tune.applied} règle(s) ajustée(s) — ${tune.reason}`);
for (const c of tune.changes) {
  console.log(`  • ${c.key}: ${c.before} → ${c.after}`);
}
if (tune.applied > 0) {
  console.log(`Règles actuelles : v${getRules().version}`);
  for (const ch of getRuleChanges(5)) {
    console.log(`  [v${ch.rule_set_version}] ${ch.key}: ${ch.before_value ?? "—"} → ${ch.after_value ?? "—"} — ${ch.reason}`);
  }
}
