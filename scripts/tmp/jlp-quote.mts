import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
const poolAddr = "5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await DLMM.create(conn, new PublicKey(poolAddr));
console.log("tokenX:", p.tokenX?.publicKey?.toBase58?.(), "dec", p.tokenX?.decimal);
console.log("tokenY:", p.tokenY?.publicKey?.toBase58?.(), "dec", p.tokenY?.decimal);
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const xIsUsdc = p.tokenX.publicKey.toBase58() === USDC;
const swapForY = !xIsUsdc;
console.log("stableIsX:", xIsUsdc, "swapForY:", swapForY);
for (const amtUi of [2.5, 250]) {
  const inRaw = BigInt(Math.floor(amtUi * 1e6));
  const ba = await p.getBinArrayForSwap(swapForY, 8);
  const q = p.swapQuote(new BN(inRaw.toString()), swapForY, new BN(200), ba);
  console.log(`in ${amtUi} USDC -> out ${(Number(q.outAmount)/1e6).toFixed(4)} JLP · consumed ${(Number(q.consumedInAmount)/1e6).toFixed(4)} · price exec ${(amtUi/(Number(q.outAmount)/1e6)).toFixed(3)} $/JLP`);
}
console.log("activeBin priceOfOneTokenX:", p.activeBin?.priceOfOneTokenX?.toString());
