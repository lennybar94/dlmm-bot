import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PublicKey, Connection } = require("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  for (const off of [40, 41, 42]) {
    const accs = await conn.getProgramAccounts(DLMM, {
      encoding: "base64", dataSlice: { offset: 0, length: 74 },
      filters: [{ memcmp: { offset: off, bytes: SOLb58 } }],
    });
    console.log("offset", off, "->", accs.length, "accounts");
    if (accs.length) {
      // check second mint at off+32 or +33
      for (const a of accs.slice(0, 3)) {
        const buf = Buffer.from(a.account.data, "base64");
        console.log("  ", a.pubkey.toBase58(), "byte after:", buf[off - off + 32 + 32] /* n/a */);
      }
      const withUsdc = [];
      for (const off2 of [off + 32, off + 33]) {
        const accs2 = await conn.getProgramAccounts(DLMM, {
          encoding: "base64", dataSlice: { offset: 0, length: 480 },
          filters: [
            { memcmp: { offset: off, bytes: SOLb58 } },
            { memcmp: { offset: off2, bytes: USDCb58 } },
          ],
        }).catch(() => []);
        console.log("  +USDC at", off2, "->", accs2.length);
        if (accs2.length) {
          for (const a of accs2) {
            const buf = Buffer.from(a.account.data, "base64");
            console.log("    MATCH", a.pubkey.toBase58(), "binStep:", buf.readUInt16LE(off2 - 0 + 336));
          }
        }
      }
    }
  }
})();
