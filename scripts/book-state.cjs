#!/usr/bin/env node
// État du book réel (positions ouvertes + déploiement) — DB-only, consommé
// par le job hebdo de verdict value-stop.
const Database = require("better-sqlite3");
const db = new Database("data/dlmm-bot.db", { readonly: true });
const open = db.prepare("SELECT id,name,deposit_usd,amount_y,strategy FROM real_positions WHERE status='open' ORDER BY id").all();
const t = open.reduce((s, p) => s + p.amount_y, 0);
console.log(`Positions ouvertes : ${open.length} — déployé ${t.toFixed(2)} SOL`);
for (const p of open) console.log(`  #${p.id} ${p.name.padEnd(12)} ${p.strategy.padEnd(12)} ${p.deposit_usd}$ (${p.amount_y.toFixed(2)} SOL)`);
