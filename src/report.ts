// Rapport quotidien : résumé positions, frais, opportunités, événements.

import { db } from "./db.js";
import { getPortfolioSummary, getOpenPositions } from "./paper.js";

export function buildDailyReport(): string {
  const s = getPortfolioSummary();
  const lines: string[] = [];
  const now = new Date();
  lines.push(`=== Rapport DLMM ${now.toISOString().slice(0, 16).replace("T", " ") } ===`);
  lines.push("");
  lines.push(`Portefeuille paper :`);
  lines.push(`  Positions ouvertes : ${s.open}`);
  lines.push(`  Investi : ${s.investedUsd.toFixed(0)}$`);
  lines.push(`  Valeur : ${s.valueUsd.toFixed(0)}$`);
  lines.push(`  PnL net (valeur + frais − investi) : ${s.netPnlUsd >= 0 ? "+" : ""}${s.netPnlUsd.toFixed(2)}$`);
  lines.push(`  Frais encaissés (cumul) : ${(s.feesEarnedUsd + s.feesClaimedUsd).toFixed(2)}$ (dont claims ${s.feesClaimedUsd.toFixed(2)}$)`);
  lines.push(`  Rebalances : ${s.rebalances}`);
  lines.push("");

  const positions = getOpenPositions();
  if (positions.length) {
    lines.push("Positions ouvertes :");
    for (const p of positions) {
      const pnl = p.last_value_usd - p.deposit_usd + p.fees_earned_usd + p.fees_claimed_usd;
      lines.push(
        `  • ${p.name} [${p.strategy}] ${p.deposit_usd.toFixed(0)}$ → ${p.last_value_usd.toFixed(0)}$ ` +
          `(pnl ${pnl >= 0 ? "+" : ""}${pnl.toFixed(2)}$) | frais ${(p.fees_earned_usd + p.fees_claimed_usd).toFixed(2)}$ | ` +
          `IL ${p.last_il_usd.toFixed(2)}$ | bins [${p.min_bin_id}..${p.max_bin_id}] | rebal ${p.rebalance_count}`
      );
    }
    lines.push("");
  }

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

  const events = db
    .prepare(
      `SELECT type, message, created_at FROM events WHERE created_at > ? ORDER BY created_at DESC LIMIT 8`
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
