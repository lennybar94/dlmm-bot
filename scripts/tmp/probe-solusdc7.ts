import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PublicKey, Connection } = require("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const accs = await conn.getProgramAccounts(DLMM, {
    encoding: "base64",
    dataSlice: { offset: 0, length: 480 },
    filters: [
      { memcmp: { offset: 40, bytes: SOLb58 } },
      { memcmp: { offset: 73, bytes: USDCb58 } },
    ],
  });
  console.log("pairs:", accs.length);
  for (const a of accs) {
    const buf = Buffer.from(a.account.data, "base64");
    // active_id at 348 per reference layout (0-based)
    console.log(a.pubkey.toBase58(), "binStep:", buf.readUInt16LE(408), "activeId:", buf.readInt32LE(348));
  }
})();
