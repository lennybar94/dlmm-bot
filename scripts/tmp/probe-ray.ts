import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PublicKey, Connection } = require("@solana/web3.js");
const { create } = require("@meteora-ag/dlmm");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  console.log("RPC:", config.rpcUrl.slice(0, 70), "cluster:", config.cluster);
  for (const p of ["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"]) {
    try {
      const pool: any = await create(conn, new PublicKey(p), { cluster: config.cluster as any });
      console.log(p, "OK tokenX:", pool.tokenX?.publicKey?.toString(), "tokenY:", pool.tokenY?.publicKey?.toString());
    } catch (e) {
      console.log(p, "ERR:", String(e).slice(0, 140));
    }
  }
})();
