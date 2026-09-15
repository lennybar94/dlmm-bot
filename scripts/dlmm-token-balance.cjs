// Bilan on-chain : SOL libre + tokens au wallet + valeur approx (readonly)
const { Connection, PublicKey } = require('@solana/web3.js');
const fs = require('fs');
const Database = require('better-sqlite3');

const env = fs.readFileSync('.env', 'utf8');
const rpc = (env.match(/^SOLANA_RPC_URL=(.+)$/m) || [])[1]?.trim().replace(/^"|"$/g, '');
const wallet = 'HsstWQzA65Zh2DKJTfWP5zkDLaZUi49UrJpbjku2w3az';
const db = new Database('data/dlmm-bot.db', { readonly: true });

// pools des positions recentes (pour mapper mint -> pool -> prix)
const pools = db.prepare(
  `SELECT id, name, pool_address, close_reason FROM real_positions WHERE pool_address IS NOT NULL AND (closed_at > ? OR status='open') ORDER BY id DESC LIMIT 15`
).all(Date.now() - 3 * 86400000);

(async () => {
  const conn = new Connection(rpc, 'confirmed');
  const bal = await conn.getBalance(new PublicKey(wallet));
  console.log('SOL libre:', (bal / 1e9).toFixed(4));

  const t = await conn.getParsedTokenAccountsByOwner(new PublicKey(wallet), {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });
  const rows = [];
  for (const { account } of t.value) {
    const info = account.data.parsed.info;
    const amt = Number(info.tokenAmount.uiAmount);
    if (amt > 0.000001) rows.push({ mint: info.mint, amt, sym: info.tokenAmount.decimals });
  }
  console.log('Comptes token non nuls:', rows.length);
  for (const r of rows) console.log(`  ${r.mint.slice(0,8)}… amt=${r.amt}`);

  // prix des pools recents via Data API (User-Agent obligatoire)
  for (const p of pools.slice(0, 6)) {
    try {
      const res = await fetch(`https://dlmm.datapi.meteora.ag/pools/${p.pool_address}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const d = await res.json();
      console.log(`pool #${p.id} ${p.name} (${p.close_reason || 'open'}): price=${d.current_price} tvl=${d.tvl}`);
    } catch (e) { console.log(`pool #${p.id} ${p.name}: ERR ${e.message.slice(0, 60)}`); }
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
