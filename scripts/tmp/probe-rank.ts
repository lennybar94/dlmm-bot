import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
const { create } = req("@meteora-ag/dlmm");
const SOLb58 = "So11111111111111111111111111111111111111112";
const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const DLMM = new PublicKey("LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo");
  const accs = await conn.getProgramAccounts(DLMM, {
    encoding: "base64", dataSlice: { offset: 0, length: 74 },
    filters: [
      { memcmp: { offset: 88, bytes: SOLb58 } },
      { memcmp: { offset: 120, bytes: USDCb58 } },
    ],
  });
  // exclude the two pilot candidate pools (they're X=SOL too but we don't want to route through them)
  const bad = new Set(["5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6","BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y"]);
  const ranked = [];
  for (const a of accs) {
    const addr = a.pubkey.toBase58();
    if (bad.has(addr)) continue;
    try {
      const pool: any = await create(conn, a.pubkey, { cluster: config.cluster as any });
      const tvlSol = Number(pool.lbPair.activeId ? 0 : 0); // not reliable; use liquidity via getPosition? fallback: binStep only
      ranked.push({ addr, binStep: pool.lbPair.binStep, activeId: pool.lbPair.activeId });
    } catch { /* skip */ }
  }
  console.log("readable:", ranked.length);
  // rank by TVL using RPC token accounts of vaults would be heavy; instead just print low binStep ones
  for (const r of ranked.filter(x => x.binStep <= 5).slice(0, 20)) console.log(r.addr, "binStep", r.binStep, "activeId", r.activeId);
})();
