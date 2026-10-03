(async () => {
  const base = "https://dlmm.datapi.meteora.ag";
  const tries = [
    "/pairs/search?keyword=SOL-USDC",
    "/pair?page=0&page_size=5",
    "/pairs?page=0&page_size=5&sortBy=tvl:desc",
    "/pair/all_by_groups?page=0&page_size=5",
  ];
  for (const t of tries) {
    try {
      const r = await fetch(base + t, { headers: { accept: "application/json" } });
      console.log(t, r.status);
      if (r.ok) {
        const txt = await r.text();
        console.log("  sample:", txt.slice(0, 200).replace(/\s+/g, " "));
      }
    } catch (e) { console.log(t, "ERR", String(e).slice(0, 60)); }
  }
})();
