import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await DLMM.create(conn, new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"));
for (const amtUi of [0.25, 255]) {
  const ba = await p.getBinArrayForSwap(true, 8);
  const q = p.swapQuote(new BN(Math.floor(amtUi * 1e6).toString()), true, new BN(200), ba);
  console.log(`${amtUi}$ -> out raw ${q.outAmount.toString()} = ${(Number(q.outAmount)/1e6).toFixed(4)} JLP`);
}
