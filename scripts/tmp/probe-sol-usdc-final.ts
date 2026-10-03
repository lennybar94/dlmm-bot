import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  // both orientations: X=SOL Y=USDC and X=USDC Y=SOL
  const accs = await conn.getProgramAccounts(DLMM, {
    encoding: "base64", dataSlice: { offset: 0, length: 216 },
    filters: [{ memcmp: { offset: 88, bytes: SOLb58 } }, { memcmp: { offset: 120, bytes: USDCb58 } }],
  });
  const accs2 = await conn.getProgramAccounts(DLMM, {
    encoding: "base64", dataSlice: { offset: 0, length: 216 },
    filters: [{ memcmp: { offset: 88, bytes: USDCb58 } }, { memcmp: { offset: 120, bytes: SOLb58 } }],
  });
  console.log("orient:", accs.length, accs2.length);
  const all = [...accs.map(a => ({ a, flip: false })), ...accs2.map(a => ({ a, flip: true }))];
  const rows = [];
  for (let i = 0; i < all.length; i += 25) {
    const chunk = all.slice(i, i + 25);
    const pks = chunk.flatMap(c => [new PublicKey(Buffer.from(c.a.account.data, "base64").subarray(152, 184)), new PublicKey(Buffer.from(c.a.account.data, "base64").subarray(184, 216))]);
    const res = await conn.getMultipleAccountsInfo(pks);
    chunk.forEach((c, j) => {
      const buf = Buffer.from(c.a.account.data, "base64");
      const sX = res[j * 2]?.data, sY = res[j * 2 + 1]?.data;
      const amtSol = c.flip ? (sY ? Number(sY.readBigUInt64LE(64)) / 1e9 : 0) : (sX ? Number(sX.readBigUInt64LE(64)) / 1e9 : 0);
      const amtUsdc = c.flip ? (sX ? Number(sX.readBigUInt64LE(64)) / 1e6 : 0) : (sY ? Number(sY.readBigUInt64LE(64)) / 1e6 : 0);
      rows.push({ addr: c.a.pubkey.toBase58(), tvl: amtSol * 119.3 + amtUsdc });
    });
    await new Promise(r => setTimeout(r, 250));
  }
  rows.sort((a, b) => b.tvl - a.tvl);
  for (const r of rows.slice(0, 8)) console.log(r.addr, Math.round(r.tvl / 1000) + "k$");
})();
