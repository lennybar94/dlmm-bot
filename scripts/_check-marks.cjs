const db = require("better-sqlite3")("data/dlmm-bot.db", { readonly: true });
const r = db.prepare("SELECT datetime(MAX(taken_at)/1000,'unixepoch','localtime') t FROM real_marks").get();
console.log("dernier mark:", r.t);
const o = db.prepare("SELECT pool_name FROM real_positions WHERE status='open'").all();
console.log("ouvertes:", o.length, o.map((p) => p.pool_name).join(", "));
