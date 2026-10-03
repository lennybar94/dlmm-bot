(async () => {
  const base = "https://dlmm-api.meteora.ag";
  const alt = "https://damm-api.meteora.ag";
  for (const b of [base, alt]) {
    try {
      const r = await fetch(b + "/pair/SOL-USDC?page=0&page_size=50", { headers: { accept: "application/json" } });
      console.log(b, r.status);
      if (r.ok) {
        const j = await r.json();
        const arr = Array.isArray(j) ? j : (j.data ?? []);
        const rows = arr.map((p: any) => ({ addr: p.pair_address ?? p.address, tvl: p.usdTVL ?? p.tvl, vol: p.usdVolume24H ?? p.volume_24h }))
          .filter((x: any) => x.addr !== "5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6" && x.addr !== "BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y")
          .sort((a: any, b2: any) => (b2.tvl ?? 0) - (a.tvl ?? 0));
        for (const x of rows.slice(0, 10)) console.log(x.addr, Math.round((x.tvl ?? 0) / 1000) + "k$", "vol", Math.round((x.vol ?? 0) / 1000) + "k$");
        break;
      }
    } catch (e) { console.log(b, "ERR", String(e).slice(0, 80)); }
  }
})();
