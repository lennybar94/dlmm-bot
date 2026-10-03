import { fetchPool } from "../../src/api.js";
import { getSolPriceUsd } from "../../src/export.js";
const p = await fetchPool("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf");
const solUsd = await getSolPriceUsd();
console.log("solUsd:", solUsd, "· current_price:", p.current_price);
console.log("x0/y0 ratio check — TVL-implied X price $:", (p.tvl*0.5/p.token_x_amount).toFixed(3));
// dérive du champ API vs prix marché : facteur d'échelle
const mktXUsd = 4.871; // Jupiter usdPrice JLP vérifié à l'instant
console.log("facteur échelle API/marché:", (mktXUsd / (p.current_price * solUsd)).toFixed(4), "(1 = cohérent)");
