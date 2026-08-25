// ws-pool-monitor : listener TEMPS RÉEL sur les pools DLMM des positions
// ouvertes (étape 3 anti-limite-API, 2026-08-25).
//
// Principe : abonnement websocket (Helius) à 3 comptes par pool :
//   - le compte LbPair (active_id/bin_step → prix, et les adresses de réserve)
//   - les 2 comptes token reserve_x/reserve_y (amount u64 à l'offset 64 →
//     chaque swap les modifie → les DELTAS SONT le volume temps réel)
// Zéro polling, latence <1s, ~3 abonnements par position ouverte.
//
// PHASE 1 (collecte + log + heartbeat) : AUCUN exit branché — discipline omo
// (source unique, validation avant de piloter des sorties). Les données
// remplissent pool_events_rt (rétention 24 h) pour analyse/branchement futur.
//
// Résilience : reconnexion backoff (1→30s), re-souscription complète, refresh
// des positions ouvertes toutes les 5 min, heartbeat /tmp (même sans event),
// arrêt propre SIGINT/SIGTERM.
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Connection, PublicKey } = require("@solana/web3.js") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { create: createPool } = require("@meteora-ag/dlmm") as any;

const HEARTBEAT = "/tmp/dlmm-ws-monitor.heartbeat";
const REFRESH_POSITIONS_MS = 5 * 60_000;
const HEARTBEAT_MS = 30_000;
const RETENTION_MS = 24 * 3_600_000;
// Offset de l'amount dans un compte token SPL (standard ET token-2022)
const TOKEN_AMOUNT_OFFSET = 64;

db.exec(`CREATE TABLE IF NOT EXISTS pool_events_rt (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pool_address TEXT NOT NULL,
  ts INTEGER NOT NULL,
  active_bin_id INTEGER,
  delta_x REAL,
  delta_y REAL
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_pool_events_rt_pool_ts ON pool_events_rt(pool_address, ts)`);

function wsUrl(): string {
  return config.rpcUrl.replace(/^http/i, "ws");
}

interface PoolState {
  binStep: number;
  decX: number;
  decY: number;
  lastX: bigint | null;
  lastY: bigint | null;
  lastBin: number | null;
  events: number;
  deltaX: number;
  deltaY: number;
  lastEventTs: number;
  reserveX: string | null;
  reserveY: string | null;
  subPair: number | null;
  subRX: number | null;
  subRY: number | null;
  pool: unknown;
}

const states = new Map<string, PoolState>();
let conn: any = null;
let reconnecting = false;
let stopped = false;

function heartbeat(): void {
  try {
    require("node:fs").writeFileSync(HEARTBEAT, String(Date.now()));
  } catch {
    /* non bloquant */
  }
}

