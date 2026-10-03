import { config } from "../../src/config.js";
(async () => {
  for (const p of ["HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR","BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh","BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y"]) {
    const r = await fetch(`https://dlmm.datapi.meteora.ag/pools/${p}`, { headers: { accept: "application/json" } });
    const j: any = await r.json();
    console.log(p.slice(0,6), "x:", j.token_x.symbol, "y:", j.token_y.symbol, "tvl:", Math.round(j.tvl/1000)+"k$", "vol24h:", Math.round((j.volume?.total_24h ?? j.volume_24h ?? 0)/1000)+"k$", "binStep:", j.pool_config?.bin_step);
  }
})();
