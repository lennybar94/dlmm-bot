// Écart d'exécution réel ↔ paper (cahier David 16/10, point 5).
// Usage : npx tsx scripts/ladder-report.ts [--json]
// Lit ladder_compare + ladder_costs (réel) et le dashboard paper Claude (4003)
// même politique, mêmes pools → tout écart chiffré est de l'exécution pure.

import { db } from "../src/db.js";

interface Row { event: string; token: string | null; taken_at: number; pool_address: string; size_sol_real: number | null; size_sol_paper: number | null; delta_sol: number | null; note: string | null }

async function main() {
  const asJson = process.argv.includes("--json");
  const rows = db.prepare(
    "SELECT event, token, taken_at, pool_address, size_sol_real, size_sol_paper, delta_sol, note FROM ladder_compare ORDER BY taken_at"
  ).all() as Row[];

  // Rapprochement avec le livre claude du dashboard paper (lookup par pool+event).
  let paper: any = null;
  try {
    const res = await fetch("http://localhost:4003/api/dashboard.json");
    paper = ((await res.json()) as any).books?.claude ?? null;
  } catch { /* dashboard absent → rapport réel seul */ }

  const out: any[] = [];
  for (const r of rows) {
    let paperSize: number | null = null;
    if (paper && r.event === "open") {
      const op = (paper.open ?? []).find((p: any) => p.pool === r.pool_address);
      if (op) paperSize = op.depositSol ?? null;
    }
    out.push({
      event: r.event, token: r.token, at: new Date(r.taken_at).toISOString(),
      real_size_sol: r.size_sol_real, paper_size_sol: r.size_sol_paper ?? paperSize,
      delta_size_sol: r.size_sol_real != null && (r.size_sol_paper ?? paperSize) != null ? +(r.size_sol_real - (r.size_sol_paper ?? paperSize!)).toFixed(4) : null,
      realized_delta_sol: r.delta_sol, note: r.note,
    });
  }

  const totalFees = (db.prepare("SELECT COALESCE(SUM(tx_fees_sol),0) s FROM ladder_costs").get() as { s: number }).s;
  const totalRent = (db.prepare("SELECT COALESCE(SUM(rent_sol),0) s FROM ladder_costs").get() as { s: number }).s;

  if (asJson) { console.log(JSON.stringify({ events: out, execution_costs_sol: { tx_fees: totalFees, rent: totalRent } }, null, 2)); return; }
  console.log(`Événements ladder : ${out.length} · coûts d'exécution cumulés : frais tx ${totalFees.toFixed(4)} SOL · rent ${totalRent.toFixed(4)} SOL`);
  for (const e of out) console.log(`  ${e.at} ${e.event} ${e.token}: réel ${e.real_size_sol ?? "?"} vs paper ${e.paper_size_sol ?? "?"} Δ=${e.delta_size_sol ?? "?"}`);
}

main().catch((e) => { console.error("⛔ ladder-report:", e?.message ?? e); process.exit(1); });
