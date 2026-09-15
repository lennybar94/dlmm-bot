// Vérif sweep échoués : tx passée on-chain ou pas ? + solde BULLSHIT + SOL libre
const { Connection, PublicKey, LAMPORTS_PER_SOL } = require('@solana/web3.js');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const rpc = (env.match(/^SOLANA_RPC_URL=(.+)$/m) || [])[1]?.trim().replace(/^"|"$/g, '');
const wallet = 'HsstWQzA65Zh2DKJTfWP5zkDLaZUi49UrJpbjku2w3az';
const BULLSHIT_MINT = 'zj1jpp7QvUqQ8e8zGx2T9iXqWY9k5zR3mN7sL4pQ2vXo'; // placeholder, remplacé en base

const conn = new Connection(rpc, 'confirmed');

const failedSigs = [
  ['fone (31/08 14:15)', '5PaSoCNzoPDuniNDcbFdbPU'],
  ['REDACTED (31/08 22:15)', '25kXqFybXiHmiujKwVw6EVM'],
  ['MANLET (01/09 18:15)', '3TfkXyfdB75Gt9jzWBfrbPN'],
  ['BULLSHIT (01/09 22:00)', '4WpFGcCxusYJusnvb19r3uM'],
];

async function checkSig(label, sig) {
  try {
    const st = await conn.getSignatureStatus(sig, { searchTransactionHistory: true });
    const v = st?.value;
    if (!v) { console.log(`${label}: ${sig.slice(0,12)} — AUCUN statut (tx introuvable, jamais vue)`); return; }
    console.log(`${label}: ${sig.slice(0,12)} — status=${v.confirmationStatus ?? '?'} err=${v.err === null ? 'OK' : JSON.stringify(v.err)}`);
  } catch (e) {
    console.log(`${label}: ${sig.slice(0,12)} — ERR ${e.message.slice(0, 60)}`);
  }
}

(async () => {
  const bal = await conn.getBalance(new PublicKey(wallet));
  console.log(`SOL libre maintenant: ${(bal / LAMPORTS_PER_SOL).toFixed(4)}`);
  for (const [l, s] of failedSigs) await checkSig(l, s);
  // tous les comptes token avec mint complet
  const t = await conn.getParsedTokenAccountsByOwner(new PublicKey(wallet), {
    programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
  });
  console.log('--- comptes token ---');
  for (const { account } of t.value) {
    const info = account.data.parsed.info;
    const amt = Number(info.tokenAmount.uiAmount);
    if (amt > 0.000001) console.log(`${info.mint} amt=${amt}`);
  }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
