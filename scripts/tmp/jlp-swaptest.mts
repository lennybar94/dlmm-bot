import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await DLMM.create(conn, new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"));
console.log("tokenX dec:", p.tokenX?.decimal, "tokenY dec:", p.tokenY?.decimal);
for (const amtUi of [0.0001, 0.25]) {
  try {
    const r = await p.swap({
      inToken: new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
      outToken: new PublicKey("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"),
      inAmount: new BN(Math.floor(amtUi * 1e6).toString()),
      minOutAmount: new BN("1"),
      lbPair: new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"),
      user: new PublicKey("HsstWQzA65Zh2DKJTfWP5zkDLaZUi49UrJpbjku2w3az"),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    console.log(amtUi, "tx construit OK");
    break;
  } catch (e) { console.log(amtUi, "swap ERR:", String(e).slice(0, 150)); }
}
