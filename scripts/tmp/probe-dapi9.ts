(async () => {
  const base = "https://dlmm.datapi.meteora.ag";
  const r = await fetch(`${base}/pools?page=1&page_size=200&sort_by=tvl:desc`, { headers: { accept: "application/json" } });
  console.log("status", r.status);
  if (!r.ok) return;
  const j: any = await r.json();
  const rows = (j.data ?? []).filter((p: any) => {
    const mints = [p.token_x?.address, p.token_y?.address];
    return mints.includes("So11111111111111111111111111111111111111112") && mints.includes("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
  }).sort((a: any, b: any) => (b.tvl ?? 0) - (a.tvl ?? 0));
  for (const p of rows.slice(0, 10)) console.log(p.address, Math.round((p.tvl ?? 0)/1000)+"k$", "binStep", p.pool_config?.bin_step);
})();
