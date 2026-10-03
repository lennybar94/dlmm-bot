import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const AMM4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  // pool layout: token_mint_a at offset 113? Actually Raydium AMM v4 lp_state: mints at offsets 113 and 145 (well-known). Try filter on mint_usdc at 145.
  for (const off of [113, 145]) {
    const accs = await conn.getProgramAccounts(AMM4, {
      encoding: "base64", dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: off, bytes: USDCb58 } }],
    }).catch(e => { console.log("off", off, "ERR", String(e).slice(0, 80)); return null; });
    if (accs) console.log("USDC at offset", off, "->", accs.length, "accounts");
  }
})();
