import { Connection, PublicKey } from "@solana/web3.js";
import { config } from "../../src/config.js";
const conn = new Connection(config.rpcUrl, "confirmed");
const owner = new PublicKey(config.walletAddress);
const res = await conn.getParsedTokenAccountsByOwner(owner, { programId: new PublicKey("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") });
let dustTotal = 0;
for (const a of res.value) {
  const i = a.account.data.parsed.info;
  const bal = Number(i.tokenAmount.uiString);
  if (bal > 0.0001) console.log(i.mint, "=", i.tokenAmount.uiString); else dustTotal++;
}
console.log("(comptes à solde ~0:", dustTotal, ")");
