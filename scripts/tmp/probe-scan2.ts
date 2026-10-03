import { config } from "../../src/config.js";
(async () => {
  const url = "https://dlmm-api.meteora.ag/pair/search?tokens=So11111111111111111111111111111111111111112,EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v&page=0&page_size=20";
  const resp = await fetch(url, { headers: { accept: "application/json" } });
  console.log("status", resp.status);
  if (resp.ok) {
    const j = await resp.json();
    for (const p of (Array.isArray(j) ? j : j.data ?? [])) {
      console.log(p.pair_address ?? p.address, "| tvl:", Math.round((p.tvl ?? p.usdTVL ?? 0)/1000)+"k$", "| vol24h:", Math.round((p.volume_24h ?? p.usdVolume24H ?? 0)/1000)+"k$");
    }
  } else {
    // try another endpoint
    const r2 = await fetch("https://dlmm-api.meteora.ag/pair/highest_tvl?page=0&page_size=5", { headers: { accept: "application/json" } });
    console.log("alt status", r2.status);
  }
})();
