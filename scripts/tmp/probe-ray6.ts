import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const AMM4 = new PublicKey("675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8");
  const SOLb58 = "So11111111111111111111111111111111111111112";
  const USDCb58 = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  for (const [offS, offU] of [[33, 65], [65, 33]]) {
    const accs = await conn.getProgramAccounts(AMM4, {
      encoding: "base64", dataSlice: { offset: 0, length: 400 },
      filters: [
        { memcmp: { offset: offS, bytes: SOLb58 } },
        { memcmp: { offset: offU, bytes: USDCb58 } },
      ],
    }).catch(e => null);
    if (!accs) { console.log("ERR pair", offS, offU); continue; }
    console.log(`SOL@${offS} USDC@${offU} -> ${accs.length}`);
    if (accs.length) {
      // vaultA at 105? layout: after mints come vault accounts. Print first few with balances
      for (const a of accs.slice(0, 3)) {
        const buf = Buffer.from(a.account.data, "base64");
        const vA = new PublicKey(buf.subarray(105, 137)), vB = new PublicKey(buf.subarray(137, 169));
        const [ra, rb] = await Promise.all([conn.getAccountInfo(vA), conn.getAccountInfo(vB)]);
        const amtA = ra?.data.readBigUInt64LE(64), amtB = rb?.data.readBigUInt64LE(64);
        console.log(" ", a.pubkey.toBase58(), "vaultAmt:", amtA ? Number(amtA)/1e9 : "?", amtB ? Number(amtB)/1e6 : "?");
      }
    }
  }
})();
