// Creds + envoi Telegram partagés (jamais de secret loggé).
// Token : ~/.hermes/.env (TELEGRAM_BOT_TOKEN) ; chat : ~/.hermes/channel_directory.json
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

function readEnvFile(file: string): Record<string, string> {
  const out: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(file, "utf8");
    for (const line of raw.split("\n")) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch {
    /* fichier absent → silencieux */
  }
  return out;
}

export function getTelegramCreds(): { token: string; chatId: string } | null {
  // Token : ~/.hermes/.env (jamais loggé)
  const env = readEnvFile(path.join(os.homedir(), ".hermes", ".env"));
  const token = env.TELEGRAM_BOT_TOKEN;
  if (!token) return null;
  // Chat : channel_directory.json (DM David)
  let chatId = "";
  try {
    const dir = JSON.parse(
      fs.readFileSync(path.join(os.homedir(), ".hermes", "channel_directory.json"), "utf8")
    );
    const ch = (dir.platforms?.telegram ?? [])[0];
    chatId = ch?.id ?? "";
  } catch {
    /* silencieux */
  }
  return token && chatId ? { token, chatId } : null;
}

export async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
