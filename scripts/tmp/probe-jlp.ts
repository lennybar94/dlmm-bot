import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PublicKey, Connection } = require("@solana/web3.js");
const { create } = require("@meteora-ag/dlmm");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  for (const p of ["5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf", "HZ1znDrW67xx3HYK2fNTBB6TjP2tnkPF4mcrJxnHe9ao", "FLTRnuN8bBb5Sv7F9zFDoGMsVFRUYVAJROPLQytdzfs2"]) {
    try {
      const pool: any = await create(conn, new PublicKey(p), { cluster: config.cluster as any });
      console.log(p, "OK tokenX:", pool.tokenX?.publicKey?.toString(), "tokenY:", pool.tokenY?.publicKey?.toString());
    } catch (e) {
      console.log(p, "ERR:", String(e).slice(0, 100));
    }
  }
})();
