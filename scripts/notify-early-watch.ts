// Veille des NOUVEAUX signaux spéciaux du scan → Telegram David.
// Remonte : 👁 radar early, 🧹 wash suspect, ⚡ trending court, ⚠️ profil
// réflexif, 📉 fees en déclin marqué (< 30% du rythme 24h, score ≥ 25).
// Dédup : curseur meta `last_earlywatch_scan_id` (id pool_scans) + fichier
// data/earlywatch_notified.json (pool+type, max 1×/jour). Silencieux si rien.

import { db, getMeta, setMeta } from "../src/db.js";
import { getTelegramCreds, sendTelegram } from "../src/telegram.js";
import { config } from "../src/config.js";
import fs from "node:fs";
import path from "node:path";

const NOTIF_FILE = path.join(config.dataDir, "earlywatch_notified.json");
const today = new Date().toISOString().slice(0, 10);

type Notified = Record<string, { date: string; types: string[] }>;

function loadNotified(): Notified {
  try {
    return JSON.parse(fs.readFileSync(NOTIF_FILE, "utf8"));
  } catch {
    return {};
  }
}
function saveNotified(n: Notified) {
  fs.writeFileSync(NOTIF_FILE, JSON.stringify(n));
}
function alreadyNotified(map: Notified, pool: string, type: string): boolean {
  const e = map[pool];
  return !!e && e.date === today && e.types.includes(type);
}
function markNotified(map: Notified, pool: string, type: string) {
  const e = map[pool];
  if (e && e.date === today) {
    if (!e.types.includes(type)) e.types.push(type);
  } else {
    map[pool] = { date: today, types: [type] };
  }
}

interface Item {
  icon: string;
  name: string;
  score: number;
  text: string;
}

async function main(): Promise<void> {
  const creds = getTelegramCreds();
  if (!creds) {
    console.error("[early-watch] pas de creds Telegram");
    process.exit(1);
  }
  const lastId = Number(getMeta("last_earlywatch_scan_id") ?? "0");
  const rows = db
    .prepare("SELECT id, name, score, signals FROM pool_scans WHERE id > ? ORDER BY id")
    .all(lastId) as { id: number; name: string; score: number; signals: string }[];

  let maxId = lastId;
  const map = loadNotified();
  const items: Item[] = [];
  const seen = new Set<string>();

  const collect = (icon: string, r: (typeof rows)[number], type: string, sig: string) => {
    const key = `${r.name}|${type}`;
    if (seen.has(key) || alreadyNotified(map, r.name, type)) return;
    seen.add(key);
    markNotified(map, r.name, type);
    items.push({ icon, name: r.name, score: r.score ?? 0, text: sig });
  };

  for (const r of rows) {
    maxId = Math.max(maxId, r.id);
    let sigs: string[] = [];
    try {
      sigs = JSON.parse(r.signals);
    } catch {
      continue;
    }
    for (const s of sigs) {
      if (s.includes("radar early")) collect("👁", r, "radar", s);
      else if (s.includes("wash suspect")) collect("🧹", r, "wash", s);
      else if (s.includes("trending court")) collect("⚡", r, "trending", s);
      else if (s.includes("réflexif")) collect("⚠️", r, "reflexif", s);
      else if (s.includes("zone Fib")) collect("🎯", r, "fib", s);
      else if (s.includes("fees en déclin")) {
        const m = s.match(/1h = (\d+)%/);
        if (m && Number(m[1]) < 30 && (r.score ?? 0) >= 25) collect("📉", r, "declin", s);
      }
    }
  }

  if (items.length === 0) {
    if (maxId > lastId) setMeta("last_earlywatch_scan_id", String(maxId));
    saveNotified(map);
    return; // silencieux : rien de nouveau
  }

  const short = (t: string) => (t.length > 160 ? t.slice(0, 157) + "…" : t);
  const lines = items.slice(0, 15).map(
    (i) => `${i.icon} ${i.name}${i.score > 0 ? ` (${i.score.toFixed(0)})` : ""} — ${short(i.text)}`
  );
  const h = new Date().toISOString().slice(11, 16) + " UTC";
  const msg = `👁 DLMM early-watch · ${h}\n${lines.join("\n")}`;

  const ok = await sendTelegram(creds.token, creds.chatId, msg);
  if (!ok) {
    console.error("[early-watch] envoi Telegram échoué — curseur non avancé");
    process.exit(1);
  }
  if (maxId > lastId) setMeta("last_earlywatch_scan_id", String(maxId));
  saveNotified(map);
  console.log(`[early-watch] ${items.length} signal(s) envoyé(s)`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error("[early-watch]", e);
    process.exit(1);
  });
}
