import { config } from "../../src/config.js";
import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
const { PublicKey } = req("@solana/web3.js");
(async () => {
  const SOL = new PublicKey("So11111111111111111111111111111111111111112");
  const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  async function call(method: string, params: any) {
    const r = await fetch(config.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
    return await r.json();
  }
  let res = await call("getPoolsByTokens", [{ assetA: SOL.toBase58(), assetB: USDC.toBase58() }]);
  if (res.result?.values) {
    const rows = res.result.values.filter((v: any) => v.extension === "dlmm").sort((a: any, b: any) => b.tvl - a.tvl).slice(0, 10);
    for (const v of rows) console.log(v.address, "| protocol:", v.protocol, "| tvl:", Math.round(v.tvl/1000)+"k$", "| vol24h:", Math.round((v.volume?.usd_24h ?? 0)/1000)+"k$");
  } else {
    console.log("getPoolsByTokens failed:", JSON.stringify(res).slice(0, 200));
    res = await call("getFeeAndSlippageUpdatedPubkey", [SOL.toBase58(), USDC.toBase58()]);
    console.log(JSON.stringify(res).slice(0, 400));
  }
})();
