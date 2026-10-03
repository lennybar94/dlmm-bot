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
    encoding: "base64", dataSlice: { offset: 0, length: 216 },
    filters: [
      { memcmp: { offset: 88, bytes: SOLb58 } },
      { memcmp: { offset: 120, bytes: USDCb58 } },
    ],
  });
  console.log("pairs:", accs.length);
  const rows = [];
  for (let i = 0; i < accs.length; i += 25) {
    const chunk = accs.slice(i, i + 25);
    const pks = chunk.flatMap(c => { const b = Buffer.from(c.account.data, "base64"); return [new PublicKey(b.subarray(152, 184)), new PublicKey(b.subarray(184, 216))]; });
    const res = await conn.getMultipleAccountsInfo(pks);
    chunk.forEach((c, j) => {
      const sx = res[j * 2]?.data, sy = res[j * 2 + 1]?.data;
      const solAmt = sx ? Number(sx.readBigUInt64LE(64)) / 1e9 : 0;
      rows.push({ addr: c.pubkey.toBase58(), solAmt });
    });
    await new Promise(r => setTimeout(r, 250));
  }
  rows.sort((a, b) => b.solAmt - a.solAmt);
  for (const r of rows.slice(0, 10)) console.log(r.addr, "SOL vault:", r.solAmt.toFixed(0));
})();
