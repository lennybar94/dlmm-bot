// Creds + envoi Telegram partagés (jamais de secret loggé).
// Token : ~/.hermes/.env (TELEGRAM_BOT_TOKEN) ; chat : ~/.hermes/channel_directory.json
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import dns from "node:dns";

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

// ── Ligne de stats par période, ajoutée à CHAQUE alerte (demande David 21/09) ──
// PnL / Fees / Profit sur 1D, 1W, 1M, 1Y, ALL. Source unique : src/export.ts
// (`real.progression`, la table du dashboard) — surtout PAS une requête SQL
// parallèle, qui divergerait de la convention unifiée le 21/09.
// Garde-fous : calcul en cache 60 s, plafonné à 4 s, toute erreur = pas de ligne.
// Une alerte ne doit jamais être retenue, tronquée ou perdue à cause des stats.
let statsCache: { at: number; line: string | null } = { at: 0, line: null };
const STATS_TTL_MS = 60_000;

const signed = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(0)}`;

export async function periodStatsLine(): Promise<string | null> {
  if (process.env.TELEGRAM_STATS_OFF === "1") return null;
  if (statsCache.at && Date.now() - statsCache.at < STATS_TTL_MS) return statsCache.line;
  let line: string | null = null;
  try {
    const { exportData } = await import("./export.js");
    // exportData() ÉCRIT dashboard.json et renvoie son chemin (il ne renvoie pas
    // le JSON) — ~2 s mesurés, d'où le cache et le plafond de temps.
    const jsonPath = await Promise.race([
      exportData(),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("stats timeout")), 5000)),
    ]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prog = (JSON.parse(fs.readFileSync(jsonPath, "utf8")) as any)?.real?.summary?.progression as
      | Record<string, { pnl?: number; fees?: number; profit?: number }>
      | undefined;
    if (prog) {
      // UNE LIGNE PAR DURÉE (demande David 21/09) :
      //   📊 PnL / fees / profit par période
      //   1D  -10$ / +42$ / +32$
      //   1W  …
      const rows = ["1D", "1W", "1M", "1Y", "ALL"]
        .filter((k) => prog[k])
        .map((k) => {
          const p = prog[k];
          return `${k.padEnd(3)} ${signed(p.pnl ?? 0)}$ / ${signed(p.fees ?? 0)}$ / ${signed(p.profit ?? 0)}$`;
        });
      if (rows.length) line = ["📊 PnL / fees / profit par période", ...rows].join("\n");
    }
  } catch {
    line = null; // RPC saturé, dashboard indisponible… l'alerte part sans les stats
  }
  statsCache = { at: Date.now(), line };
  return line;
}

// Ligne « Gains nets du jour » (demandé David 24/09) : Σ capital pur des closes
// du jour (valeur finale − dépôt, via dernier mark) + sweeps de résidus du jour.
// Même convention que src/report.ts et le bloc 1D du dashboard → les trois
// chiffres racontent la même histoire. null si rien aujourd'hui.
// Date locale YYYY-MM-DD (les clés meta sweep_gains_usd:* sont en jour local depuis 29/09).
function localDay(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function todayGainsLine(): Promise<string | null> {
  try {
    const { db } = await import("./db.js");
    const { getSolPriceUsd } = await import("./export.js");
    const dayStart = new Date();
    dayStart.setHours(0, 0, 0, 0);
    const t0 = dayStart.getTime();
    const closed = db
      .prepare(
        `SELECT m.net_pnl_usd AS pnl, m.fees_usd AS fees
         FROM real_positions p
         JOIN real_marks m ON m.id = (SELECT id FROM real_marks WHERE position_id = p.id ORDER BY id DESC LIMIT 1)
         WHERE p.status = 'closed' AND p.closed_at >= ?`
      )
      .all(t0) as { pnl: number; fees: number }[];
    let cap = 0;
    for (const c of closed) cap += (c.pnl ?? 0) - (c.fees ?? 0);
    let swept = 0;
    const key = `sweep_gains_usd:${localDay(dayStart)}`;
    const row = db.prepare(`SELECT value FROM meta WHERE key=?`).get(key) as { value: string } | undefined;
    if (row) swept = parseFloat(row.value) || 0;
    else {
      const evs = db
        .prepare(`SELECT message FROM events WHERE type='residue-sweep' AND created_at>=?`)
        .all(t0) as { message: string; payload: string | null }[];
      let solSum = 0;
      for (const e of evs) {
        try {
          const pl = e.payload ? JSON.parse(e.payload) : null;
          if (pl && (pl.kind === "conversion" || pl.kind === "unverified")) continue; // richesse inchangée, pas un gain
        } catch { /* pas de payload → on compte */ }
        const m = e.message.match(/\+(-?[0-9.,]+) SOL/);
        if (m) solSum += parseFloat(m[1].replace(",", "."));
      }
      if (solSum > 0) swept = solSum * ((await getSolPriceUsd()) ?? 120);
    }
    const net = cap + swept;
    if (!closed.length && !swept) return null;
    const sgn = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}$`;
    return `📈 Gains nets du jour : ${sgn(net)} (${closed.length} close${closed.length > 1 ? "s" : ""} ${sgn(cap)}, sweeps ${sgn(swept)})`;
  } catch {
    return null;
  }
}

// api.telegram.org se résout en IPv6 depuis ce host et le connect timeout est
// intermittent (même cause que le NODE_OPTIONS=ipv4first de scripts/dlmm-run.sh).
// On le force ici aussi : un envoi lancé à la main (tsx, node -e, script ad hoc)
// doit être aussi fiable qu'un envoi lancé par le launcher.
dns.setDefaultResultOrder("ipv4first");

export async function sendTelegram(token: string, chatId: string, text: string): Promise<boolean> {
  try {
    let body = text;
    const today = await todayGainsLine();
    if (today) body = `${body}\n${today}`;
    const line = await periodStatsLine();
    if (line) {
      const MAX = 4000; // limite Telegram 4096 — on garde de la marge
      // Séparée du message par une ligne vide (demandé David 24/09) ; les stats
      // elles-mêmes restent une ligne par durée.
      body =
        body.length + line.length + 2 > MAX
          ? `${body.slice(0, Math.max(0, MAX - line.length - 4))}\n\n${line}`
          : `${body}\n\n${line}`;
    }
    const post = () =>
      fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: body, disable_web_page_preview: true }),
      });
    let res = await post();
    if (!res.ok) {
      // Trace utile quand un envoi tombe (quota, chat invalide, message trop long…).
      console.error(`[telegram] envoi refusé HTTP ${res.status} : ${(await res.text()).slice(0, 200)}`);
      // Un 429 vaut un nouvel essai (5xx aussi) — sinon on perd l'alerte.
      if (res.status === 429 || res.status >= 500) {
        await new Promise((r) => setTimeout(r, 2000));
        res = await post();
      }
    }
    return res.ok;
  } catch (e) {
    // Réseau : un seul retry, une alerte perdue coûte plus qu'un doublon possible.
    try {
      await new Promise((r) => setTimeout(r, 1500));
      const retry = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      return retry.ok;
    } catch (e2) {
      console.error(`[telegram] envoi impossible : ${(e as Error).message} / retry: ${(e2 as Error).message}`);
      return false;
    }
  }
}
