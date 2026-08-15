// Dashboard : serveur HTTP minimal (aucun build). Sert dashboard/index.html + /api/dashboard.json.
// Live mode (DASHBOARD_LIVE=true) : lit la DB directement (export à la volée).

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { exportData } from "./export.js";

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

export function startDashboard(): void {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    try {
      if (url.pathname === "/api/dashboard.json") {
        const file = config.dashboardLive ? exportData() : path.join(config.dataDir, "export", "dashboard.json");
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
