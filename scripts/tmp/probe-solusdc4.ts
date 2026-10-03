import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PublicKey, Connection } = require("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const toB64 = (b58: string) => new PublicKey(b58).toBuffer().toString("base64");
  const accs = await conn.getProgramAccounts(DLMM, {
    encoding: "base64",
    dataSlice: { offset: 0, length: 74 },
    filters: [
      { memcmp: { offset: 8, bytes: toB64(SOLb58) } },
      { memcmp: { offset: 40, bytes: toB64(USDCb58) } },
    ],
  });
  console.log("pairs:", accs.length);
  for (const a of accs) {
    const buf = Buffer.from(a.account.data, "base64");
    console.log(a.pubkey.toBase58(), "binStep:", buf.readUInt16LE(72), "activeId:", buf.readInt32LE(340));
  }
})();
