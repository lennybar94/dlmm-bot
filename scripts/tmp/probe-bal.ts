import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const wallet = new PublicKey(config.walletAddress);
  const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const [solL, accs] = await Promise.all([conn.getBalance(wallet), conn.getTokenAccountsByOwner(wallet, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), mint: usdc })]);
  let total = 0;
  for (const a of accs.value) {
    const info = await conn.getTokenAccountBalance(a.pubkey);
    total += info.value.uiAmount ?? 0;
  }
  console.log("SOL:", solL / 1e9, "| USDC:", total);
})();
