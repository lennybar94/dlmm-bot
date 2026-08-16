// Alertes Telegram sur événements clés du bot (open/close/rebalance/exits/DCA).
// Envoie uniquement les événements non encore notifiés.
// Usage : `npm run notify:events` (cron */15 avec le monitor).

import { db, getMeta, setMeta } from "../src/db.js";
import { getTelegramCreds, sendTelegram } from "../src/telegram.js";

// Types d'événements qui méritent une alerte (le bruit scan/monitor est exclu).
// Les exits (bollinger-exit, recovery-exit, hard-stop) sont loggés en type "close"
// avec la raison dans le message → "close" couvre tout.
const ALERT_TYPES = new Set([
  "open",
  "close",
  "rebalance",
  "claim",
  "dca",
]);

export async function notifyEvents(): Promise<number> {
  const creds = getTelegramCreds();
  if (!creds) {
    console.log("[notify] Pas de creds Telegram (bot silencieux).");
    return 0;
  }
  const lastId = Number(getMeta("last_notified_event_id") ?? "0");
  const rows = db
    .prepare(
      `SELECT id, created_at, position_id, pool_address, type, message FROM events
       WHERE id > ? AND type IN (${Array.from(ALERT_TYPES)
         .map(() => "?")
         .join(",")})
       ORDER BY id ASC LIMIT 20`
    )
    .all(lastId, ...Array.from(ALERT_TYPES)) as {
    id: number;
    created_at: number;
    position_id: number | null;
    pool_address: string | null;
    type: string;
    message: string;
  }[];

  let sent = 0;
  let maxId = lastId;
  for (const e of rows) {
    maxId = Math.max(maxId, e.id);
    const icon =
      e.type === "open" ? "🟢" :
      e.type === "close" || e.type === "hard-stop" ? "🔴" :
      e.type === "rebalance" ? "🔄" :
      e.type === "claim" ? "💰" :
      e.type === "dca" ? "📈" : "⚡";
    const ts = new Date(e.created_at).toISOString().slice(11, 16);
    const ok = await sendTelegram(creds.token, creds.chatId, `${icon} [${ts}] DLMM ${e.type}: ${e.message}`);
    if (ok) sent++;
    await new Promise((r) => setTimeout(r, 250)); // rate limit Telegram
  }
  if (maxId > lastId) setMeta("last_notified_event_id", String(maxId));
  return sent;
}

// Exécution directe (scripts/notify-events.ts)
if (import.meta.url === `file://${process.argv[1]}`) {
  const n = await notifyEvents();
  console.log(`[notify] ${n} alerte(s) envoyée(s).`);
}
