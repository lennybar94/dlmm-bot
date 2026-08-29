// Analyse PnL PUR DLMM — 2026-08-29 (readonly, node v24). DELETE after use.
const Database = require('better-sqlite3');
const db = new Database('/home/polybot/dlmm-bot/data/dlmm-bot.db', { readonly: true });

const rows = db.prepare(`SELECT * FROM real_positions ORDER BY opened_at`).all();

// Pour chaque position : derniers/meilleurs/pires marks + pure PnL
function marksOf(id) {
  return db.prepare(`SELECT taken_at, value_usd, fees_usd, net_pnl_usd, in_range FROM real_marks WHERE position_id=? ORDER BY taken_at ASC`).all(id);
}

const enriched = rows.map(p => {
  const m = marksOf(p.id);
  let pure = null, fees = null, ref = null, worst = null, best = null, final = null, worstT = null, bestT = null;
  if (m.length) {
    const last = m[m.length - 1];
    pure = last.net_pnl_usd - last.fees_usd;         // PnL pur (value vs ref) au dernier mark
    fees = last.fees_usd;
    ref = last.value_usd + last.fees_usd - last.net_pnl_usd; // ref en USD au dernier mark
    final = ref > 0 ? (last.value_usd - ref) / ref : null;
    for (const k of m) {
      const r = k.value_usd + k.fees_usd - k.net_pnl_usd;
      if (r <= 0) continue;
      const ratio = (k.value_usd - r) / r; // pur % (value vs ref), price-independent
      if (worst === null || ratio < worst) { worst = ratio; worstT = k.taken_at; }
      if (best === null || ratio > best) { best = ratio; bestT = k.taken_at; }
    }
  } else {
    pure = p.last_value_usd - p.deposit_usd;         // fallback sans mark (valeur pure)
    final = p.deposit_usd > 0 ? (p.last_value_usd - p.deposit_usd) / p.deposit_usd : null;
  }
  return { p, m, pure, fees, ref, worst, best, final, worstT, bestT, n: m.length };
});

const closed = enriched.filter(e => e.p.status === 'closed');
const open = enriched.filter(e => e.p.status === 'open');

const sum = (arr, f) => arr.reduce((a, e) => a + (f(e) || 0), 0);

console.log('=== GLOBAL ===');
console.log(`positions: ${rows.length} (closed ${closed.length}, open ${open.length})`);
const pureReal = sum(closed, e => e.pure), pureOpen = sum(open, e => e.pure);
console.log(`PnL PUR réalisé (closes): ${pureReal.toFixed(2)}$`);
console.log(`PnL PUR latent (ouvertes): ${pureOpen.toFixed(2)}$`);
console.log(`PnL PUR TOTAL: ${(pureReal + pureOpen).toFixed(2)}$`);

console.log('\n=== PAR CLOSE_REASON (closes, PnL pur) ===');
const byReason = {};
for (const e of closed) {
  const r = e.p.close_reason || '?';
  byReason[r] = byReason[r] || { n: 0, pure: 0, fees: 0, net: 0 };
  byReason[r].n++; byReason[r].pure += e.pure || 0; byReason[r].fees += e.fees || 0;
}
for (const [r, v] of Object.entries(byReason).sort((a, b) => a[1].pure - b[1].pure)) {
  console.log(`${r.padEnd(16)} n=${String(v.n).padStart(3)}  pure=${v.pure.toFixed(0).padStart(7)}$  fees=${v.fees.toFixed(0).padStart(6)}$`);
}

console.log('\n=== PAR STRATÉGIE (toutes positions, PnL pur) ===');
const byStrat = {};
for (const e of enriched) {
  const s = e.p.strategy || '?';
  byStrat[s] = byStrat[s] || { n: 0, pure: 0, fees: 0 };
  byStrat[s].n++; byStrat[s].pure += e.pure || 0; byStrat[s].fees += e.fees || 0;
}
for (const [s, v] of Object.entries(byStrat).sort((a, b) => a[1].pure - b[1].pure)) {
  console.log(`${s.padEnd(16)} n=${String(v.n).padStart(3)}  pure=${v.pure.toFixed(0).padStart(7)}$  fees=${v.fees.toFixed(0).padStart(6)}$`);
}

console.log('\n=== TOP 15 PERTES PURES (closes) ===');
for (const e of closed.slice().sort((a, b) => (a.pure || 0) - (b.pure || 0)).slice(0, 15)) {
  const d = ((e.p.closed_at - e.p.opened_at) / 3600e3).toFixed(1);
  console.log(`${e.p.name.padEnd(16)} ${e.p.strategy.padEnd(11)} ${(e.p.close_reason||'?').padEnd(14)} dep=${e.p.deposit_usd}  pure=${(e.pure||0).toFixed(0).padStart(6)}$  fees=${(e.fees||0).toFixed(0).padStart(5)}$  worst=${((e.worst||0)*100).toFixed(0)}%  ${d}h`);
}

console.log('\n=== TOP 10 GAINS PURS (closes) ===');
for (const e of closed.slice().sort((a, b) => (b.pure || 0) - (a.pure || 0)).slice(0, 10)) {
  console.log(`${e.p.name.padEnd(16)} ${e.p.strategy.padEnd(11)} ${(e.p.close_reason||'?').padEnd(14)} pure=${(e.pure||0).toFixed(0).padStart(6)}$  fees=${(e.fees||0).toFixed(0).padStart(5)}$  best=${((e.best||0)*100).toFixed(0)}%`);
}

console.log('\n=== SIMULATION STOP (closes uniquement) ===');
for (const T of [0.03, 0.05, 0.08, 0.10, 0.12, 0.15]) {
  let tot = 0, cut = 0, fp = 0, cutLoss = 0;
  for (const e of closed) {
    let cutValue = null;
    if (e.m.length) {
      for (const k of e.m) {
        const r = k.value_usd + k.fees_usd - k.net_pnl_usd;
        if (r > 0 && (k.value_usd - r) / r < -T) { cutValue = k.value_usd - r; break; }
      }
    }
    if (cutValue !== null) {
      tot += cutValue; cut++; cutLoss += cutValue;
      const finalPure = e.pure || 0;
      if (finalPure >= 0) fp++;
    } else {
      tot += (e.pure || 0);
    }
  }
  const openPure = pureOpen;
  const total = tot + openPure;
  console.log(`T=-${(T*100).toFixed(0)}% : pure total=${total.toFixed(0).padStart(7)}$  (closes=${tot.toFixed(0)})  coupées=${cut}  faux_pos=${fp}  perte_coupée_moy=${(cut ? cutLoss/cut : 0).toFixed(0)}$`);
}

console.log('\n=== REBOUND : recovery-exit — pur final vs meilleur point atteint ===');
for (const e of closed.filter(x => x.p.close_reason === 'recovery-exit').sort((a,b)=>(a.pure||0)-(b.pure||0))) {
  console.log(`${e.p.name.padEnd(16)} final_pur=${((e.final||0)*100).toFixed(1).padStart(5)}%  best_pur=${((e.best||0)*100).toFixed(1).padStart(5)}%  fees=${(e.fees||0).toFixed(1).padStart(5)}$`);
}
