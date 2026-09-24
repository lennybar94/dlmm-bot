// Drain remaining non-zero token accounts from OLD to NEW.
// Old key read from pre-rotation .env backup; new key from /tmp/rotate-new-key. Nothing printed but pubkeys/amounts.
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const OLD = 'HE48NngQ46ZmgNMphNwEwxmLxK8D5gmcfd3bPqgeNoVk';
const NEW = 'HsstWQzA65Zh2DKJTfWP5zkDLaZUi49UrJpbjku2w3az';

(async () => {
  const oldEnv = fs.readFileSync(path.join(__dirname, '..', 'backups', 'env-pre-rotation-20260915-1130'), 'utf8');
  const oldKp = Keypair.fromSecretKey(Buffer.from(oldEnv.match(/^WALLET_PRIVATE_KEY=(.+)$/m)[1].trim(), 'base64'));
  if (oldKp.publicKey.toBase58() !== OLD) { console.log('OLD_KEY_MISMATCH'); process.exit(3); }
  const newKp = Keypair.fromSecretKey(Buffer.from(fs.readFileSync('/tmp/rotate-new-key', 'utf8').trim(), 'base64'));
  if (newKp.publicKey.toBase58() !== NEW) { console.log('NEW_KEY_MISMATCH'); process.exit(4); }

  const conn = new Connection(process.argv[2], 'confirmed');
  const owner = await conn.getParsedTokenAccountsByOwner(oldKp.publicKey, { programId: spl.TOKEN_PROGRAM_ID });
  let n = 0;
  for (const a of owner.value) {
    const info = a.account.data.parsed.info;
    const amt = BigInt(info.tokenAmount.amount);
    if (amt === 0n) continue;
    const mint = new PublicKey(info.mint);
    try {
      const dest = await spl.getAssociatedTokenAddress(mint, newKp.publicKey);
      let exists = true;
      try { await spl.getAccount(conn, dest); } catch { exists = false; }
      const ixs = [];
      if (!exists) ixs.push(spl.createAssociatedTokenAccountInstruction(newKp.publicKey, dest, newKp.publicKey, mint));
      ixs.push(spl.createTransferInstruction(new PublicKey(a.pubkey), dest, oldKp.publicKey, amt));
      const tx = new (require('@solana/web3.js').Transaction)();
      for (const ix of ixs) tx.add(ix);
      tx.feePayer = newKp.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const sig = await conn.sendTransaction(tx, [newKp, oldKp]);
      await conn.confirmTransaction(sig, 'confirmed');
      console.log('SENT', info.mint.slice(0, 12), info.tokenAmount.uiAmountString, 'sig=' + sig.slice(0, 12));
      n++;
    } catch (e) { console.log('FAIL', info.mint.slice(0, 12), e.message.slice(0, 140)); }
  }
  console.log('transferred=' + n);
})().catch(e => { console.error('ERROR', e.message.slice(0, 200)); process.exit(1); });
