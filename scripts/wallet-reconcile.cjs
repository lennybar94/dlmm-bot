// Réconciliation wallet : inventaire on-chain des résidus non-sweepés + SOL libre.
// Sortie JSON prête pour le rapport quotidien (buildDailyReport). Readonly, aucun swap.
// Usage : node scripts/wallet-reconcile.cjs  (+ RESIDUE_ALERT_USD=<seuil> pour alerte Telegram)
const { Connection, PublicKey, Keypair } = require('@solana/web3.js');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const env = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
const rpc = (env.match(/^SOLANA_RPC_URL=(.+)$/m) || [])[1]?.trim().replace(/^"|"$/g, '');
const keyRaw = (env.match(/^WALLET_PRIVATE_KEY=(.+)$/m) || [])[1]?.trim();
if (!keyRaw) { console.error('ERR WALLET_PRIVATE_KEY absente'); process.exit(1); }
// Dérive l'adresse depuis la clé (survit à une rotation — jamais d'adresse en dur).
const wallet = Keypair.fromSecretKey(Buffer.from(keyRaw, 'base64')).publicKey.toBase58();

const db = new Database(path.join(ROOT, 'data/dlmm-bot.db'), { readonly: true });
const TOKEN_PROGRAM = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const DATA_API = 'https://dlmm.datapi.meteora.ag';

async function jupPrices(mints) {
  if (!mints.length) return {};
  try {
    const res = await fetch(`https://lite-api.jup.ag/price/v3?ids=${mints.join(',')}`, {
      headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) return {};
    const map = await res.json(); // {mint: {usdPrice}}
    const out = {};
    for (const [k, v] of Object.entries(map)) out[k] = Number(v?.usdPrice ?? 0);
    return out;
  } catch { return {}; }
}

(async () => {
  const conn = new Connection(rpc, 'confirmed');
  const solFree = (await conn.getBalance(new PublicKey(wallet))) / 1e9;

  const t = await conn.getParsedTokenAccountsByOwner(new PublicKey(wallet), { programId: TOKEN_PROGRAM });
  const holdings = [];
  for (const { account } of t.value) {
    const info = account.data.parsed.info;
    const amt = Number(info.tokenAmount.uiAmount);
    if (amt > 0.000001) holdings.push({ mint: info.mint, amt });
  }

  // 1) Prix via Data API : pools récents (ouverts ou clos <7j). token_x = meme
  //    (prix en SOL) → USD = amt × price × SOL_USD. token_y = USDC → prix direct USD.
  const pools = db.prepare(
    `SELECT DISTINCT pool_address FROM real_positions WHERE pool_address IS NOT NULL AND (closed_at > ? OR status='open')`
  ).all(Date.now() - 7 * 86400000).map(r => r.pool_address);

  const solUsdRes = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd',
    { signal: AbortSignal.timeout(10000) }).then(r => r.json()).catch(() => null);
  const solUsd = Number(solUsdRes?.solana?.usd) || 0;

  const mintInfo = {}; // mint -> {symbol, usdPerToken}
  for (const addr of pools.slice(0, 20)) {
    try {
      const res = await fetch(`${DATA_API}/pools/${addr}`, {
        headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) continue;
      const d = await res.json();
      const px = Number(d.current_price) || 0;
      const tx = d.token_x, ty = d.token_y;
      if (tx?.address && px > 0) {
        const symTx = (tx.symbol || '').toLowerCase();
        const isSolSide = symTx === 'sol' || symTx === 'wsol';
        mintInfo[tx.address] = {
          symbol: tx.symbol || '?',
          usdPerToken: isSolSide ? px * solUsd : px * solUsd, // price = SOL per x-token → ×solUsd
        };
      }
      if (ty?.address && px > 0 && !mintInfo[ty.address]) {
        const symTy = (ty.symbol || '').toLowerCase();
        const usdPer = symTy === 'usdc' ? 1 : (1 / px) * solUsd; // inverse: x per SOL… approx
        mintInfo[ty.address] = { symbol: ty.symbol || '?', usdPerToken: usdPer };
      }
    } catch {}
  }

  // 2) Fallback Jupiter lite (tokens hors pool connu, ex. JUP legacy).
  const unknown = holdings.filter(h => !mintInfo[h.mint]).map(h => h.mint);
  const jup = await jupPrices(unknown);

  let residueUsd = 0;
  const rows = [];
  for (const h of holdings) {
    const mi = mintInfo[h.mint];
    let val = null, sym = h.mint.slice(0, 6);
    if (mi && mi.usdPerToken > 0) { val = h.amt * mi.usdPerToken; sym = mi.symbol; }
    else if (jup[h.mint]) { val = h.amt * jup[h.mint]; }
    if (val != null && val >= 0.01) { residueUsd += val; rows.push({ sym, val }); }
    else rows.push({ sym, val: 0, unpriced: true });
  }
  rows.sort((a, b) => b.val - a.val);
  const unpriced = rows.filter(r => r.unpriced).length;

  const sweepFails = db.prepare(
    `SELECT COUNT(*) n FROM events WHERE type='residue-sweep-fail' AND created_at > ?`
  ).get(Date.now() - 24 * 3600000).n;

  const out = {
    ts: new Date().toISOString(),
    wallet_prefix: wallet.slice(0, 6) + '…',
    sol_free: +solFree.toFixed(4),
    sol_usd: solUsd,
    residue_usd: +residueUsd.toFixed(2),
    residues: rows.filter(r => r.val >= 0.01).map(r => ({ sym: r.sym, val: +r.val.toFixed(2) })),
    unpriced_tokens: unpriced,
    sweep_fails_24h: sweepFails,
  };
  console.log(JSON.stringify(out));

  // Alerte mandataire optionnelle (argent réel qui dort) — silencieuse sous le seuil.
  const threshold = Number(process.env.RESIDUE_ALERT_USD || 0);
  if (threshold > 0 && residueUsd >= threshold) {
    const tok = (env.match(/^TELEGRAM_BOT_TOKEN=(.+)$/m) || [])[1]?.trim();
    const cid = (env.match(/^TELEGRAM_CHAT_ID=(.+)$/m) || [])[1]?.trim();
    if (tok && cid) {
      const msg = `🧹 RÉSIDUS ≥ ${threshold}$ : ${residueUsd.toFixed(0)}$ de tokens non-sweepés dorment au wallet (${rows.filter(r=>r.val>=0.01).slice(0, 5).map(r => `${r.sym} ${r.val.toFixed(0)}$`).join(', ')}). Sweeps échoués 24h: ${sweepFails}.`;
      await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cid, text: msg }),
      }).catch(() => {});
    }
  }
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
