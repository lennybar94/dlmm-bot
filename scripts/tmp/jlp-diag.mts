import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import DLMM from "@meteora-ag/dlmm";
const poolAddr = "5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf";
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p: any = await DLMM.create(conn, new PublicKey(poolAddr));
console.log("lbPair tokenX:", p.lbPair?.tokenX?.toString?.() ?? p.lbPair?.tokenXMint?.toString?.());
console.log("sdk tokenX pk:", p.tokenX?.publicKey?.toBase58(), "dec:", p.tokenX?.decimal);
console.log("sdk tokenY pk:", p.tokenY?.publicKey?.toBase58(), "dec:", p.tokenY?.decimal);
const XREAL = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJ4Dai";
for (const [amtUi, dec] of [[250, 6], [250, 5]]) {
  const inRaw = BigInt(Math.floor(amtUi * 1e6));
  const ba = await p.getBinArrayForSwap(true, 8);
  try {
    const q = p.swapQuote(new BN(inRaw.toString()), true, new BN(200), ba);
    console.log(`dec=${dec} in ${amtUi} USDC -> out raw ${q.outAmount.toString()} = ${(Number(q.outAmount)/10**dec).toFixed(4)} JLP · price ${(amtUi/(Number(q.outAmount)/10**dec)).toFixed(3)} $/JLP`);
  } catch(e){ console.log(`dec=${dec} quote ERR`, String(e).slice(0,120)); }
}
