// Recon wallet vs dashboard (readonly, node v24) — one-shot
const Database = require('better-sqlite3');
const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');

const env = fs.readFileSync('.env', 'utf8');
const rpc = (env.match(/^SOLANA_RPC_URL=(.+)$/m) || [])[1]?.trim().replace(/^"|"$/g, '');
const wallet = (env.match(/^WALLET_ADDRESS=(.+)$/m) || [])[1]?.trim().replace(/^"|"$/g, '');
if (!wallet) { console.error('WALLET_ADDRESS requis dans .env'); process.exit(1); }

const db = new Database('data/dlmm-bot.db', { readonly: true });

const open = db.prepare(
  `SELECT id, name, amount_y, deposit_usd, last_value_usd, last_mark_at, opened_at, pilot
   FROM real_positions WHERE status='open' ORDER BY id`
).all();

// last mark per open position (fees pending + net pnl)
const marks = open.map(p => {
  const m = db.prepare(
    `SELECT value_usd, fees_usd, net_pnl_usd, in_range FROM real_marks
     WHERE position_id=? ORDER BY taken_at DESC LIMIT 1`
  ).get(p.id);
  return { id: p.id, mark: m };
});

const totals = db.prepare(
  `SELECT COUNT(*) n, COALESCE(SUM(amount_y),0) deployedSol
   FROM real_positions WHERE status='open'`
).get();

// known sigs from bot
const known = new Set(
  db.prepare(`SELECT sig FROM real_positions WHERE sig IS NOT NULL AND sig != ''`).all().map(r => r.sig)
);

const conn = new Connection(rpc, 'confirmed');
(async () => {
  const bal = await conn.getBalance(new PublicKey(wallet));
  const sigs = await conn.getSignaturesForAddress(new PublicKey(wallet), { limit: 15 });

  const details = [];
  for (const s of sigs) {
    const knownTx = known.has(s.signature);
    let tx = null;
    if (!knownTx) {
      try {
        tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      } catch (e) {
        try { tx = await conn.getTransaction(s.signature, 'legacy'); } catch (e2) {}
      }
    }
    let delta = null, feePayer = null;
    if (tx) {
      const keys = tx.transaction.message.staticAccountKeys || tx.transaction.message.accountKeys || [];
      const pre = tx.transaction.message.preBalances || [];
      const post = tx.transaction.message.postBalances || [];
      const i = keys.findIndex(k => k.toBase58?.() === wallet || k === wallet);
      if (i >= 0 && pre[i] != null && post[i] != null) delta = (post[i] - pre[i]) / 1e9;
      feePayer = keys[0]?.toBase58 ? keys[0].toBase58() : String(keys[0]);
    }
    details.push({
      sig: s.signature.slice(0, 10),
      time: new Date(s.blockTime * 1000).toISOString(),
      known: knownTx,
      deltaSol: delta == null ? null : +delta.toFixed(4),
      feePayer: feePayer ? feePayer.slice(0, 8) : null,
    });
  }

  console.log(JSON.stringify({
    rpcOk: !!rpc,
    wallet,
    balanceSol: bal / 1e9,
    openCount: totals.n,
    deployedSol: +totals.deployedSol.toFixed(3),
    positions: open.map(p => ({ id: p.id, name: p.name, amount_y: p.amount_y, last_value_usd: p.last_value_usd, pilot: p.pilot || 0 })),
    lastMarks: marks.map(x => x.mark ? { id: x.id, value_usd: x.mark.value_usd, fees_usd: x.mark.fees_usd, net_pnl_usd: x.mark.net_pnl_usd, in_range: x.mark.in_range } : { id: x.id, mark: null }),
    recentSigs: details,
  }, null, 1));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
