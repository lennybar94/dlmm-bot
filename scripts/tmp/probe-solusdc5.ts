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
    dataSlice: { offset: 0, length: 74 },
    filters: [
      { memcmp: { offset: 8, bytes: SOLb58 } },
      { memcmp: { offset: 40, bytes: USDCb58 } },
    ],
  });
  console.log("pairs:", accs.length);
  const rows = [];
  for (const a of accs) {
    const buf = Buffer.from(a.account.data, "base64");
    rows.push([a.pubkey.toBase58(), buf.readUInt16LE(72)]);
  }
  for (const r of rows) console.log(...r);
})();
