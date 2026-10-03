import { fetchPool } from "../../src/api.js";
(async () => {
  for (const p of ["5rCf1DM8LjKTw4YqhnoLcngyZYeNnQqztScTogYHAS6","HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR"]) {
    const pool = await fetchPool(p);
    console.log(p.slice(0,6), JSON.stringify({ x: pool.token_x.symbol, y: pool.token_y.symbol, price: pool.current_price, name: pool.name }));
  }
})();
