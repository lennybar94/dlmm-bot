import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
const { create } = req("@meteora-ag/dlmm");
const { BN } = req("bn.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  for (const p of ["5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6", "6WTbcDmtqDNwxxLe9YzHzpSSBKQ7AduZG7SmYWpRwjZZ"]) {
    try {
      const pool: any = await create(conn, new PublicKey(p), { cluster: config.cluster as any });
      const inRaw = new BN(BigInt(Math.floor(4.36 * 1e9)).toString());
      const binArrays = await pool.getBinArrayForSwap(true, 8);
      const q = pool.swapQuote(inRaw, true, new BN(100), binArrays);
      console.log(p.slice(0, 6), "quote OK — out USDC:", Number(q.outAmount.toString()) / 1e6, "minOut:", Number(q.minOutAmount.toString()) / 1e6);
    } catch (e) { console.log(p.slice(0, 6), "ERR:", String(e).slice(0, 100)); }
  }
})();
