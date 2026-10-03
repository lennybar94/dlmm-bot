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
    encoding: "base64", dataSlice: { offset: 0, length: 410 },
    filters: [
      { memcmp: { offset: 88, bytes: SOLb58 } },
      { memcmp: { offset: 120, bytes: USDCb58 } },
    ],
  });
  const rows = [];
  for (const a of accs) {
    const buf = Buffer.from(a.account.data, "base64");
    rows.push({ addr: a.pubkey.toBase58(), binStep: buf.readUInt16LE(408), vx: new PublicKey(buf.subarray(152, 184)), vy: new PublicKey(buf.subarray(184, 216)) });
  }
  // TVL via vault balances in batches
  const out = [];
  for (let i = 0; i < rows.length; i += 20) {
    const chunk = rows.slice(i, i + 20);
    const res = await conn.getMultipleAccountsInfo(chunk.flatMap(r => [r.vx, r.vy]));
    chunk.forEach((r, j) => {
      const sx = res[j * 2]?.data, sy = res[j * 2 + 1]?.data;
      const amtX = sx ? Number(sx.readBigUInt64LE(64)) / 1e9 : 0;
      const amtY = sy ? Number(sy.readBigUInt64LE(64)) / 1e6 : 0;
      out.push({ addr: r.addr, binStep: r.binStep, tvl: amtX * 119.3 + amtY });
    });
    await new Promise(rr => setTimeout(rr, 250));
  }
  out.sort((a, b) => b.tvl - a.tvl);
  for (const r of out.filter(x => x.binStep <= 10).slice(0, 12)) console.log(r.addr, Math.round(r.tvl / 1000) + "k$", "binStep", r.binStep);
})();
