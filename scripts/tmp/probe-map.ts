import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PublicKey, Connection } = require("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const ref = await conn.getAccountInfo(new PublicKey("5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6"));
  const buf = ref!.data;
  console.log("len", buf.length);
  const SOL = new PublicKey("So11111111111111111111111111111111111111112").toBuffer();
  const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v").toBuffer();
  console.log("SOL at:", buf.indexOf(SOL), "USDC at:", buf.indexOf(USDC));
})();
