import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey, Connection } = req("@solana/web3.js");
(async () => {
  const conn = new Connection(config.rpcUrl, "confirmed");
  const resp = await fetch("https://dlmm-api.meteora.ag/pair/all_by_groups?page=0&page_size=1", { headers: { accept: "application/json" } });
  console.log("status", resp.status);
})();
