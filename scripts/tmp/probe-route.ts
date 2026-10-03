import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
const { create } = req("@meteora-ag/dlmm");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const accs = await conn.getProgramAccounts(DLMM, {
    encoding: "base64", dataSlice: { offset: 0, length: 216 },
    filters: [{ memcmp: { offset: 88, bytes: USDCb58 } }, { memcmp: { offset: 120, bytes: SOLb58 } }],
  });
  console.log("X=USDC Y=SOL pairs:", accs.length);
  const rows = [];
  for (let i = 0; i < accs.length; i += 25) {
    const chunk = accs.slice(i, i + 25);
    const pks = chunk.flatMap(c => [new PublicKey(Buffer.from(c.account.data, "base64").subarray(152, 184)), new PublicKey(Buffer.from(c.account.data, "base64").subarray(184, 216))]);
    const res = await conn.getMultipleAccountsInfo(pks);
    chunk.forEach((c, j) => {
      const sX = res[j * 2]?.data, sY = res[j * 2 + 1]?.data;
      const usdc = sX ? Number(sX.readBigUInt64LE(64)) / 1e6 : 0;
      const sol = sY ? Number(sY.readBigUInt64LE(64)) / 1e9 : 0;
      rows.push({ addr: c.pubkey.toBase58(), tvl: usdc + sol * 119.3 });
    });
    await new Promise(r => setTimeout(r, 250));
  }
  rows.sort((a, b) => b.tvl - a.tvl);
  // test SDK readability + quote on top 5
  for (const r of rows.slice(0, 5)) {
    let note = "";
    try {
      const pool: any = await create(conn, new PublicKey(r.addr), { cluster: config.cluster as any });
      note = `readable x=${pool.tokenX?.publicKey?.toString().slice(0, 4)} y=${pool.tokenY?.publicKey?.toString().slice(0, 4)}`;
    } catch (e) { note = "ERR " + String(e).slice(0, 50); }
    console.log(r.addr, Math.round(r.tvl / 1000) + "k$", note);
  }
})();
