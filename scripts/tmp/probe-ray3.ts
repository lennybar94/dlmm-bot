import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const LAMMI = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  const CLMM = new PublicKey("CAMMCzo5YL8wVFFZ8W1ZBRXBtcutbZhubXVewGWyYBLD");
  for (const [name, prog] of [["Ray AMM v4", LAMMI], ["Ray CLMM", CLMM]] as const) {
    const accs = await conn.getProgramAccounts(prog, {
      encoding: "base64", dataSlice: { offset: 0, length: 0 },
      filters: [{ memcmp: { offset: 0, bytes: "" } }],
    }).catch(e => { console.log(name, "ERR", String(e).slice(0, 80)); return null; });
    if (accs) console.log(name, "accounts:", accs.length);
  }
})();
