// Drain non-zero token accounts from OLD to NEW using ONLY the NEW key.
// Fee payer = NEW (OLD is at 0 SOL). No closeAccount (needs old signer — unavailable).
const fs = require('fs');
const path = require('path');
const { Connection, Keypair, PublicKey } = require('@solana/web3.js');
const spl = require('@solana/spl-token');

const NEW = 'HsstWQzA65Zh2DKJTfWP5zkDLaZUi49UrJpbjku2w3az';

(async () => {
  const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
  const oldKp = Keypair.fromSecretKey(Buffer.from(env.match(/^WALLET_PRIVATE_KEY=(.+)$/m)[1].trim(), 'base64'));
  // After .env swap this IS the new key; we need the OLD wallet's pubkey only as source owner.
  const newKp = Keypair.fromSecretKey(Buffer.from(fs.readFileSync('/tmp/rotate-new-key', 'utf8').trim(), 'base64'));
  if (newKp.publicKey.toBase58() !== NEW) { console.log('NEW_KEY_MISMATCH'); process.exit(4); }
  if (oldKp.publicKey.toBase58() === NEW) { console.log('NOTE: .env now holds new key; old signer must come from /tmp/rotate-old-key'); }
  let oldSigner = null;
  try {
    oldSigner = Keypair.fromSecretKey(Buffer.from(fs.readFileSync('/tmp/rotate-old-key', 'utf8').trim(), 'base64'));
    if (oldSigner.publicKey.toBase58() !== 'HE48NngQ46ZmgNMphNwEwxmLxK8D5gmcfd3bPqgeNoVk') { console.log('OLD_KEY_MISMATCH'); process.exit(5); }
  } catch { console.log('NO_OLD_KEY_FILE — cannot sign transfers from old wallet; abort'); process.exit(6); }

  const conn = new Connection(process.argv[2], 'confirmed');
  const owner = await conn.getParsedTokenAccountsByOwner(oldSigner.publicKey, { programId: spl.TOKEN_PROGRAM_ID });
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
      ixs.push(spl.createTransferInstruction(new PublicKey(a.pubkey), dest, oldSigner.publicKey, amt));
      const tx = new (require('@solana/web3.js').Transaction)();
      for (const ix of ixs) tx.add(ix);
      tx.feePayer = newKp.publicKey;
      tx.recentBlockhash = (await conn.getLatestBlockhash()).blockhash;
      const sig = await conn.sendTransaction(tx, [newKp, oldSigner]);
      await conn.confirmTransaction(sig, 'confirmed');
      console.log('SENT', info.mint.slice(0, 12), info.tokenAmount.uiAmountString, 'sig=' + sig.slice(0, 12));
    } catch (e) { console.log('FAIL', info.mint.slice(0, 12), e.message.slice(0, 140)); }
  }
})().catch(e => { console.error('ERROR', e.message.slice(0, 200)); process.exit(1); });
