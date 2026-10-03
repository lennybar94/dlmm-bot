(async () => {
  const base = "https://dlmm.datapi.meteora.ag";
  // fetch top pools by tvl, filter SOL-USDC client side
  const rows: any[] = [];
  for (let page = 0; page < 6; page++) {
    const r = await fetch(`${base}/pools?page=${page}&page_size=100&sortBy=tvl:desc`, { headers: { accept: "application/json" } });
    if (!r.ok) { console.log("status", r.status); break; }
    const j: any = await r.json();
    rows.push(...(j.data ?? []));
    await new Promise(res => setTimeout(res, 120));
  }
  const hits = rows.filter((p: any) => {
    const mints = [p.token_x?.mint, p.token_y?.mint];
    return mints.includes("So11111111111111111111111111111111111111112") && mints.includes("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  }).sort((a, b) => (b.tvl ?? 0) - (a.tvl ?? 0));
  console.log("SOL-USDC in top", rows.length, ":", hits.length);
  for (const p of hits.slice(0, 10)) console.log(p.address, p.name, Math.round((p.tvl ?? 0) / 1000) + "k$", "vol", Math.round((p.volume_24h ?? 0) / 1000) + "k$", "binStep", p.pool_config?.bin_step);
})();
