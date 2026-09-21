#!/usr/bin/env node
// Suivi du value stop-loss (resserré à −15% le 27/08 soir, doctrine David
// « gagner petit et souvent »). DB-only (data/dlmm-bot.db readonly).
// Usage : node scripts/valuestop-report.cjs [--hours=24]
// Sortie texte lisible consommée par le récap quotidien Telegram (job
// 974d6ef204b3) et par le job de verdict hebdo (59c3fe3329f0).
//
// Correctif du 21/09/2026 — unification des métriques. L'ancienne version
// calculait `last_value_usd − deposit_usd`, c'est-à-dire SANS les fees
// (en attente comme réclamées) : les mêmes 61 closes de la semaine
// s'affichaient +32 $ ici et +282 $ sur le dashboard, ce qui faisait passer
// deux jobs Telegram pour contradictoires. Convention alignée sur le dashboard
// (src/export.ts) :
//     PnL d'une close   = net_pnl_usd du dernier mark  (fees en attente incluses)
//     global            = Σ net des marks + Σ fees réclamées en cours de vie
// L'ancienne valeur reste affichée, étiquetée « hors fees », pour la continuité
// des chiffres déjà envoyés à David.
//
// Critères : perte moyenne des closes value-stop ≤ 30% du dépôt = le filet
// borne (avant le stop : pertes réelles 50-66%) ; REBOND = le prix du pool
// est remonté au-dessus de l'entry après le close (faux positif potentiel).
const Database = require("better-sqlite3");
const db = new Database("data/dlmm-bot.db", { readonly: true });

const hours = parseFloat((process.argv.find((a) => a.startsWith("--hours=")) || "").split("=")[1] || 24);
const since = Date.now() - hours * 3600 * 1000;
const fmt = (t) =>
  new Date(t).toLocaleString("fr-FR", {
    timeZone: "Europe/Paris",
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });

// PnL canonique = dernier mark (fees en attente incluses) ; repli sur
// last_value − deposit pour les closes sans mark (ex. kill-switch STONK).
const MARK = `(SELECT m.net_pnl_usd FROM real_marks m WHERE m.position_id=p.id ORDER BY m.id DESC LIMIT 1)`;
const FEES = `(SELECT m.fees_usd FROM real_marks m WHERE m.position_id=p.id ORDER BY m.id DESC LIMIT 1)`;
const canon = (r) => (r.mark_net != null ? r.mark_net : (r.last_value_usd || 0) - r.deposit_usd);
const legacy = (r) => (r.last_value_usd || 0) - r.deposit_usd;

const claimsIn = (from) => {
  let tot = 0;
  for (const c of db
    .prepare("SELECT message FROM events WHERE type='real-claim' AND created_at>=?")
    .all(from)) {
    const m = (c.message ?? "").match(/([0-9]+\.[0-9]+)\$/);
    if (m) tot += parseFloat(m[1]);
  }
  return tot;
};

const vs = db
  .prepare(
    `SELECT p.*, ${MARK} AS mark_net, ${FEES} AS mark_fees FROM real_positions p
     WHERE p.status='closed' AND p.close_reason='value-stop' AND p.closed_at>=? ORDER BY p.closed_at`
  )
  .all(since);

console.log(`=== SUIVI VALUE-STOP (${hours}h : ${fmt(since)} → ${fmt(Date.now())}) ===`);
console.log("Convention : net du dernier mark, fees en attente incluses (aligné dashboard).");
if (!vs.length) {
  console.log("Aucun close value-stop sur la période.");
} else {
  let tot = 0;
  for (const p of vs) {
    const pnl = canon(p);
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
      `- ${p.name}: ${pnl.toFixed(0)}$ (${pct.toFixed(1)}% du dépôt ${p.deposit_usd}$)` +
        ` [fees ${(p.mark_fees || 0).toFixed(0)}$, hors fees ${legacy(p).toFixed(0)}$]` +
        ` — close ${fmt(p.closed_at)}` +
        (rebound ? " ⚠️ REBOND (prix remonté au-dessus de l'entrée depuis)" : "")
    );
  }
  const avg = (vs.reduce((s, p) => s + canon(p) / p.deposit_usd, 0) / vs.length) * 100;
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
  .prepare(
    `SELECT p.name, p.close_reason, p.deposit_usd, ${MARK} AS mark_net, ${FEES} AS mark_fees,
            p.last_value_usd, p.closed_at
     FROM real_positions p WHERE p.status='closed' AND p.closed_at>=? ORDER BY p.closed_at`
  )
  .all(since);
if (all.length) {
  const net = all.reduce((s, p) => s + canon(p), 0);
  const feesCloses = all.reduce((s, p) => s + (p.mark_fees || 0), 0);
  const claims = claimsIn(since);
  console.log(`\nToutes closes (${all.length}) de la période :`);
  console.log(`  net des marks        ${net.toFixed(0)}$  (dont ${feesCloses.toFixed(0)}$ de fees encaissées à la clôture)`);
  console.log(`  + fees réclamées     ${claims.toFixed(0)}$`);
  console.log(`  = GLOBAL             ${(net + claims).toFixed(0)}$`);
  console.log(`  (ancienne convention « hors fees » : ${all.reduce((s, p) => s + legacy(p), 0).toFixed(0)}$)`);
  for (const p of all) {
    const pnl = canon(p);
    console.log(`  ${(p.close_reason || "?").padEnd(16)} ${p.name.padEnd(12)} ${pnl >= 0 ? "+" : ""}${pnl.toFixed(0)}$`);
  }
}
