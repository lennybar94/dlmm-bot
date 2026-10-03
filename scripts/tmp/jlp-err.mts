import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await DLMM.create(conn, new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"));
try {
  const ba = await p.getBinArrayForSwap(true, 8);
  const q = p.swapQuote(new BN((255_000_000).toString()), true, new BN(200), ba);
  console.log("SDK quote out raw:", q.outAmount.toString(), "minOut:", q.minOutAmount.toString());
} catch (e) { console.log("quote ERR:", String(e).slice(0, 200)); }
