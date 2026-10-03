import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const TOKEN = new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
  const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  // find all token accounts holding USDC owned by... can't filter owner globally. Instead: derive ATA for wallet (done) and check recent tx of wallet to see sweep destination.
  const sigs = await conn.getSignaturesForAddress(new PublicKey(config.walletAddress), { limit: 8 });
  for (const s of sigs.slice(0, 8)) console.log(s.signature, new Date(s.blockTime! * 1000).toISOString(), (s.err ? "ERR" : "ok"));
})();
