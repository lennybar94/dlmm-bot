// Dashboard : serveur HTTP minimal (aucun build). Sert dashboard/index.html + /api/dashboard.json.
// Live mode (DASHBOARD_LIVE=true) : lit la DB directement (export à la volée).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { exportData } from "./export.js";
import { db } from "./db.js";

const root = path.resolve(config.root, "dashboard");
const htmlPath = path.join(root, "index.html");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

// Cache serveur du proxy pool (30 s) — évite de marteler la Data API (30 RPS).
const poolCache = new Map<string, { at: number; data: unknown }>();
const POOL_ADDR_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const DATA_API = "https://dlmm.datapi.meteora.ag";

async function servePool(reqUrl: URL, res: http.ServerResponse): Promise<void> {
  const addr = decodeURIComponent(reqUrl.pathname.slice("/api/pool/".length));
  if (!POOL_ADDR_RE.test(addr)) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "adresse invalide" }));
    return;
  }
  const cached = poolCache.get(addr);
  if (cached && Date.now() - cached.at < 30_000) {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(cached.data));
    return;
  }
  const [poolRes, ohlcvRes] = await Promise.all([
    fetch(`${DATA_API}/pools/${addr}`, { signal: AbortSignal.timeout(15_000) }),
    fetch(`${DATA_API}/pools/${addr}/ohlcv?interval=1h`, { signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!poolRes.ok) {
    res.writeHead(502, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: `Data API ${poolRes.status}` }));
    return;
  }
  const pool = (await poolRes.json()) as Record<string, unknown>;
  const ohlcv = (await ohlcvRes.json().catch(() => null)) as { data?: unknown[] } | null;
  const scanRow = db
    .prepare(
      `SELECT score, signals, strategy_hint, pool_age_days, launchpad, current_price
       FROM pool_scans WHERE pool_address=? ORDER BY scanned_at DESC LIMIT 1`
    )
    .get(addr) as { score: number; signals: string; strategy_hint: string; pool_age_days: number; launchpad: string | null; current_price: number } | undefined;
  const paper = db
    .prepare(
      `SELECT datetime(opened_at/1000,'unixepoch') AS opened, strategy, deposit_usd, fees_earned_usd, status
       FROM paper_positions WHERE pool_address=? ORDER BY opened_at DESC LIMIT 10`
    )
    .all(addr);
  const real = db
    .prepare(
      `SELECT id, name, strategy, status, deposit_usd, amount_y, min_bin_id, max_bin_id,
              position_pubkey, sig, datetime(opened_at/1000,'unixepoch') AS opened,
              datetime(closed_at/1000,'unixepoch') AS closed
       FROM real_positions WHERE pool_address=? ORDER BY id DESC LIMIT 3`
    )
    .all(addr);
  const realMarks = db
    .prepare(
      `SELECT taken_at, value_usd, fees_usd, net_pnl_usd, in_range
       FROM real_marks WHERE position_id IN (SELECT id FROM real_positions WHERE pool_address=?)
       ORDER BY id ASC LIMIT 200`
    )
    .all(addr);
  const scan = scanRow
    ? {
        score: scanRow.score,
        signals: JSON.parse(scanRow.signals ?? "[]"),
        hint: JSON.parse(scanRow.strategy_hint ?? "{}"),
        age_days: scanRow.pool_age_days,
        launchpad: scanRow.launchpad,
      }
    : null;
  const data = { pool, candles: ohlcv?.data ?? [], scan, paper, real, realMarks, fetched_at: Date.now() };
  poolCache.set(addr, { at: Date.now(), data });
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(data));
}

export function startDashboard(): void {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (url.pathname.startsWith("/api/pool/")) {
        await servePool(url, res);
        return;
      }
      if (url.pathname === "/api/real/open") {
        const rows = db
          .prepare(
            `SELECT id, name, pool_address, strategy, deposit_usd, position_pubkey, status
             FROM real_positions WHERE status='open' ORDER BY id DESC`
          )
          .all();
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(rows));
        return;
      }
      if (url.pathname === "/api/dashboard.json") {
        const file = config.dashboardLive
          ? await exportData()
          : path.join(config.dataDir, "export", "dashboard.json");
        const data = fs.readFileSync(file);
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(data);
        return;
      }
      if (url.pathname === "/api/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            ok: true,
            time: Date.now(),
            live: config.dashboardLive,
            uptime_sec: Math.round(process.uptime()),
          })
        );
        return;
      }
      const filePath = path.join(root, url.pathname === "/" ? "index.html" : url.pathname);
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        const ext = path.extname(filePath);
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream" });
        res.end(fs.readFileSync(filePath));
        return;
      }
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("404");
    } catch (err) {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end(`500: ${String(err)}`);
    }
  });

  server.listen(config.dashboardPort, config.dashboardHost, () => {
    console.log(
      `[dashboard] http://${config.dashboardHost}:${config.dashboardPort} (live=${config.dashboardLive})`
    );
  });
}
