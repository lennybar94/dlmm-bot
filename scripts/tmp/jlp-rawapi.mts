const r = await fetch("https://dlmm.datapi.meteora.ag/pair/5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf", { headers: { accept: "application/json" } });
const d: any = await r.json();
console.log(JSON.stringify({ current_price: d.current_price, bin_step: d.bin_step, token_x: { mint: d.token_x?.mint, symbol: d.token_x?.symbol, decimals: d.token_x?.decimals }, x_amount: d.token_x_amount, y_amount: d.token_y_amount, tvl: d.tvl }, null, 1).slice(0, 600));
