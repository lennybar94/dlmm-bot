import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../../src/config.js";
const conn = new Connection(config.rpcUrl, "confirmed");
const owner = new PublicKey(config.walletAddress);
const mints: Record<string,string> = { JLP_api:"27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4", JLP_watch:"27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJ4Dai", USDC:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" };
for (const [name, m] of Object.entries(mints)) {
  try {
    const accs = await conn.getParsedTokenAccountsByOwner(owner, { mint: new PublicKey(m) });
    console.log(name, m.slice(0,10), "→", accs.value.map(a => a.account.data.parsed.info.tokenAmount.uiString).join(", ") || "aucun ATA");
  } catch(e){ console.log(name, "ERR", String(e).slice(0,60)); }
}
console.log("wallet:", config.walletAddress);
