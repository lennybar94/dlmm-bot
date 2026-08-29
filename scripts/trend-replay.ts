// Rejeu L4-A (filtre de tendance) sur les closes réelles — 2026-08-29.
// Objectif : prouver que le veto ne sacrifierait PAS la collecte des fees
// (contrainte David 29/08). Méthode : pour chaque position réelle fermée,
// on prend les bougies daily ACTUELLES du pool (l'OHLCV Data API ne stocke
// rien d'historique — les 10 daily couvrent ~10 j, donc la fenêtre des closes
// récentes) et on applique analyzeTrend. Si downTrend (drift<0 ET RSI↘ ET
// prix<MA7) : le filtre L4-A aurait rejeté le pool. On croise avec le net/fees
// du dernier mark de la position.
// ⚠️ Proxy assumé : candles d'AUJOURD'HUI vs position d'il y a quelques jours ;
// le verdict est indicatif, le shadow en prod (cron */5) reste la vérité.
// Usage : node node_modules/tsx/dist/cli.mjs scripts/trend-replay.ts (node v24)

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3") as typeof import("better-sqlite3");

import { fetchOhlcv } from "../src/api.js";
import { analyzeTrend } from "../src/strategies.js";

const db = new Database("data/dlmm-bot.db", { readonly: true });

const closes = db
  .prepare(
    `SELECT rp.id, rp.name, rp.pool_address, rp.close_reason,
            rm.net_pnl_usd, rm.fees_usd
     FROM real_positions rp
     LEFT JOIN real_marks rm ON rm.position_id = rp.id
       AND rm.taken_at = (SELECT MAX(taken_at) FROM real_marks WHERE position_id = rp.id)
     WHERE rp.status = 'closed'
     ORDER BY rp.id`
  )
  .all() as {
  id: number;
  name: string;
  pool_address: string;
  close_reason: string;
  net_pnl_usd: number | null;
  fees_usd: number | null;
}[];

let rej = 0;
const agg = { count: 0, net: 0, fees: 0, pur: 0 };
const keptAgg = { count: 0, net: 0, fees: 0, pur: 0 };
const naAgg = { count: 0 };
const rejList: { name: string; net: number; fees: number; reason: string }[] = [];

for (const c of closes) {
  let trend;
  try {
    const candles = await fetchOhlcv(c.pool_address);
    trend = analyzeTrend(candles);
  } catch (err) {
    trend = null;
    console.log(`  ⚠️ OHLCV KO ${c.name}: ${String(err)}`);
  }
  const net = c.net_pnl_usd ?? 0;
  const fees = c.fees_usd ?? 0;
  const pur = net - fees;
  if (!trend) {
    naAgg.count++;
    continue;
  }
  if (trend.downTrend) {
    rej++;
    agg.count++;
    agg.net += net;
    agg.fees += fees;
    agg.pur += pur;
    rejList.push({ name: c.name, net, fees, reason: `drift ${(trend.drift24h! * 100).toFixed(0)}% RSI ${trend.rsiNow!.toFixed(0)}↘ prix<MA7` });
  } else {
    keptAgg.count++;
    keptAgg.net += net;
    keptAgg.fees += fees;
    keptAgg.pur += pur;
  }
}

console.log(`\n=== Rejeu L4-A sur ${closes.length} closes réelles ===`);
console.log(`OHLCV indisponibles : ${naAgg.count}`);
console.log(
  `\nAURAIT REJETÉ (downTrend) : ${agg.count} positions — net ${agg.net.toFixed(0)}$, fees ${agg.fees.toFixed(0)}$, pur ${agg.pur.toFixed(0)}$`
);
console.log(
  `GARDÉES : ${keptAgg.count} positions — net ${keptAgg.net.toFixed(0)}$, fees ${keptAgg.fees.toFixed(0)}$, pur ${keptAgg.pur.toFixed(0)}$`
);
console.log(`\n=== Détail des rejetées (net final, fees finales) ===`);
for (const r of rejList) {
  console.log(`  ${r.name.padEnd(16)} net ${r.net.toFixed(1).padStart(8)}$  fees ${r.fees.toFixed(1).padStart(7)}$  (${r.reason})`);
}
const totalNet = agg.net + keptAgg.net;
const totalFees = agg.fees + keptAgg.fees;
const feeShare = totalFees ? (agg.fees / totalFees) * 100 : 0;
console.log(
  `\n=== Verdict fees ===\nFees totales ${totalFees.toFixed(0)}$ ; fees des rejetées ${agg.fees.toFixed(0)}$ (${feeShare.toFixed(1)}% du total).`
);
console.log(
  `Perte nette évitée par le veto : ${(-agg.net).toFixed(0)}$ — collecte sacrifiée : ${agg.fees.toFixed(0)}$ (${feeShare.toFixed(1)}%).`
);
if (agg.net < 0 && feeShare <= 10) {
  console.log(
    "→ CANDIDAT activation : rejetées net négatif ET part de fees faible (< 10%) — le veto réduirait la perte sans sacrifier la collecte."
  );
} else {
  console.log(
    `→ NE PAS ACTIVER : le veto sacrifie ${feeShare.toFixed(1)}% de la collecte pour ${(-agg.net).toFixed(0)}$ de perte évitée. ` +
      "Les dumps mortels sont AUSSI les gros collecteurs (volatilité = fees) — la contrainte David 29/08 prime : shadow seul."
  );
}
