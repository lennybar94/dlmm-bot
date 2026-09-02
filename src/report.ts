// Rapport quotidien : résumé positions réelles, frais, opportunités, événements.
// Régime machine réelle (24/08) : le paper est dormant → plus aucune section
// paper dans le rapport (tri d'alertes 26/08 — le Telegram ne porte que le réel).

import { db } from "./db.js";
import { getRules, getRuleChanges } from "./rules.js";
import { getSolPriceUsd } from "./export.js";

export async function buildDailyReport(): Promise<string> {
  const lines: string[] = [];
  const now = new Date();
  lines.push(`=== Rapport DLMM ${now.toISOString().slice(0, 16).replace("T", " ") } ===`);
  lines.push("");

  // Statut du bot (fraîcheur de l'activité réelle)
  const lastScan = db.prepare("SELECT MAX(scanned_at) m FROM pool_scans").get() as {
    m: number | null;
  };
  const lastMark = db.prepare("SELECT MAX(taken_at) m FROM pnl_snapshots").get() as {
    m: number | null;
  };
  const lastAct = Math.max(lastScan.m ?? 0, lastMark.m ?? 0);
  if (lastAct > 0) {
    const mins = Math.round((Date.now() - lastAct) / 60000);
    const status =
      mins <= 35 ? "EN LIGNE" : mins <= 120 ? "DONNÉES PÉRIMÉES" : "HORS LIGNE";
    lines.push(`Statut bot : ${status} (dernière activité il y a ${mins} min)`);
    lines.push("");
  }

  const rules = getRules();
  const lastChange = getRuleChanges(1)[0];
  lines.push(`Règles : v${rules.version}${rules.reason ? ` — ${rules.reason}` : ""}`);
  if (lastChange) {
    lines.push(
      `  Dernier ajustement : ${lastChange.key} ${lastChange.before_value ?? "—"} → ${lastChange.after_value ?? "—"} (${lastChange.reason})`
    );
  }
  lines.push("");

  // Pilote réel : une ligne par position ouverte + totaux (tri alertes 22/08 —
  // le rapport quotidien est LE canal informatif ; Telegram ne porte que le
  // mandataire : auto-close, hard-stop, introuvable, watchdog).
  const realRows = db
    .prepare(`SELECT * FROM real_positions WHERE status='open' ORDER BY id`)
    .all() as Record<string, any>[];
  if (realRows.length) {
    let totPnl = 0;
    let totFees = 0;
    let totSol = 0;
    lines.push("Pilote réel :");
    for (const r of realRows) {
      const mark = db
        .prepare(
          `SELECT net_pnl_usd, fees_usd, in_range FROM real_marks WHERE position_id=? ORDER BY id DESC LIMIT 1`
        )
        .get(r.id) as { net_pnl_usd: number; fees_usd: number; in_range: number } | undefined;
      const inR = mark ? (mark.in_range ? "in-range" : "hors range") : "?";
      const pnl = mark?.net_pnl_usd ?? 0;
      const fees = mark?.fees_usd ?? 0;
      totPnl += pnl;
      totFees += fees;
      totSol += Number(r.amount_y) || 0;
      lines.push(
        `  • ${r.name} [${r.strategy}] ${Number(r.deposit_usd).toFixed(0)}$ (${Number(r.amount_y).toFixed(2)} SOL) — ${inR} — ${pnl >= 0 ? "💰" : "🔻"} pnl ${pnl >= 0 ? "+" : "-"}${Math.abs(pnl).toFixed(1)}$ — fees ${fees.toFixed(2)}$`
      );
    }
    // PnL en SOL (benchmark CTT_Dev : 2 SOL → 4.94 SOL en 3 semaines) — le
    // pilote réel en unités natives.
    const solUsd = await getSolPriceUsd();
    lines.push(
      `  TOTAL ${realRows.length} positions — ${totSol.toFixed(2)} SOL déployés — ${totPnl >= 0 ? "💰" : "🔻"} pnl ${totPnl >= 0 ? "+" : "-"}${Math.abs(totPnl).toFixed(1)}$ — fees ${totFees.toFixed(2)}$` +
        (solUsd && solUsd > 0 ? ` (pnl ${(totPnl / solUsd).toFixed(3)} SOL, prix ${solUsd.toFixed(2)}$)` : "")
    );
    lines.push("");
  }

  // Pilote L4-B (2026-08-29) : positions balancées sur tokens établis —
  // pur + fees séparés du book (contrainte David : les specs L4 ne doivent
  // pas être au détriment de la collecte — on mesure les deux côtés).
  const pilotRows = db
    .prepare(`SELECT * FROM real_positions WHERE pilot=1 ORDER BY id`)
    .all() as Record<string, any>[];
  if (pilotRows.length) {
    let totPur = 0;
    let totFees = 0;
    let totSol = 0;
    let open = 0;
    lines.push("Pilote L4-B (tokens établis) :");
    for (const r of pilotRows) {
      const mark = db
        .prepare(`SELECT net_pnl_usd, fees_usd FROM real_marks WHERE position_id=? ORDER BY id DESC LIMIT 1`)
        .get(r.id) as { net_pnl_usd: number; fees_usd: number } | undefined;
      const pur = (mark?.net_pnl_usd ?? 0) - (mark?.fees_usd ?? 0);
      const fees = mark?.fees_usd ?? 0;
      totPur += pur;
      totFees += fees;
      totSol += Number(r.amount_y) || 0;
      if (r.status === "open") open++;
      lines.push(
        `  • ${r.name} [${r.strategy}] ${Number(r.deposit_usd).toFixed(0)}$ (${Number(r.amount_y).toFixed(2)} SOL) — ${r.status === "open" ? "ouverte" : "fermée"} — ${pur >= 0 ? "💰" : "🔻"} pur ${pur >= 0 ? "+" : "-"}${Math.abs(pur).toFixed(1)}$ — fees ${fees.toFixed(2)}$`
      );
    }
    lines.push(
      `  TOTAL ${pilotRows.length} pos (${open} ouvertes) — ${totSol.toFixed(2)} SOL — ${totPur >= 0 ? "💰" : "🔻"} pur ${totPur >= 0 ? "+" : "-"}${Math.abs(totPur).toFixed(1)}$ — fees ${totFees.toFixed(2)}$`
    );
    lines.push("");
  }

  // TOTAUX par pilote + global (demande David 03/09). Conventions :
  // - Réalisé : dernier mark de chaque position CLOSEE (net = valeur + fees −
  //   refSol au moment du close ; mark inséré juste avant la décision d'exit,
  //   même source que valuestop-report.cjs). Les gains des sweeps de résidus
  //   ultérieurs ne sont PAS comptés ici (visibles dans les événements 24h).
  // - Flottant : dernier mark des positions OUVERTES (fees en attente incluses).
  const totalsFor = (pilot: number) => {
    const openRows = db
      .prepare(`SELECT id FROM real_positions WHERE pilot = ? AND status = 'open'`)
      .all(pilot) as { id: number }[];
    let openPnl = 0;
    let openFees = 0;
    for (const r of openRows) {
      const m = db
        .prepare(`SELECT net_pnl_usd, fees_usd FROM real_marks WHERE position_id = ? ORDER BY id DESC LIMIT 1`)
        .get(r.id) as { net_pnl_usd: number; fees_usd: number } | undefined;
      openPnl += m?.net_pnl_usd ?? 0;
      openFees += m?.fees_usd ?? 0;
    }
    const openSol = (
      db.prepare(`SELECT COALESCE(SUM(amount_y), 0) s FROM real_positions WHERE pilot = ? AND status = 'open'`).get(pilot) as { s: number }
    ).s;
    // Dernier mark de chaque close (JOIN sur l'id max par position).
    const closed = db
      .prepare(
        `SELECT m.net_pnl_usd AS pnl, m.fees_usd AS fees
         FROM real_positions p
         JOIN real_marks m ON m.id = (SELECT id FROM real_marks WHERE position_id = p.id ORDER BY id DESC LIMIT 1)
         WHERE p.pilot = ? AND p.status = 'closed'`
      )
      .all(pilot) as { pnl: number; fees: number }[];
    const realizedPnl = closed.reduce((a, c) => a + (c.pnl ?? 0), 0);
    const realizedFees = closed.reduce((a, c) => a + (c.fees ?? 0), 0);
    const wins = closed.filter((c) => (c.pnl ?? 0) >= 0).length;
    const grossProfit = closed.filter((c) => (c.pnl ?? 0) > 0).reduce((a, c) => a + c.pnl, 0);
    const grossLoss = closed.filter((c) => (c.pnl ?? 0) < 0).reduce((a, c) => a + c.pnl, 0);
    return {
      openN: openRows.length, openPnl, openFees, openSol,
      closedN: closed.length, wins, losses: closed.length - wins,
      realizedPnl, realizedFees, grossProfit, grossLoss,
    };
  };
  const sgn = (v: number) => `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(1)}$`;
  const tag = (v: number) => (v >= 0 ? "💰" : "🔻");
  const tReal = totalsFor(0);
  const tL4 = totalsFor(1);
  lines.push("=== TOTAUX (depuis l'origine) ===");
  for (const [label, t] of [
    ["Pilote réel", tReal],
    ["Pilote L4-B", tL4],
  ] as const) {
    if (t.closedN === 0 && t.openN === 0) continue;
    lines.push(`${label} :`);
    lines.push(
      `  Réalisé : ${t.closedN} closes · ${t.wins} gains / ${t.losses} pertes · profits bruts ${sgn(t.grossProfit)} / pertes brutes ${sgn(t.grossLoss)} → ${tag(t.realizedPnl)} net ${sgn(t.realizedPnl)} (fees réalisées ${t.realizedFees.toFixed(1)}$)`
    );
    lines.push(
      `  Flottant : ${t.openN} ouvertes · ${t.openSol.toFixed(2)} SOL · ${tag(t.openPnl)} pnl ${sgn(t.openPnl)} · fees en attente ${t.openFees.toFixed(1)}$`
    );
    const totPnl = t.realizedPnl + t.openPnl;
    const totFees = t.realizedFees + t.openFees;
    lines.push(`  TOTAL : ${tag(totPnl)} pnl ${sgn(totPnl)} · fees ${totFees.toFixed(1)}$`);
  }
  {
    const gClosed = tReal.closedN + tL4.closedN;
    const gWins = tReal.wins + tL4.wins;
    const gRealized = tReal.realizedPnl + tL4.realizedPnl;
    const gOpen = tReal.openPnl + tL4.openPnl;
    const gFees = tReal.realizedFees + tL4.realizedFees + tReal.openFees + tL4.openFees;
    const gSol = tReal.openSol + tL4.openSol;
    const gPnl = gRealized + gOpen;
    lines.push(
      `GLOBAL : ${gClosed} closes (${gWins} gains / ${gClosed - gWins} pertes) · réalisé ${sgn(gRealized)} + flottant ${sgn(gOpen)} → ${tag(gPnl)} TOTAL ${sgn(gPnl)} · fees ${gFees.toFixed(1)}$ · ${gSol.toFixed(2)} SOL déployés`
    );
  }
  lines.push("");

  const topOpps = db
    .prepare(
      `SELECT name, score, fee_apr_24h, tvl, volume_24h FROM pool_scans
       WHERE scanned_at = (SELECT MAX(scanned_at) FROM pool_scans) AND score > 0
       ORDER BY score DESC LIMIT 5`
    )
    .all() as { name: string; score: number; fee_apr_24h: number; tvl: number; volume_24h: number }[];
  if (topOpps.length) {
    lines.push("Top opportunités du dernier scan :");
    for (const o of topOpps) {
      lines.push(
        `  • ${o.name} — score ${o.score.toFixed(1)} | APR frais ${(o.fee_apr_24h * 100).toFixed(0)}% | TVL ${(o.tvl / 1e6).toFixed(1)}M$ | vol24h ${(o.volume_24h / 1e6).toFixed(1)}M$`
      );
    }
    lines.push("");
  }

  // Événements des 24h (sans le bruit scan/monitor — même règle que le dashboard)
  const events = db
    .prepare(
      `SELECT type, message, created_at FROM events
       WHERE created_at > ? AND type NOT IN ('scan', 'monitor')
       ORDER BY created_at DESC LIMIT 8`
    )
    .all(Date.now() - 86_400_000) as { type: string; message: string; created_at: number }[];
  if (events.length) {
    lines.push("Événements des 24h :");
    for (const e of events.reverse()) {
      lines.push(`  [${new Date(e.created_at).toISOString().slice(11, 16)}] ${e.type}: ${e.message}`);
    }
  }
  return lines.join("\n");
}
