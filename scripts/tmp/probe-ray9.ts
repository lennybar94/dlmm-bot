import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const AMM4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  for (const off of [104, 136, 225, 257]) {
    try {
      const accs = await conn.getProgramAccounts(AMM4, {
        encoding: "base64", dataSlice: { offset: 0, length: 0 },
        filters: [{ memcmp: { offset: off, bytes: SOLb58 } }],
      });
      console.log("offset", off, "->", accs.length);
      if (accs.length) break;
    } catch (e) { console.log("offset", off, "ERR", String(e).slice(0, 60)); }
  }
})();
