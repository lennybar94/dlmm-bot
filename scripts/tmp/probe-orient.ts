import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
const { create } = req("@meteora-ag/dlmm");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  for (const p of ["HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR", "BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh"]) {
    try {
      const pool: any = await create(conn, new PublicKey(p), { cluster: config.cluster as any });
      console.log(p, "x:", pool.tokenX?.publicKey?.toString(), "y:", pool.tokenY?.publicKey?.toString());
    } catch (e) { console.log(p, "ERR", String(e).slice(0, 60)); }
  }
})();
