(async () => {
  const base = "https://dlmm.datapi.meteora.ag";
  const r = await fetch(`${base}/pools/5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6`, { headers: { accept: "application/json" } });
  console.log(r.status);
  const j: any = await r.json();
  console.log(JSON.stringify(j, null, 1).slice(0, 1200));
})();
