(async () => {
  const base = "https://dlmm.datapi.meteora.ag";
  const r = await fetch(base + "/pools?page=0&page_size=100&tokenX=So11111111111111111111111111111111111111112&tokenY=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", { headers: { accept: "application/json" } });
  console.log("status", r.status);
  if (r.ok) {
    const j: any = await r.json();
    const arr = j.data ?? [];
    const bad = new Set(["5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6","BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y","BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh","HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR"]);
    const rows = arr.filter((p: any) => !bad.has(p.address)).sort((a: any, b: any) => (b.tvl ?? 0) - (a.tvl ?? 0));
    for (const p of rows.slice(0, 10)) console.log(p.address, p.name, Math.round((p.tvl ?? 0) / 1000) + "k$", "vol", Math.round((p.volume_24h ?? 0) / 1000) + "k$", "binStep", p.pool_config?.bin_step);
  }
})();
