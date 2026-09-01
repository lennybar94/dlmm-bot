// Delta vs recap 6:30 (01/09 04:33 UTC) + positions ouvertes detaillees
const Database = require('better-sqlite3');
const db = new Database('data/dlmm-bot.db', { readonly: true });

const cut = Date.UTC(2026, 8, 1, 4, 33); // recap 06:33 CEST

const open = db.prepare(
  `SELECT id, name, amount_y, deposit_usd, last_value_usd, last_mark_at, opened_at, closed_at, status, close_reason, sig, pilot
   FROM real_positions WHERE status='open' ORDER BY id`
).all();

console.log('=== POSITIONS OUVERTES ===');
for (const p of open) {
  const m = db.prepare(
    `SELECT value_usd, fees_usd, net_pnl_usd, in_range, taken_at FROM real_marks
     WHERE position_id=? ORDER BY taken_at DESC LIMIT 1`
  ).get(p.id);
  const ref = p.pilot ? 'invested' : 'amount_y';
  console.log(`#${p.id} ${p.name} open=${new Date(p.opened_at).toISOString().slice(0,16)} deploy=${p.amount_y?.toFixed(3)} last_value=${p.last_value_usd ?? 'NULL'} mark=${m ? JSON.stringify({v:+m.value_usd?.toFixed(1), f:+m.fees_usd?.toFixed(2), net:+m.net_pnl_usd?.toFixed(2), inRange:m.in_range, at:new Date(m.taken_at).toISOString().slice(0,16)}) : 'AUCUN'} sig=${p.sig?.slice(0,8)}`);
}

console.log('\n=== CLOSES DEPUIS RECAP 6:30 ===');
const closes = db.prepare(
  `SELECT id, name, amount_y, last_value_usd, deposit_usd, closed_at, close_reason, sig FROM real_positions
   WHERE status='closed' AND closed_at > ? ORDER BY closed_at`
).all(cut);
for (const c of closes) {
  const ev = db.prepare(
    `SELECT message FROM events WHERE type='real-auto-close' AND position_id=? ORDER BY created_at DESC LIMIT 1`
  ).get(c.id);
  console.log(`#${c.id} ${c.name} closed=${new Date(c.closed_at).toISOString().slice(0,16)} reason=${c.close_reason} last_value=${c.last_value_usd?.toFixed(1)} deploy=${c.amount_y?.toFixed(3)} msg=${ev?.message?.slice(0,160) ?? '(none)'}`);
}

console.log('\n=== CLAIMS DEPUIS RECAP 6:30 ===');
const claims = db.prepare(
  `SELECT position_id, created_at, message FROM events WHERE type='real-claim' AND created_at > ? ORDER BY created_at`
).all(cut);
let sumClaim = 0;
for (const cl of claims) {
  const m = cl.message.match(/[\d.,]+/);
  console.log(`#${cl.position_id} ${new Date(cl.created_at).toISOString().slice(0,16)} ${cl.message.slice(0,120)}`);
}
console.log('claims:', claims.length);

console.log('\n=== SWEEPS DEPUIS RECAP 6:30 ===');
const sweeps = db.prepare(
  `SELECT position_id, created_at, message FROM events WHERE type='residue-sweep' AND created_at > ? ORDER BY created_at`
).all(cut);
for (const s of sweeps) console.log(`${new Date(s.created_at).toISOString().slice(0,16)} ${s.message.slice(0,120)}`);
console.log('sweeps:', sweeps.length);

console.log('\n=== PNL LATENT (marks actuels, pur = net - fees) ===');
let totV = 0, totF = 0, totN = 0;
for (const p of open) {
  const m = db.prepare(
    `SELECT value_usd, fees_usd, net_pnl_usd FROM real_marks WHERE position_id=? ORDER BY taken_at DESC LIMIT 1`
  ).get(p.id);
  if (!m) { console.log(`#${p.id} ${p.name}: AUCUN mark`); continue; }
  totV += m.value_usd; totF += m.fees_usd; totN += m.net_pnl_usd;
  console.log(`#${p.id} ${p.name}: valeur ${m.value_usd.toFixed(1)}$ | pending ${m.fees_usd.toFixed(2)}$ | net ${m.net_pnl_usd.toFixed(2)}$ (pur ${(m.net_pnl_usd - m.fees_usd).toFixed(2)}$)`);
}
console.log(`TOTAL: valeur ${totV.toFixed(1)}$ | pending ${totF.toFixed(2)}$ | net ${totN.toFixed(2)}$`);

// realized all-time depuis la base
const realized = db.prepare(
  `SELECT COALESCE(SUM(last_value_usd - deposit_usd),0) v FROM real_positions WHERE status='closed'`
).get();
console.log('\nrealized brute (valeur) all-time:', realized.v.toFixed(1));
