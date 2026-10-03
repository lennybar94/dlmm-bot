import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  // pairs X=SOL Y=USDC (offsets 88/120 confirmed on this program's account layout)
  const accs = await conn.getProgramAccounts(DLMM, {
    encoding: "base64", dataSlice: { offset: 0, length: 440 },
    filters: [
      { memcmp: { offset: 88, bytes: SOLb58 } },
      { memcmp: { offset: 120, bytes: USDCb58 } },
    ],
  });
  console.log("X=SOL Y=USDC pairs:", accs.length);
  const rows = [];
  for (const a of accs) {
    const buf = Buffer.from(a.account.data, "base64");
    const binStep = buf.readUInt16LE(408);
    const vx = new PublicKey(buf.subarray(152, 184)), vy = new PublicKey(buf.subarray(184, 216));
    const [ax, ay] = await Promise.all([conn.getAccountInfo(vx), conn.getAccountInfo(vy)]);
    const amtX = ax?.data ? Number(ax.data.readBigUInt64LE(64)) / 1e9 : 0;
    const amtY = ay?.data ? Number(ay.data.readBigUInt64LE(64)) / 1e6 : 0;
    rows.push({ addr: a.pubkey.toBase58(), tvl: amtX * 119.3 + amtY, binStep });
  }
  rows.sort((a, b) => b.tvl - a.tvl);
  for (const r of rows.slice(0, 10)) console.log(r.addr, Math.round(r.tvl / 1000) + "k$", "binStep", r.binStep);
})();
