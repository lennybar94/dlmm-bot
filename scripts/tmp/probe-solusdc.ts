import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { PublicKey, Connection } = require("@solana/web3.js");
const { create } = require("@meteora-ag/dlmm");
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL = "So11111111111111111111111111111111111111112";
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const cands = [
    "J5AKLyNTQQiSgxD9TgV9gj6QEpNPUsMJ99U1v7W1uQN9", // SOL-USDC bin_step 1 (publiques)
    "ADrRR8iTrbRHUR3YeVKpYGzKmg35mBSck2LKhYVSvbXY", // SOL-USDC DLMM connu
    "B73xd6m0bsJ79Pt1GTdDtsiPHZtdA9FfrXFPoPBXPP1H", // SOL-USDC DLMM
    "6dpTZzxx9rnSTTRic625RPgZsqBRDFqA5PnHLfLxbLFB",
    "HZ1znDrW67xx3HYK2fNTBB6TjP2tnkPF4mcrJxnHe9ao",
    "cZnbvEdrAKD5AvqMvPTsVMxECPJ3h9jgAikLR2WTMF1",
    "AaNdL2AJKB8y7e6xBxYbxRCCLPGDbjBKubgcRmeuTFCT",
  ];
  for (const p of cands) {
    try {
      const pool: any = await create(conn, new PublicKey(p), { cluster: config.cluster as any });
      const x = pool.tokenX?.publicKey?.toString(), y = pool.tokenY?.publicKey?.toString();
      if ((x === SOL && y === USDC) || (x === USDC && y === SOL)) {
        console.log("MATCH", p, "binStep:", pool.lbPair?.binStep, "x:", x.slice(0,4), "y:", y.slice(0,4));
      } else console.log("nope", p, x?.slice(0,6), y?.slice(0,6));
    } catch (e) { console.log("ERR", p, String(e).slice(0, 60)); }
  }
})();
