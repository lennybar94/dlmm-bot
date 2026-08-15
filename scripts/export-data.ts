// Export JSON pour le dashboard : `npm run export:data`
import { exportData } from "../src/export.js";

const out = exportData();
console.log(`Export écrit : ${out}`);
