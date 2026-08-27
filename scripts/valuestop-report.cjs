#!/usr/bin/env node
// Suivi du value stop-loss (resserré à −15% le 27/08 soir, doctrine David
// « gagner petit et souvent »). DB-only (data/dlmm-bot.db readonly).
// Usage : node scripts/valuestop-report.cjs [--hours=24]
// Sortie texte lisible consommée par le récap quotidien Telegram (job
// 974d6ef204b3) et par le job de verdict J+7 (03/09).
// Critères : perte moyenne des closes value-stop ≤ 30% du dépôt = le filet
// borne (avant le stop : pertes réelles 50-66%) ; REBOND = le prix du pool
// est remonté au-dessus de l'entry après le close (faux positif potentiel).
const Database = require("better-sqlite3");
const db = new Database("data/dlmm-bot.db", { readonly: true });

const hours = parseFloat((process.argv.find((a) => a.startsWith("--hours=")) || "").split("=")[1] || 24);
const since = Date.now() - hours * 3600 * 1000;
const fmt = (t) => new Date(t).toLocaleString("fr-FR", { timeZone: "Europe/Paris", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

const vs = db
  .prepare("SELECT * FROM real_positions WHERE status='closed' AND close_reason='value-stop' AND closed_at>=? ORDER BY closed_at")
  .all(since);

console.log(`=== SUIVI VALUE-STOP (${hours}h : ${fmt(since)} → ${fmt(Date.now())}) ===`);
if (!vs.length) {
  console.log("Aucun close value-stop sur la période.");
} else {
  let tot = 0;
  for (const p of vs) {
    const pnl = (p.last_value_usd || 0) - p.deposit_usd;
    const pct = (pnl / p.deposit_usd) * 100;
    tot += pnl;
    let rebound = false;
    if (p.entry_price > 0) {
      const mx = db
        .prepare("SELECT MAX(current_price) m FROM pool_scans WHERE pool_address=? AND scanned_at>?")
        .get(p.pool_address, p.closed_at);
      if (mx && mx.m > p.entry_price) rebound = true;
    }
    console.log(
      `- ${p.name}: ${pnl.toFixed(0)}$ (${pct.toFixed(1)}% du dépôt ${p.deposit_usd}$) — close ${fmt(p.closed_at)}` +
        (rebound ? " ⚠️ REBOND (prix remonté au-dessus de l'entrée depuis)" : "")
    );
  }
  const avg = (vs.reduce((s, p) => s + ((p.last_value_usd || 0) - p.deposit_usd) / p.deposit_usd, 0) / vs.length) * 100;
  console.log(`Total : ${vs.length} close(s), perte cumulée ${tot.toFixed(0)}$, perte moyenne ${avg.toFixed(1)}% du dépôt.`);
  if (vs.length >= 3) {
    console.log(
      avg <= -30
        ? `VERDICT PRÉLIMINAIRE : perte moyenne ${avg.toFixed(1)}% > 30% — le filet ne borne pas assez, resserrer/auditer.`
        : `VERDICT PRÉLIMINAIRE : perte moyenne ${avg.toFixed(1)}% ≤ 30% — le filet à −15% borne bien (vs 50-66% avant).`
    );
  } else {
    console.log("Échantillon insuffisant (< 3 closes) pour un verdict.");
  }
}

const all = db
  .prepare("SELECT name,close_reason,deposit_usd,last_value_usd,closed_at FROM real_positions WHERE status='closed' AND closed_at>=? ORDER BY closed_at")
  .all(since);
if (all.length) {
  const net = all.reduce((s, p) => s + ((p.last_value_usd || 0) - p.deposit_usd), 0);
  console.log(`\nToutes closes (${all.length}) de la période — PnL net ${net.toFixed(0)}$ :`);
  for (const p of all) {
    const pnl = (p.last_value_usd || 0) - p.deposit_usd;
    console.log(`  ${p.close_reason.padEnd(16)} ${p.name.padEnd(12)} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}$`);
  }
}
