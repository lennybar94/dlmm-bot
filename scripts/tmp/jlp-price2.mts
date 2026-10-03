import { fetchPool } from "../../src/api.js";
const p = await fetchPool("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf");
console.log("x_amt:", p.token_x_amount, "y_amt:", p.token_y_amount, "tvl:", p.tvl, "price:", p.current_price);
// prix réel JLP en $ via Jupiter price API
const ids = "27G8MtK7VtTcCHkpASjSDdkWWYfoqT6ggEuKidVJidD4";
const r = await fetch(`https://lite-api.jup.ag/price/v3?ids=${ids}`);
console.log("jup v3:", (await r.text()).slice(0, 300));
