import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  for (const p of ["HZ1znDrW67xx3HYK2fNTBB6TjP2tnkPF4mcrJxnHe9ao", "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"]) {
    const acc = await conn.getAccountInfo(new PublicKey(p));
    console.log(p.slice(0,8), "owner:", acc?.owner.toString(), "len:", acc?.data.length ?? 0);
  }
})();
