import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const acc = await conn.getAccountInfo(new PublicKey("5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"));
  console.log("owner:", acc?.owner.toString(), "len:", acc?.data.length);
})();
