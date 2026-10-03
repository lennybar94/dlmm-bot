const r = await fetch("https://dlmm.datapi.meteora.ag/pair/5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf", { headers: { accept: "application/json" } });
console.log("status:", r.status, "len:", (await r.text()).length);
const apiBase = process.env.DLMM_API_BASE || "https://dlmm-api.meteora.ag";
try {
  const r2 = await fetch(`${apiBase}/pair/5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10000) });
  const t2 = await r2.text();
  console.log("alt status:", r2.status, "len:", t2.length);
  if (t2.length > 10) { const d = JSON.parse(t2); console.log(JSON.stringify({ price: d.current_price, bin_step: d.bin_step, x_mint: d.token_x?.mint, x_dec: d.token_x?.decimals }).slice(0,300)); }
} catch(e){ console.log("alt ERR", String(e).slice(0,80)); }
