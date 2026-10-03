import { getSolPriceUsd } from "../../src/export.js";
const p = await getSolPriceUsd();
console.log("getSolPriceUsd():", p);
