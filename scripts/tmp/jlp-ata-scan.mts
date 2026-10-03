import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../../src/config.js";
const conn = new Connection(config.rpcUrl, "confirmed");
const owner = new PublicKey(config.walletAddress);
const res = await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
console.log("comptes token:", res.value.length);
for (const a of res.value) {
  const i = a.account.data.parsed.info;
  const bal = i.tokenAmount.uiString;
  if (Number(bal) > 0.0001) console.log(i.mint.slice(0,12), "=", bal);
}
