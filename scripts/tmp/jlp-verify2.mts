import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../../src/config.js";
const conn = new Connection(config.rpcUrl, "confirmed");
async function ui(mint: string) {
  const accs = await conn.getParsedTokenAccountsByOwner(new PublicKey(config.walletAddress), { mint: new PublicKey(mint) });
  return accs.value.map(a => a.account.data.parsed.info.tokenAmount.uiString).join(" + ") || "aucun ATA";
}
console.log("USDC:", await ui("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"));
console.log("JLP:", await ui("27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"));
console.log("SOL lamports raw:", String(await conn.getBalance(new PublicKey(config.walletAddress))));
