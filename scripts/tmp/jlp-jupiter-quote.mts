import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await DLMM.create(conn, new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"));
const ba = await p.getBinArrayForSwap(true, 8);
const q = p.swapQuote(new BN((2_500_000).toString()), true, new BN(200), ba);
console.log("SDK quote out raw:", q.outAmount.toString(), "=", (Number(q.outAmount)/1e6).toFixed(4), "JLP");
// Jupiter exact-out : je veux 0.437 JLP (raw 437000) — combien de USDC ?
const JUP_X = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const JUP_Y = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
for (const swapForY of [true, false]) {
  const r = await fetch(`https://lite-api.jup.ag/swap/v1/quote?inputMint=${swapForY?JUP_Y:JUP_X}&outputMint=${swapForY?JUP_X:JUP_Y}&amount=${swapForY?2500000:437000}&slippageBps=50&restrictIntermediateTokens=true`);
  if (!r.ok) { console.log(swapForY?"USDC->JLP":"JLP->USDC", "HTTP", r.status); continue; }
  const d: any = await r.json();
  console.log(swapForY?"USDC->JLP":"JLP->USDC", "in:", d.inAmount, "out:", d.outAmount, "routes:", d.routePlan?.map((x:any)=>x.swapInfo?.poolType).join(","));
}
