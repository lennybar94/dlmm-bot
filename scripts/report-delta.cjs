// One-shot: delta depuis le récap 6:30 (cutoff = aujourd'hui 04:33 UTC) + vérité wallet on-chain
const Database = require('better-sqlite3');
const { Connection, PublicKey } = require('@solana/web3.js');
require('dotenv').config();

const WALLET = 'HE48NngQ46ZmgNMphNwEwxmLxK8D5gmcfd3bPqgeNoVk';
const db = new Database('data/dlmm-bot.db', { readonly: true });

const now = new Date();
const cutoff = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 4, 33, 12);
console.log('cutoff (UTC):', new Date(cutoff).toISOString(), '| now (UTC):', now.toISOString());

// ---- Closes depuis le cutoff
const closes = db.prepare(`SELECT id, name, close_reason, closed_at, deposit_usd, amount_y
  FROM real_positions WHERE status='closed' AND closed_at > ? ORDER BY closed_at`).all(cutoff);
console.log('\n=== CLOSES depuis 6:30 ===', closes.length);
let closeNet = 0;
for (const c of closes) {
  const m = db.prepare(`SELECT net_pnl_usd, fees_usd, value_usd FROM real_marks
    WHERE position_id=? ORDER BY taken_at DESC LIMIT 1`).get(c.id);
  closeNet += m ? m.net_pnl_usd : 0;
  console.log(`#${c.id} ${c.name} reason=${c.close_reason} closedAt=${new Date(c.closed_at).toLocaleString('fr-FR',{timeZone:'Europe/Paris'})} deposit=${c.deposit_usd} net=${m?m.net_pnl_usd.toFixed(2):'?'} fees=${m?m.fees_usd.toFixed(2):'?'}`);
}
console.log('Σ net closes:', closeNet.toFixed(2));

// ---- Events depuis le cutoff (claims, closes auto, OOR...)
const evs = db.prepare(`SELECT type, message, created_at FROM events
  WHERE created_at > ? AND type LIKE 'real%' ORDER BY created_at`).all(cutoff);
const byType = {};
for (const e of evs) byType[e.type] = (byType[e.type]||0)+1;
console.log('\n=== EVENTS real depuis 6:30 ===');
console.log(JSON.stringify(byType, null, 1));
for (const e of evs) {
  if (e.type.includes('claim') || e.type.includes('close') || e.type.includes('missing') || e.type.includes('error') || e.type.includes('fail'))
    console.log(`[${new Date(e.created_at).toLocaleString('fr-FR',{timeZone:'Europe/Paris'})}] ${e.type} :: ${e.message}`);
}

// ---- Claims: Σ $ depuis cutoff (positions encore ouvertes)
const claims = evs.filter(e => e.type === 'real-claim');
let claimUsd = 0;
for (const e of claims) {
  const mm = e.message.match(/claim AUTO ([\d.]+)\$/);
  if (mm) claimUsd += parseFloat(mm[1]);
}
console.log('\nΣ claims AUTO:', claimUsd.toFixed(2), '(', claims.length, ')');

// ---- Positions ouvertes : Δ(value pure) et Δ(pending) depuis cutoff
const opens = db.prepare(`SELECT id, name, amount_y FROM real_positions WHERE status='open'`).all();
let dpure = 0, dpend = 0, feesNow = 0;
const lastMark = db.prepare(`SELECT net_pnl_usd, fees_usd FROM real_marks WHERE position_id=? ORDER BY taken_at DESC LIMIT 1`);
const cutoffMark = db.prepare(`SELECT net_pnl_usd, fees_usd FROM real_marks WHERE position_id=? AND taken_at<=? ORDER BY taken_at DESC LIMIT 1`);
for (const o of opens) {
  const n = lastMark.get(o.id);
  const c0 = cutoffMark.get(o.id, cutoff);
  if (!n) continue;
  const pureNow = n.net_pnl_usd - n.fees_usd;
  const pure0 = c0 ? c0.net_pnl_usd - c0.fees_usd : (o.amount_y ? 0 : 0);
  // position ouverte pendant la période : pure0 = net0 − fees0 (avant), sinon 0 (ouverte après)
  dpure += pureNow - (c0 ? pure0 : 0);
  dpend += n.fees_usd - (c0 ? c0.fees_usd : 0);
  feesNow += n.fees_usd;
}
console.log('\n=== OUVERTES (10) ===');
console.log('Δ PnL pur (net−fees) depuis 6:30:', dpure.toFixed(2));
console.log('Δ pending fees depuis 6:30:', dpend.toFixed(2));
console.log('fees en attente actuelles (Σ last marks):', feesNow.toFixed(2));
console.log('fees du jour ≈ claims + Δpending:', (claimUsd + dpend).toFixed(2));

// ---- Vérité wallet on-chain
(async () => {
  try {
    const conn = new Connection(process.env.SOLANA_RPC_URL, 'confirmed');
    const free = await conn.getBalance(new PublicKey(WALLET));
    const deployed = opens.reduce((s,o)=>s+o.amount_y,0);
    const total = free/1e9 + deployed;
    console.log('\n=== WALLET ON-CHAIN ===');
    console.log('libre:', (free/1e9).toFixed(4), 'SOL | déployé (Σ amount_y):', deployed.toFixed(4), 'SOL | total:', total.toFixed(4), 'SOL');
    console.log('garde 80%: déployé', deployed.toFixed(2), '/ 0.8×total', (0.8*total).toFixed(2), '→ marge', (0.8*total-deployed).toFixed(2), 'SOL');
  } catch (e) {
    console.log('getBalance failed:', e.message);
  }
  db.close();
})();
