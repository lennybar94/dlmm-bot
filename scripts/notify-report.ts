// Récap nocturne Telegram : état du portefeuille + événements de la journée,
// envoyé à minuit (résultat de la nuit + positions overnight).
// Usage : `npm run notify:report` (cron 0 0 * * *).

import { buildDailyReport } from "../src/report.js";
import { getTelegramCreds, sendTelegram } from "../src/telegram.js";

export async function sendNightlyReport(): Promise<boolean> {
  const creds = getTelegramCreds();
  if (!creds) {
    console.log("[notify:report] Pas de creds Telegram (silencieux).");
    return false;
  }
  const report = await buildDailyReport();
  // Telegram : 4096 chars max par message — le rapport est court, on envoie tel quel.
  const header = "🌙 Récap DLMM (overnight)";
  const ok = await sendTelegram(creds.token, creds.chatId, `${header}\n\`\`\`\n${report}\n\`\`\``);
  console.log(ok ? "[notify:report] Récap envoyé." : "[notify:report] Échec envoi.");
  return ok;
}

// Exécution directe
if (import.meta.url === `file://${process.argv[1]}`) {
  await sendNightlyReport();
}
