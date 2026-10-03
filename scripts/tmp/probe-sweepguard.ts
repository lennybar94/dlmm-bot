import { db } from "../../src/db.js";
console.log("pending:", (db.prepare("SELECT 1 FROM pilot_inventory WHERE mint = 'So11111111111111111111111111111111111111112' AND status = 'pending' LIMIT 1").get() as unknown) ?? "none");
