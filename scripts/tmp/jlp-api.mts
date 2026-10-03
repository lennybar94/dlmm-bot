import { fetchPool } from "../../src/api.js";
const p = await fetchPool("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf");
console.log(JSON.stringify({ x: { addr: p.token_x.address, sym: p.token_x.symbol, dec: p.token_x.decimals }, y: { addr: p.token_y.address, sym: p.token_y.symbol, dec: p.token_y.decimals }, price: p.current_price }, null, 1));
