import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await DLMM.create(conn, new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"));
const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1v".replace("1v","1v") === "" ? "" : "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const JLP = new PublicKey("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4");
const WALLET = new PublicKey("HsstWQzA65Zh2DKJTfWP5zkDLaZUi49UrJpbjku2w3az");
for (const amtUi of [0.25, 255]) {
  const inRaw = BigInt(Math.floor(amtUi * 1e6));
  const ba = await p.getBinArrayForSwap(true, 8);
  const q = p.swapQuote(new BN(inRaw.toString()), true, new BN(200), ba);
  // echo strict de swap-stable.ts
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const tx: any = await p.swap({ inToken: USDC, outToken: JLP, inAmount: q.consumedInAmount, minOutAmount: q.minOutAmount, lbPair: new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"), user: WALLET, binArraysPubkey: q.binArraysPubkey });
    console.log(`${amtUi}$ : construction OK`);
  } catch(e) { console.log(`${amtUi}$ : SIM FAIL`, String(e).match(/Error Code: [\w]+/)?.[0] ?? String(e).slice(0,80)); }
}
