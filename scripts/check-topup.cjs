// Sonde v2: versements de capital — ne fetch QUE les txs non connues du bot (sigs DB), pacing 250ms
const fs = require('fs');
const Database = require('better-sqlite3');
const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const rpc = env.SOLANA_RPC_URL;
const wallet = env.WALLET_ADDRESS;

const db = new Database('data/dlmm-bot.db', { readonly: true });
// sigs connues: positions (open/close) + events (sweeps/claims/opens...)
const known = new Set();
for (const r of db.prepare("SELECT sig FROM real_positions WHERE sig IS NOT NULL").all()) if (r.sig) known.add(r.sig);
for (const r of db.prepare("SELECT message FROM events").all()) {
  const m = (r.message || '').match(/[1-9A-HJ-NP-Za-km-z]{87,88}/g);
  if (m) for (const s of m) known.add(s);
}
console.log('sigs connues du bot:', known.size);

async function rpcCall(method, params) {
  const res = await fetch(rpc, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(method + ' → ' + JSON.stringify(j.error));
  return j.result;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const all = [];
  let before = undefined;
  for (let i = 0; i < 4; i++) {
    const page = await rpcCall('getSignaturesForAddress', [wallet, { limit: 50, ...(before ? { before } : {}) }]);
    if (!page.length) break;
    all.push(...page);
    before = page[page.length - 1].signature;
    if (Date.now() - new Date(page[page.length - 1].blockTime * 1000).getTime() > 60 * 60 * 40 * 1000) break;
  }
  const candidates = all.filter(s => !known.has(s.signature));
  console.log('txs fenêtre:', all.length, '| candidates (non bot):', candidates.length);

  let found = 0;
  for (const c of candidates) {
    await sleep(250);
    let tx;
    try {
      tx = await rpcCall('getTransaction', [c.signature, { maxSupportedTransactionVersion: 0 }]);
    } catch (e) { console.log('  skip', c.signature.slice(0, 10), e.message.slice(0, 60)); continue; }
    if (!tx || !tx.meta || tx.meta.err) continue;
    const keys = tx.transaction.message.staticAccountKeys ?? tx.transaction.message.accountKeys ?? [];
    const wi = keys.findIndex(k => k === wallet);
    if (wi < 0) continue;
    const delta = ((tx.meta.postBalances[wi] ?? 0) - (tx.meta.preBalances[wi] ?? 0)) / 1e9;
    const feePayer = keys[0];
    if (delta > 0.005 && feePayer !== wallet) {
      found++;
      console.log('VERSEMENT', new Date(c.blockTime * 1000).toISOString().replace('T', ' ').slice(0, 19),
        '| +' + delta.toFixed(3) + ' SOL | feePayer', feePayer.slice(0, 8) + '… |', c.signature);
    }
  }
  if (!found) console.log('Aucun versement (feePayer externe) dans la fenêtre 40h.');
})();
