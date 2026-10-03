import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const accs = await conn.getProgramAccounts(DLMM, {
    encoding: "base64", dataSlice: { offset: 0, length: 74 },
    filters: [{ memcmp: { offset: 88, bytes: SOLb58 } }],
  });
  console.log("SOL@88:", accs.length);
  const accs2 = await conn.getProgramAccounts(DLMM, {
    encoding: "base64", dataSlice: { offset: 0, length: 480 },
    filters: [
      { memcmp: { offset: 88, bytes: SOLb58 } },
      { memcmp: { offset: 120, bytes: USDCb58 } },
    ],
  });
  console.log("SOL-USDC pairs:", accs2.length);
  for (const a of accs2) {
    const buf = Buffer.from(a.account.data, "base64");
    console.log(a.pubkey.toBase58(), "binStep:", buf.readUInt16LE(88 + 320), "activeId:", buf.readInt32LE(88 + 260));
  }
})();
