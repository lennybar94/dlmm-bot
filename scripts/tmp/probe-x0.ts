import { config } from "../../src/config.js";
import { fetchPool } from "../../src/api.js";
import { buildStrategyHint, binIdFromPrice, realizedVolatility } from "../../src/strategies.js";
import { fetchOhlcv } from "../../src/api.js";
import { buildLiquidity, estimateYUsd } from "../../src/paper.js";
(async () => {
  for (const pick of ["HTvjzsfX3yU6BUodCjZ5vZkUrAxMDTrBs3CJaq43ashR","BVRbyLjjfSBcoyiYFuxbgKYnWuiFaF9CSXEa5vdSZ9Hh"]) {
    const p = await fetchPool(pick);
    const candles = await fetchOhlcv(pick);
    const vol = realizedVolatility(candles);
    const yUsd = estimateYUsd(p);
    const activeBinId = binIdFromPrice(p.current_price, p.bin_step);
    const hint = buildStrategyHint(p, activeBinId, vol, "spot-spread", p.current_price, candles);
    const usd = 500;
    const depositY = usd / yUsd;
    const liq = buildLiquidity({ depositY, price: p.current_price, minBinId: hint.minBinId, maxBinId: hint.maxBinId, binStep: p.bin_step, oneSided: "none" });
    console.log(pick.slice(0,6), "x:", p.token_x.symbol, "y:", p.token_y.symbol, "price(SOL):", p.current_price.toFixed(4), "yUsd:", yUsd.toFixed(4), "x0:", liq.x0.toFixed(6), "y0:", liq.y0.toFixed(4));
  }
})();
