import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../../src/config.js";
const conn = new Connection(config.rpcUrl, "confirmed");
const owner = new PublicKey(config.walletAddress);
const res = await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
for (const a of res.value) {
  const i = a.account.data.parsed.info;
  if (["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v","27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4"].includes(i.mint)) {
    console.log(i.mint.slice(0,12), "ATA:", a.pubkey.toBase58(), "solde:", i.tokenAmount.uiString);
  }
}
