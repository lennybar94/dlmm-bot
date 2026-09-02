const db = require("better-sqlite3")("data/dlmm-bot.db", { readonly: true });
const rows = db.prepare("SELECT id, name, status, closed_at, close_reason FROM real_positions ORDER BY id DESC LIMIT 14").all();
for (const r of rows) {
  const closed = r.closed_at ? new Date(Number(r.closed_at)).toLocaleString("fr-FR") : "-";
  console.log(`#${r.id} ${r.name} [${r.status}] closed=${closed} reason=${r.close_reason || "-"}`);
}
console.log("--- events aujourd'hui ---");
const ev = db.prepare("SELECT datetime(ts/1000,'unixepoch','localtime') t, type, substr(message,1,110) m FROM events WHERE ts > (strftime('%s','now')-6*3600)*1000 ORDER BY id").all();
for (const e of ev) console.log(e.t, "|", e.type, "|", e.m);
