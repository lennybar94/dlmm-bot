// Boucle d'apprentissage : reviews hebdo + auto-réglage des règles : `npm run update:rules`
import { config } from "../src/config.js";
import { runWeeklyReviews } from "../src/review.js";
import { runTune } from "../src/tuner.js";

// Pas d'appel séparé à assertSigmaUnitMigrated ici : runTune() le fait en tête, et le faire
// deux fois masque quel chemin a refusé. La garde couvre désormais pool_scans ET
// outcome_reviews, y compris les reviews créées par la revue hebdo plus bas. (mineur 2)
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
