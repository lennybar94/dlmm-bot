// Solde wallet DLMM — n'imprime JAMAIS la clé (leçon 03/09 + 14/09 : jamais de grep sur .env)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
const m = env.match(/^WALLET_PRIVATE_KEY=(.*)$/m);
if (!m) { console.log('clé absente'); process.exit(1); }
const secret = Buffer.from(m[1].trim(), 'base64');

const { Keypair, Connection } = await import('@solana/web3.js');
const kp = Keypair.fromSecretKey(new Uint8Array(secret));
const rpc = (env.match(/^RPC_URL=(.*)$/m) || [])[1] || 'https://api.mainnet-beta.solana.com';
const c = new Connection(rpc.trim());
const b = await c.getBalance(kp.publicKey);
console.log('adresse', kp.publicKey.toBase58().slice(0, 8) + '…' + kp.publicKey.toBase58().slice(-4));
console.log('solde', (b / 1e9).toFixed(3), 'SOL');
console.log('solde_usd~', ((b / 1e9) * 205).toFixed(0), '$ (SOL~205$)');
