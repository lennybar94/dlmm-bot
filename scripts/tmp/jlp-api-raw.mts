import { fetchPool } from "../../src/api.js";
const p = await fetchPool("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf");
console.log("token_x:", JSON.stringify(p.token_x));
console.log("token_y:", JSON.stringify(p.token_y));
console.log("price:", p.current_price, "· bin_step:", p.bin_step);
// cohérence : TVL côté X en $ si prix=X/SOL*SOLUSD vs si prix direct $
const solUsd = 205; // prix SOL réel du jour (wallet-balance affichait SOL~205$)
console.log("hypothèse A (prix SOL/X): valeur X =", p.token_x_amount * p.current_price * solUsd, "$ ; Y =", p.token_y_amount);
console.log("hypothèse B (prix $/X) : valeur X =", p.token_x_amount * p.current_price, "$ ; Y =", p.token_y_amount);
