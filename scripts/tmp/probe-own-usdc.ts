import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const usdc = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  const accs = await conn.getProgramAccounts(req("@solana/spl-token").TOKEN_PROGRAM_ID ?? new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"), {
    encoding: "base64", dataSlice: { offset: 0, length: 72 },
    filters: [{ memcmp: { offset: 0, bytes: usdc.toString() } }],
  });
  console.log("usdc accounts total:", accs.length);
})();
