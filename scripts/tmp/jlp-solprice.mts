import { fetchPool } from "../../src/api.js";
const p = await fetchPool("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf");
console.log("API price champ:", p.current_price, "· tokenX addr:", p.token_x.address);
// prix marché JLP en $ (Jupiter)
const j = await (await fetch("https://lite-api.jup.ag/tokens/v1/search?query=JLP")).json().catch(()=>null);
if (Array.isArray(j)) for (const t of j.slice(0,3)) console.log("jup:", t.symbol, t.address, t.usdPrice);
const s = await (await fetch("https://lite-api.jup.ag/tokens/v1/search?query=SOL")).json().catch(()=>null);
if (Array.isArray(s)) console.log("jup SOL usdPrice:", s[0]?.usdPrice);
