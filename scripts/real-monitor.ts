// Surveillance des positions RÉELLES (V2, 2026-08-22) : mark-to-market on-chain
// (SDK getPositionsByUserAndLbPair + Data API) + signaux d'exit miroir du paper
// (recovery-exit, hard-stop, flip-candidate, claim) → ALERTE Telegram.
// EXÉCUTION HUMAINE : en pilote, jamais auto — le message porte le kill-switch.
// Usage : npm run real:monitor (cron */15 via dlmm-run.sh)
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { coolingOffState } from "../src/volume.js";
import { getTelegramCreds, sendTelegram } from "../src/telegram.js";
import { getSolPriceUsd } from "../src/export.js";
import { realClosePosition } from "../src/real.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Keypair, Connection, PublicKey } = require("@solana/web3.js") as Record<string, any>;
const { create: createPool } = require("@meteora-ag/dlmm") as Record<string, any>;

const DATA_API = "https://dlmm.datapi.meteora.ag";
const ALERT_COOLDOWN_MS = 12 * 3_600_000; // 1 alerte max / type / position / 12 h
const CLAIM_COOLDOWN_MS = 24 * 3_600_000;

db.exec(`CREATE TABLE IF NOT EXISTS real_marks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  taken_at INTEGER NOT NULL,
  position_id INTEGER NOT NULL,
  price REAL,
  value_usd REAL,
  fees_usd REAL,
  net_pnl_usd REAL,
  in_range INTEGER
)`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_real_marks_pos ON real_marks(position_id, id)`);

const binPrice = (binId: number, step: number): number => Math.pow(1 + step / 10000, binId);
const ts = (): string => new Date().toISOString().slice(11, 16);

function lastAlertAt(positionId: number, type: string): number {
  const row = db
    .prepare(`SELECT MAX(created_at) AS at FROM events WHERE type = ? AND position_id = ?`)
    .get(type, positionId) as { at: number | null } | undefined;
  return row?.at ?? 0;
}

function logEvent(type: string, message: string, positionId: number, poolAddress: string): void {
  db.prepare(
    `INSERT INTO events (created_at, position_id, pool_address, type, message) VALUES (?, ?, ?, ?, ?)`
  ).run(Date.now(), positionId, poolAddress, type, message);
}

// Exécute le kill-switch (removeLiquidity 100 % + claim + close) quand un exit
// DÉFINI se déclenche (REAL_EXIT_AUTO=true — validé David 22/08). Gardes :
// valeurs plausibles avant d'agir, sig non vide avant de marquer closed,
// cooldown 1 h sur les échecs (retentera au tick suivant, sans spam).
// Retourne le message Telegram (confirm ou échec), ou null si silence.
async function autoClose(
  pos: Record<string, any>,
  reason: string,
  detail: string,
  netPnlUsd: number,
  valueUsd: number,
  creds: { token: string; chatId: string } | null
): Promise<string | null> {
  const id = Number(pos.id);
  const deposit = Number(pos.deposit_usd) || 0;
  const manualCmd = `REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE npm run real:close -- --pubkey ${pos.position_pubkey} --pool ${pos.pool_address} --bps 10000`;
  if (Date.now() - lastAlertAt(id, "real-auto-close-fail") < 3_600_000) {
    return null; // échec récent — silencieux 1 h, retentera au prochain tick
  }
  const sane =
    Number.isFinite(netPnlUsd) &&
    Number.isFinite(valueUsd) &&
    Math.abs(netPnlUsd) < deposit * 5 &&
    valueUsd > deposit * 0.1 &&
    valueUsd < deposit * 10;
  if (!sane) {
    const m = `🚨 [${ts()}] DLMM RÉEL ${pos.name} : auto-close ${reason} DÉSARMÉ — valeurs anormales (pnl ${netPnlUsd.toFixed(1)}$, value ${valueUsd.toFixed(1)}$) — fermer manuellement : ${manualCmd}`;
    logEvent("real-auto-close-fail", m, id, String(pos.pool_address));
    return m;
  }
  try {
    const sig = await realClosePosition(String(pos.pool_address), String(pos.position_pubkey), 10000);
    if (!sig) throw new Error("sig vide — on-chain inchangé, base NON marquée closed");
    db.prepare(
      `UPDATE real_positions SET status='closed', closed_at=?, close_reason=?, sig=? WHERE id=?`
    ).run(Date.now(), reason, sig, id);
    const m = `✅ [${ts()}] DLMM RÉEL AUTO-CLOSE ${pos.name} : ${reason} — ${detail} — sig ${sig.slice(0, 16)}… — fonds retournés au wallet`;
    logEvent("real-auto-close", m, id, String(pos.pool_address));
    return m;
  } catch (e) {
    const m = `🚨 [${ts()}] DLMM RÉEL ${pos.name} : AUTO-CLOSE ${reason} ÉCHOUÉ — ${String(e).slice(0, 140)} — fermer manuellement : ${manualCmd}`;
    logEvent("real-auto-close-fail", m, id, String(pos.pool_address));
    return m;
  }
}

export async function realMonitor(): Promise<number> {
  const creds = getTelegramCreds();
  const solUsd = (await getSolPriceUsd()) ?? 93;
  const rows = db.prepare(`SELECT * FROM real_positions WHERE status = 'open'`).all() as Record<string, any>[];
  if (rows.length === 0) {
    console.log("[real-monitor] aucune position réelle ouverte");
    return 0;
  }
  const user = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(config.walletPrivateKey, "base64")));
  const connection = new Connection(config.rpcUrl, "confirmed");
  let alerts = 0;

  for (const pos of rows) {
    // Prix courant — échelle Data API (identique à entry_price stocké)
    const poolRes = await fetch(`${DATA_API}/pools/${pos.pool_address}`, {
      signal: AbortSignal.timeout(15_000),
    }).catch(() => null);
    if (!poolRes || !poolRes.ok) {
      console.warn(`[real-monitor] Data API KO pour ${pos.name} — skip`);
      continue;
    }
    const pool = (await poolRes.json()) as Record<string, any>;
    const price = Number(pool.current_price);
    if (!price) continue;

    // Position on-chain (montants + fees claimables) — avec retry (1) et
    // double vérification : une erreur RÉSEAU n'est PAS une position disparue.
    let pd: Record<string, any> | null = null;
    let readError = "";
    let notFound = false;
    for (let attempt = 1; attempt <= 2 && !readError; attempt++) {
      try {
        const dlmm = await createPool(connection, new PublicKey(pos.pool_address), { cluster: config.cluster });
        const res = await dlmm.getPositionsByUserAndLbPair(user.publicKey);
        const found = res.userPositions.find(
          (p: any) => p.publicKey.toBase58() === pos.position_pubkey
        );
        if (found) {
          pd = found.positionData;
          break;
        }
        notFound = true;
        break;
      } catch (e) {
        readError = String(e);
        if (attempt === 1) await new Promise((r) => setTimeout(r, 2000));
      }
    }
    if (readError) {
      console.warn(`[real-monitor] lecture SDK ${pos.name} (transitoire, retentera) : ${readError.slice(0, 120)}`);
      continue;
    }
    if (notFound) {
      // Vérification indépendante AVANT d'alerter : le compte existe-t-il ?
      const acc = await connection
        .getAccountInfo(new PublicKey(pos.position_pubkey))
        .catch(() => null);
      if (acc) {
        console.warn(`[real-monitor] ${pos.name} : absent du filtre SDK mais compte présent on-chain — faux positif RPC, skip`);
        continue;
      }
      if (Date.now() - lastAlertAt(pos.id, "real-missing") > ALERT_COOLDOWN_MS) {
        const msg = `⚠️ [${ts()}] DLMM RÉEL ${pos.name} : position ${pos.position_pubkey} CONFIRMÉE absente on-chain (getAccountInfo) — fermée ? DB marquée open, vérifier`;
        logEvent("real-missing", msg, pos.id, pos.pool_address);
        if (creds) await sendTelegram(creds.token, creds.chatId, msg);
        alerts++;
      }
      continue;
    }
    if (!pd) continue; // non atteignable (readError/notFound continuent) — satisfait le narrowing TS

    const decX = Number(pool.token_x?.decimals ?? 6);
    const decY = Number(pool.token_y?.decimals ?? 9);
    const amountX = Number(pd.totalXAmount ?? 0) / 10 ** decX; // bruts → unités
    const amountY = Number(pd.totalYAmount ?? 0) / 10 ** decY;
    const feeX = Number(pd.feeX ?? 0) / 10 ** decX;
    const feeY = Number(pd.feeY ?? 0) / 10 ** decY;
    const valueSol = amountX * price + amountY;
    const feesSol = feeX * price + feeY;
    // Référence honnête : le SOL réellement déployé à l'ouverture (amount_y).
    // Le deposit_usd stocké (sizing satsmonkes) est dimensionné sur l'estimateur
    // yUsd du pool (≈87-90) alors que le prix SOL réel est ~93 → écart ~6%.
    const refSol = Number(pos.amount_y) || 0;
    const netPnlSol = valueSol + feesSol - refSol;
    const valueUsd = valueSol * solUsd;
    const feesUsd = feesSol * solUsd;
    const netPnlUsd = netPnlSol * solUsd;
    const inRange =
      price >= binPrice(pos.min_bin_id, pos.bin_step) && price <= binPrice(pos.max_bin_id, pos.bin_step);

    const lastMark = db
      .prepare(`SELECT net_pnl_usd FROM real_marks WHERE position_id = ? ORDER BY id DESC LIMIT 1`)
      .get(pos.id) as { net_pnl_usd: number } | undefined;
    const prevUnderwater = lastMark ? lastMark.net_pnl_usd < 0 : false;

    db.prepare(`UPDATE real_positions SET last_value_usd = ?, last_mark_at = ? WHERE id = ?`).run(
      valueUsd,
      Date.now(),
      pos.id
    );
    db.prepare(
      `INSERT INTO real_marks (taken_at, position_id, price, value_usd, fees_usd, net_pnl_usd, in_range)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(Date.now(), pos.id, price, valueUsd, feesUsd, netPnlUsd, inRange ? 1 : 0);
    console.log(
      `[real-monitor] ${pos.name} : price=${price.toPrecision(4)} value=${valueUsd.toFixed(0)}$ ` +
        `fees=${feesUsd.toFixed(2)}$ pnl=${netPnlUsd.toFixed(1)}$ ${inRange ? "in-range" : "OOR"}`
    );

    const isDip = pos.strategy === "bidask-dip";
    const isFlip = pos.strategy === "bidask-flip";
    const isDipLike = isDip || isFlip;
    const killCmd = `REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE npm run real:close -- --pubkey ${pos.position_pubkey} --pool ${pos.pool_address} --bps 10000`;

    // 1) Hard-stop (miroir paper) : dip → échelle = stop, seuil élargi 0.85 ;
    //    flip/topblast → 0.4. Référence = entry_price (pas de day_start réel pour l'instant).
    const refPrice = pos.entry_price;
    const dayDrop = refPrice ? (refPrice - price) / refPrice : 0;
    const stopThreshold = isDip ? 0.85 : config.hardStopDailyDrop;
    if (dayDrop > stopThreshold) {
      if (config.realExitAuto) {
        const m = await autoClose(
          pos,
          "hard-stop",
          `chute ${(dayDrop * 100).toFixed(1)}% depuis l'entrée (prix ${price.toPrecision(4)})`,
          netPnlUsd,
          valueUsd,
          creds
        );
        if (m && creds) await sendTelegram(creds.token, creds.chatId, m);
        alerts++;
      } else if (Date.now() - lastAlertAt(pos.id, "real-hard-stop") > ALERT_COOLDOWN_MS) {
        const msg = `🚨 [${ts()}] DLMM RÉEL ${pos.name} : HARD-STOP — chute ${(dayDrop * 100).toFixed(1)}% depuis l'entrée (prix ${price.toPrecision(4)}) — fermer : ${killCmd}`;
        logEvent("real-hard-stop", msg, pos.id, pos.pool_address);
        if (creds) await sendTelegram(creds.token, creds.chatId, msg);
        alerts++;
      }
      continue;
    }

    // 2) Recovery-exit (dip/flip — playbook Djedje20x) : PnL net ≥ 0 au rebond,
    //    fees incluses, condition « était sous l'eau au mark précédent ».
    if (isDipLike && prevUnderwater && netPnlSol >= 0) {
      if (config.realExitAuto) {
        const m = await autoClose(
          pos,
          "recovery-exit",
          `PnL net ${netPnlUsd.toFixed(1)}$ au rebond (fees ${feesUsd.toFixed(2)}$)`,
          netPnlUsd,
          valueUsd,
          creds
        );
        if (m && creds) await sendTelegram(creds.token, creds.chatId, m);
        alerts++;
        continue; // fermée (ou échec traité) — rien d'autre ce tick
      }
      if (Date.now() - lastAlertAt(pos.id, "real-recovery-exit") > ALERT_COOLDOWN_MS) {
        const msg = `🟢 [${ts()}] DLMM RÉEL ${pos.name} : RECOVERY-EXIT — PnL net ≥ 0 au rebond (${netPnlUsd.toFixed(1)}$ dont fees ${feesUsd.toFixed(2)}$) — fermer en gain ? ${killCmd}`;
        logEvent("real-recovery-exit", msg, pos.id, pos.pool_address);
        if (creds) await sendTelegram(creds.token, creds.chatId, msg);
        alerts++;
      }
    }

    // 3) Flip-candidat (satsmonkes setup 4 — dip uniquement) : higher low sur la
    //    moitié récente des marks + prix au-dessus du low. RÉEL = décision humaine.
    if (isDip && config.satsFlipSignalEnabled && inRange) {
      const since = Date.now() - config.satsFlipCooldownHours * 3_600_000;
      const already = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM events WHERE type IN ('real-flip-candidate', 'real-flip') AND position_id = ? AND created_at > ?`
          )
          .get(pos.id, since) as { n: number }
      ).n;
      const marks = db
        .prepare(`SELECT price FROM real_marks WHERE position_id = ? ORDER BY id DESC LIMIT ?`)
        .all(pos.id, config.satsFlipLookback) as { price: number }[];
      if (already === 0 && marks.length >= config.satsFlipLookback) {
        const prices = marks.map((m) => m.price).reverse();
        const half = Math.floor(prices.length / 2);
        const minPrior = Math.min(...prices.slice(0, half));
        const minRecent = Math.min(...prices.slice(half));
        const tokenShare = valueSol > 0 ? (amountX * price) / valueSol : 0;
        if (minRecent > minPrior && price > minRecent) {
          // INFORMATIF (tri alertes 22/08) : log only — décision humaine
          // possible via le dashboard, pas de Telegram.
          logEvent(
            "real-flip-candidate",
            `↕ ${pos.name} : higher low (min ${minRecent.toPrecision(4)} > ${minPrior.toPrecision(4)} sur ${prices.length} marks), prix ${price.toPrecision(4)} — bag token ${(tokenShare * 100).toFixed(0)}% (≥ ${(config.satsFlipMinTokenShare * 100).toFixed(0)}% requis) — décision humaine ${killCmd}`,
            pos.id,
            pos.pool_address
          );
        }
      }
    }

    // 4) Claim : fees claimables on-chain au-dessus du seuil → INFORMATIF
    //    (tri alertes 22/08) : log only — le claim est inclus dans le close.
    if (feesUsd >= config.minClaimUsd) {
      if (Date.now() - lastAlertAt(pos.id, "real-claim-alert") > CLAIM_COOLDOWN_MS) {
        logEvent(
          "real-claim-alert",
          `💰 ${pos.name} : ${feesUsd.toFixed(2)}$ de fees claimables on-chain (seuil ${config.minClaimUsd}$) — claim manuel (real:claim à brancher) ou inclus dans le close`,
          pos.id,
          pos.pool_address
        );
      }
    }

    // 5) Position en attente : hors range depuis trop longtemps = aucun fee —
    //    décision « laisser dormir ou fermer pour redéployer » (le pilote ne
    //    doit pas moisir sans travailler). Cooldown 12 h.
    if (!inRange) {
      const oorSince = (
        db
          .prepare(
            `SELECT taken_at FROM real_marks WHERE position_id = ? AND in_range = 1 ORDER BY id DESC LIMIT 1`
          )
          .get(pos.id) as { taken_at: number } | undefined
      )?.taken_at ?? pos.opened_at;
      const oorHours = (Date.now() - oorSince) / 3_600_000;
      if (oorHours > config.realOorAlertHours) {
        if (Date.now() - lastAlertAt(pos.id, "real-oor") > ALERT_COOLDOWN_MS) {
          // INFORMATIF (tri alertes 22/08) : log only — le dashboard suit,
          // pas de Telegram pour la position en attente.
          logEvent(
            "real-oor",
            `⏳ ${pos.name} : HORS RANGE depuis ${oorHours.toFixed(1)} h (0 fee, PnL ${netPnlUsd.toFixed(1)}$) — laisser dormir ou redéployer ? ${killCmd}`,
            pos.id,
            pos.pool_address
          );
        }
      }
    }

    // 6) Yield en déclin sur le pool de la position (playbook Lamsito) :
    //    feeDecay = 24 × ftr_1h / ftr_24h < 0.6 → « le yield s'essouffle » →
    //    candidat à la sortie anticipée. Même seuil que le badge du scan.
    const ftr24h = Number(pool.fee_tvl_ratio?.["24h"] ?? 0);
    const ftr1h = Number(pool.fee_tvl_ratio?.["1h"] ?? 0);
    if (ftr24h >= 0.05 && ftr1h > 0) {
      const feeDecay = (24 * ftr1h) / ftr24h;
      if (feeDecay < 0.6) {
        if (Date.now() - lastAlertAt(pos.id, "real-fee-decline") > ALERT_COOLDOWN_MS) {
          // INFORMATIF (tri alertes 22/08) : log only — le yield s'essouffle
          // est visible sur le dashboard ; pas de Telegram.
          logEvent(
            "real-fee-decline",
            `⚠️ ${pos.name} : fees EN DÉCLIN (1h = ${(feeDecay * 100).toFixed(0)} % du rythme 24h, ftr24 ${ftr24h.toFixed(2)} %) — le yield s'essouffle, sortie anticipée ? ${killCmd}`,
            pos.id,
            pos.pool_address
          );
        }
      }
    }

    // 7) Momentum refroidi (RocketScan, 2026-08-23) : miroir de l'exit paper
    //    « cooling off » (déclin du delta de volume : intervalle courant <
    //    COOLING_RATIO × pic des 30 dernières minutes) — topblast et
    //    bidask-dip. RÉEL = INFORMATIF (tri alertes 22/08) : log only, jamais
    //    auto sans validation David — décision humaine via le dashboard.
    if ((pos.strategy === "topblast" || isDip) && config.coolingExitEnabled) {
      const cool = coolingOffState(String(pos.pool_address));
      if (cool && cool.ratio < config.coolingRatio) {
        if (Date.now() - lastAlertAt(pos.id, "real-cooling-off") > ALERT_COOLDOWN_MS) {
          logEvent(
            "real-cooling-off",
            `🌡️ ${pos.name} : momentum refroidi — intervalle courant ${(cool.current / 1000).toFixed(0)}k$/min = ${(cool.ratio * 100).toFixed(0)}% du pic ${(cool.peak / 1000).toFixed(0)}k$/min sur ${cool.windowMin.toFixed(0)}min — sortie anticipée ? ${killCmd}`,
            pos.id,
            pos.pool_address
          );
        }
      }
    }
  }
  return alerts;
}

const n = await realMonitor();
console.log(`[real-monitor] terminé — ${n} alerte(s)`);
