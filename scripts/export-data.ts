// Export JSON pour le dashboard : `npm run export:data`
import { exportData } from "../src/export.js";

const out = await exportData();
console.log(`Export écrit : ${out}`);
