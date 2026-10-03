import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const AMM4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  const accs = await conn.getProgramAccounts(AMM4, {
    encoding: "base64", dataSlice: { offset: 0, length: 200 },
    filters: [{ memcmp: { offset: 33, bytes: SOLb58 } }],
  });
  console.log("SOL@33:", accs.length);
  const accs2 = await conn.getProgramAccounts(AMM4, {
    encoding: "base64", dataSlice: { offset: 0, length: 200 },
    filters: [{ memcmp: { offset: 65, bytes: SOLb58 } }],
  });
  console.log("SOL@65:", accs2.length);
})();
