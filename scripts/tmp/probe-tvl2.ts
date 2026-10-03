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
  const vaultPks: { addr: string; vx: PublicKey; vy: PublicKey }[] = [];
  for (const a of accs) {
    const buf = Buffer.from(a.account.data, "base64");
    vaultPks.push({ addr: a.pubkey.toBase58(), vx: new PublicKey(buf.subarray(152, 184)), vy: new PublicKey(buf.subarray(184, 216)) });
  }
  // multi-get all vault accounts in chunks
  const all = vaultPks.flatMap(v => [v.vx, v.vy]);
  const results: any[] = [];
  for (let i = 0; i < all.length; i += 100) {
    const chunk = all.slice(i, i + 100);
    const res = await conn.getMultipleAccountsInfo(chunk);
    results.push(...res);
  }
  const solUsd = 119.3;
  const rows = vaultPks.map((v, idx) => {
    const sx = results[idx * 2]?.data, sy = results[idx * 2 + 1]?.data;
    const amtX = sx ? Number(sx.readBigUInt64LE(64)) / 1e9 : 0;
    const amtY = sy ? Number(sy.readBigUInt64LE(64)) / 1e6 : 0;
    return { addr: v.addr, tvl: amtX * solUsd + amtY };
  }).sort((a, b) => b.tvl - a.tvl);
  for (const r of rows.slice(0, 12)) console.log(r.addr, Math.round(r.tvl / 1000) + "k$");
})();
