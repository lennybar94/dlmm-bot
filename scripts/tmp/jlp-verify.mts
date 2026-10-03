import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../../src/config.js";
const conn = new Connection(config.rpcUrl, "confirmed");
async function ui(mint: string) {
  const accs = await conn.getParsedTokenAccountsByOwner(new PublicKey(config.walletAddress), { mint: new PublicKey(mint) });
  return accs.value.map(a => Number(a.account.data.parsed.info.tokenAmount.uiString));
}
console.log("USDC wallet:", (await ui("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")).join("+"));
console.log("JLP(JidD4) wallet:", (await ui("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4")).join("+") || "0");
console.log("SOL wallet:", (await conn.getBalance(new PublicKey(config.walletAddress))).lamports / 1e9);
