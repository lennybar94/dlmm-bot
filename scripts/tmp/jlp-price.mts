import { fetchPool } from "../../src/api.js";
const p = await fetchPool("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf");
console.log("API current_price:", p.current_price, "SOL/X · bin_step", p.bin_step);
// prix on-chain via SDK : activeBin price per tokenX raw
const { Connection, PublicKey } = await import("@solana/web3.js");
const DLMM = (await import("@meteora-ag/dlmm")).default;
const conn = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pool: any = await DLMM.create(conn, new PublicKey("5SHjDACvwtox5nY8kpWNYyaceWjtTG8C6L821D9Gtpjf"));
const ab = pool.activeBin ?? pool.getActiveBin?.();
console.log("sdk activePriceOfOneTokenX:", ab?.priceOfOneTokenX?.toString?.(), ab?.priceOfOneTokenXSol?.toString?.());
console.log("binStep sdk:", pool.binStep);
// quote SOL->JLP direct dans le pool? pas de SOL leg ici. On compare prix $ : JLP ~4.87$ ?
