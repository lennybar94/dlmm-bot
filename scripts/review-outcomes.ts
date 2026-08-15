// Reviews hebdomadaires des positions ouvertes ≥ WEEKLY_REVIEW_DAYS : `npm run review:outcomes`
import { config } from "../src/config.js";
import { runWeeklyReviews } from "../src/review.js";

const n = runWeeklyReviews(config.weeklyReviewDays);
console.log(`${n} review(s) hebdomadaire(s) créée(s) (seuil : ${config.weeklyReviewDays} j).`);
