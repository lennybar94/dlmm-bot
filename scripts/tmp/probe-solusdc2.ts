import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PublicKey, Connection } = require("@solana/web3.js");
const { LbArrays } = require("@meteora-ag/dlmm");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const dlmm = new LbArrays("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo", { connection: conn });
  // binArray 0 covers lower price ids; SOL-USDC price ~119$ -> sqrtPrice around... fetch a few arrays and filter by token pairs is not possible directly.
  // Alternative: getProgramAccounts with filters on tokenX/tokenY offsets.
  const SOL = new PublicKey("So11111111111111111111111111111111111111112");
  const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const accs = await conn.getProgramAccounts(dlmm.programId, {
    encoding: "base64",
    dataSlice: { offset: 0, length: 0 }, // we only need pubkeys first? no—need filtering client side on mint. Use memory limit + filter on discriminator.
    filters: [
      { memcmp: { offset: 0, bytes: Buffer.alloc(8).toString("base64") } }, // lb_pair discriminator (8 zero bytes)
    ],
  }).catch(e => { console.log("program accounts too big:", String(e).slice(0,80)); return []; });
  console.log("found", accs.length);
})();
