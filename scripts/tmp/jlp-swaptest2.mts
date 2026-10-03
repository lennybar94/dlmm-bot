import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await DLMM.create(conn, new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"));
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const JLP = new PublicKey("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4");
const ba = await p.getBinArrayForSwap(true, 8);
const q = p.swapQuote(new BN((2_500_000).toString()), true, new BN(200), ba);
console.log("quote out:", q.outAmount.toString());
try {
  const tx = await p.swap({ inToken: USDC, outToken: JLP, inAmount: q.consumedInAmount, minOutAmount: q.minOutAmount, lbPair: new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"), user: new PublicKey("HsstWQzA65Zh2DKJTfWP5zkDLaZUi49UrJpbjku2w3az"), binArraysPubkey: q.binArraysPubkey });
  console.log("tx construite OK (pas envoyée)");
} catch(e){ console.log("swap() ERR:", String(e).slice(0,250)); }