function log(msg: string): void {
  console.log(`[ws-pool-monitor ${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

function amountOf(data: Buffer): bigint {
  // account token SPL : amount = u64 à l'offset 64
  return data.readBigUInt64LE(TOKEN_AMOUNT_OFFSET);
}

// Mise à jour d'un compte de réserve (volume temps réel par delta d'amount)
function onReserve(poolAddr: string, side: "x" | "y", data: Buffer): void {
  const st = states.get(poolAddr);
  if (!st) return;
  try {
    const amount = amountOf(data);
    st.events++;
    if (side === "x") {
      if (st.lastX !== null) {
        const d = Number(amount - st.lastX) / 10 ** st.decX;
        if (Math.abs(d) > 0) {
          st.deltaX += Math.abs(d);
          db.prepare(
            `INSERT INTO pool_events_rt (pool_address, ts, active_bin_id, delta_x, delta_y) VALUES (?, ?, ?, ?, 0)`
          ).run(poolAddr, Date.now(), st.lastBin, d);
        }
      }
      st.lastX = amount;
    } else {
      if (st.lastY !== null) {
        const d = Number(amount - st.lastY) / 10 ** st.decY;
        if (Math.abs(d) > 0) {
          st.deltaY += Math.abs(d);
          db.prepare(
            `INSERT INTO pool_events_rt (pool_address, ts, active_bin_id, delta_x, delta_y) VALUES (?, ?, ?, 0, ?)`
          ).run(poolAddr, Date.now(), st.lastBin, d);
        }
      }
      st.lastY = amount;
    }
    st.lastEventTs = Date.now();
    heartbeat();
  } catch (e) {
    log(`réserve ${poolAddr}/${side} échouée: ${String(e).slice(0, 100)}`);
  }
}

// Mise à jour du LbPair (active_bin_id/bin_step → prix, adresses de réserve)
function onLbPair(poolAddr: string, data: Buffer): void {
  const st = states.get(poolAddr);
  if (!st) return;
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = st.pool as any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lb = (p as any).program?.coder?.accounts?.decode("lbPair", data) as any;
    if (!lb) return;
    const bin = Number(lb.active_id ?? lb.activeId);
    const binStep = Number(lb.bin_step ?? lb.binStep ?? 0);
    const rx = String(lb.reserve_x ?? lb.reserveX ?? "");
    const ry = String(lb.reserve_y ?? lb.reserveY ?? "");
    if (binStep > 0) st.binStep = binStep;
    if (Number.isFinite(bin)) st.lastBin = bin;
    if (rx && rx !== st.reserveX) {
      st.reserveX = rx;
      log(`${poolAddr.slice(0, 8)}… reserve_x = ${rx}`);
    }
    if (ry && ry !== st.reserveY) {
      st.reserveY = ry;
      log(`${poolAddr.slice(0, 8)}… reserve_y = ${ry}`);
    }
    st.lastEventTs = Date.now();
    heartbeat();
  } catch (e) {
    log(`lbPair ${poolAddr} échoué: ${String(e).slice(0, 100)}`);
  }
}

async function subscribePool(poolAddr: string): Promise<void> {
  const existing = states.get(poolAddr);
  if (existing && existing.subPair !== null) return;
  try {
    const pool = await createPool(conn, new PublicKey(poolAddr), { cluster: config.cluster });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const lb: any = (pool as any).lbPair;
    const st: PoolState = {
      binStep: Number(lb.bin_step ?? lb.binStep ?? 0),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decX: Number((pool as any).tokenX?.decimals ?? 9),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      decY: Number((pool as any).tokenY?.decimals ?? 9),
      lastX: null,
      lastY: null,
      lastBin: Number(lb.active_id ?? lb.activeId ?? null),
      events: 0,
      deltaX: 0,
      deltaY: 0,
      lastEventTs: Date.now(),
      reserveX: String(lb.reserve_x ?? lb.reserveX ?? ""),
      reserveY: String(lb.reserve_y ?? lb.reserveY ?? ""),
      subPair: null,
      subRX: null,
      subRY: null,
      pool,
    };
    const addr = new PublicKey(poolAddr);
    st.subPair = await conn.onAccountChange(addr, (info: { data: Buffer }) => onLbPair(poolAddr, info.data));
    if (st.reserveX) {
      st.subRX = await conn.onAccountChange(new PublicKey(st.reserveX), (info: { data: Buffer }) =>
        onReserve(poolAddr, "x", info.data)
      );
    }
    if (st.reserveY) {
      st.subRY = await conn.onAccountChange(new PublicKey(st.reserveY), (info: { data: Buffer }) =>
        onReserve(poolAddr, "y", info.data)
      );
    }
    states.set(poolAddr, st);
    log(`abonné ${poolAddr.slice(0, 8)}… (pair=${st.subPair} rx=${st.subRX} ry=${st.subRY}, dec ${st.decX}/${st.decY})`);
  } catch (e) {
    log(`abonnement ${poolAddr.slice(0, 8)}… échoué: ${String(e).slice(0, 120)}`);
  }
}

async function unsubscribePool(poolAddr: string): Promise<void> {
  const st = states.get(poolAddr);
  if (!st) return;
  for (const sub of [st.subPair, st.subRX, st.subRY]) {
    if (sub !== null) {
      try {
        await conn.removeAccountChangeListener(sub);
      } catch {
        /* déjà fermé */
      }
    }
  }
  states.delete(poolAddr);
}

async function refreshPositions(): Promise<void> {
  const open = db
    .prepare(`SELECT pool_address FROM real_positions WHERE status = 'open'`)
    .all() as { pool_address: string }[];
  const want = new Set(open.map((r) => r.pool_address));
  for (const addr of want) if (!states.has(addr)) await subscribePool(addr);
  for (const addr of [...states.keys()]) if (!want.has(addr)) await unsubscribePool(addr);
  db.prepare(`DELETE FROM pool_events_rt WHERE ts < ?`).run(Date.now() - RETENTION_MS);
  log(`${states.size} pool(s) suivie(s)`);
}

function summary(): void {
  const now = Date.now();
  for (const [addr, st] of states) {
    const idleS = ((now - st.lastEventTs) / 1000).toFixed(0);
    log(
      `${addr.slice(0, 8)}… events=${st.events} | ΔX=${st.deltaX.toFixed(4)} | ΔY=${st.deltaY.toFixed(4)} | bin=${st.lastBin ?? "?"} | inactif ${idleS}s`
    );
    st.events = 0;
    st.deltaX = 0;
    st.deltaY = 0;
  }
  if (states.size === 0) log("aucune pool suivie");
}

async function connect(): Promise<void> {
  if (conn) {
    try {
      conn.disconnect();
    } catch {
      /* */
    }
  }
  conn = new Connection(config.rpcUrl, { commitment: "confirmed", wsEndpoint: wsUrl() });
  // web3.js 1.x : les events ws vivent sur _rpcWebSocket (privé)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ws = (conn as any)._rpcWebSocket;
  if (ws) {
    ws.on("error", (e: Error) => log(`ws erreur: ${String(e).slice(0, 120)}`));
    ws.on("close", () => {
      log("ws déconnecté");
      if (!stopped && !reconnecting) void reconnectLoop();
    });
  }
  log("connecté");
}

let backoff = 1000;
async function reconnectLoop(): Promise<void> {
  reconnecting = true;
  while (!stopped) {
    try {
      await connect();
      await refreshPositions();
      backoff = 1000;
      reconnecting = false;
      return;
    } catch (e) {
      log(`reconnexion dans ${backoff}ms: ${String(e).slice(0, 100)}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

async function main(): Promise<void> {
  process.on("SIGINT", () => {
    stopped = true;
    log("arrêt (SIGINT)");
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    stopped = true;
    log("arrêt (SIGTERM)");
    process.exit(0);
  });
  await connect();
  await refreshPositions();
  setInterval(() => {
    if (!stopped) void refreshPositions();
  }, REFRESH_POSITIONS_MS);
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(summary, 60_000);
  log("ws-pool-monitor démarré");
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
