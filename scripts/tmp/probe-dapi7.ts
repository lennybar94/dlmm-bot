(async () => {
  const base = "https://dlmm.datapi.meteora.ag";
  const rows: any[] = [];
  for (let page = 1; page <= 6; page++) {
    const r = await fetch(`${base}/pools?page=${page}&page_size=100&sort_by=volume_24h:desc`, { headers: { accept: "application/json" } });
    if (!r.ok) { console.log("status", r.status); break; }
    const j: any = await r.json();
    rows.push(...(j.data ?? []));
    await new Promise(res => setTimeout(res, 150));
  }
  const hits = rows.filter((p: any) => {
    const mints = [p.token_x?.mint, p.token_y?.mint];
    return mints.includes("So11111111111111111111111111111111111111112") && mints.includes("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  }).sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  console.log("scanned", rows.length, "| SOL-USDC:", hits.length);
  const bad = new Set(["5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6","BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y","BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh","HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR"]);
  for (const p of hits.slice(0, 12)) console.log(bad.has(p.address) ? "[CAND]" : "      ", p.address, "tvl", Math.round((p.tvl ?? 0) / 1000) + "k$", "vol", Math.round((p.volume_24h ?? 0) / 1000) + "k$", "binStep", p.pool_config?.bin_step);
})();
