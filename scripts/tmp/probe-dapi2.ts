(async () => {
  const base = "https://dlmm.datapi.meteora.ag";
  for (const path of ["/pair/SOL-USDC", "/pairs?tokens=SOL,USDC"]) {
    try {
      const r = await fetch(base + path + "?page=0&page_size=100", { headers: { accept: "application/json" } });
      console.log(path, r.status);
      if (r.ok) {
        const j: any = await r.json();
        const arr = Array.isArray(j) ? j : (j.data ?? []);
        const rows = arr.map((p: any) => ({ addr: p.address ?? p.pair_address, tvl: p.tvl, vol: p.volume_24h }))
          .filter((x: any) => !["5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6","BGm1tav58oGcsQJehL9WXBFXF7D27vZsKefj4xJKD5Y","BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh","HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR"].includes(x.addr))
          .sort((a: any, b: any) => (b.tvl ?? 0) - (a.tvl ?? 0));
        for (const x of rows.slice(0, 12)) console.log(x.addr, Math.round((x.tvl ?? 0) / 1000) + "k$", "vol", Math.round((x.vol ?? 0) / 1000) + "k$");
        break;
      }
    } catch (e) { console.log(path, "ERR", String(e).slice(0, 80)); }
  }
})();
