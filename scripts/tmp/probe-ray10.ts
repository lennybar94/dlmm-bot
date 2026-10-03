import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const AMM4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  for (const off of [113, 145]) {
    const accs = await conn.getProgramAccounts(AMM4, {
      encoding: "base64", dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: off, bytes: USDCb58 } }],
    });
    console.log("USDC@%d -> %d accounts", off, accs.length);
  }
})();
