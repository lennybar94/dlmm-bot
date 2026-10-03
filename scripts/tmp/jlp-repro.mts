import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
const poolAddr = "5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await DLMM.create(conn, new PublicKey(poolAddr));
console.log("activeBin:", JSON.stringify({ id: p.activeBin?.binId, priceX: String(p.activeBin?.priceOfOneTokenX) }).slice(0,200));
for (const [tag, amt] of [["0.25$", 250_000n], ["2.5$", 2_500_000n], ["255$", 255_000_000n]] as [string,bigint][]) {
  const ba = await p.getBinArrayForSwap(true, 8);
  const q = p.swapQuote(new BN(amt.toString()), true, new BN(200), ba);
  console.log(tag, "-> out raw", q.outAmount.toString(), "=", (Number(q.outAmount)/1e6).toFixed(4), "JLP");
}
