import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  for (const p of ["8sLbZusJSHwKrmWwTu2zNRPMgKqjCgdFHUT7oJ9n8QdE", "58oQChWR44wBhhyQThvMBiVc95b2HY2tm4BNiQFZMsMD", "EheT66voD1mMgSCGWhzb9TR3Pk6MJtRzqMhgRKtBWkrc"]) {
    const acc = await conn.getAccountInfo(new PublicKey(p)).catch(() => null);
    console.log(p.slice(0, 8), acc ? `owner ${acc.owner.toString()} len ${acc.data.length}` : "null");
  }
})();
