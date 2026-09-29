// Surveillance des positions RÉELLES (V2, 2026-08-22) : mark-to-market on-chain
// (SDK getPositionsByUserAndLbPair + Data API) + signaux d'exit miroir du paper
// (recovery-exit, hard-stop, flip-candidate, claim) → ALERTE Telegram.
// EXÉCUTION HUMAINE : en pilote, jamais auto — le message porte le kill-switch.
// Usage : npm run real:monitor (cron */15 via dlmm-run.sh)
import { db, blacklistToken, isBlacklistableToken } from "../src/db.js";
import { config } from "../src/config.js";
import { coolingOffState, inFeeSurge } from "../src/volume.js";
import { getTelegramCreds, sendTelegram } from "../src/telegram.js";
import { getSolPriceUsd } from "../src/export.js";
import { realClosePosition, realClaimRewards } from "../src/real.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { Keypair, Connection, PublicKey } = require("@solana/web3.js") as Record<string, any>;
const { getAllLbPairPositionsByUser } = require("@meteora-ag/dlmm") as Record<string, any>;

const DATA_API = "https://dlmm.datapi.meteora.ag";
const ALERT_COOLDOWN_MS = 12 * 3_600_000; // 1 alerte max / type / position / 12 h
const CLAIM_COOLDOWN_MS = 24 * 3_600_000;
// Retente 1×/h max en cas d'échec — sans ça, un claim qui échoue (bug ou
// réseau) spamme Telegram 🚨 à CHAQUE run 1 min (leçon 2026-08-26 : 240+
// alertes en ~4 h sur le bug transaction.sign). Le cooldown de succès
// (CLAIM_COOLDOWN_MS) ne couvrait que le type "real-claim", pas les échecs.
const CLAIM_FAIL_COOLDOWN_MS = 1 * 3_600_000;

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

// Tag profit/perte explicite (demande David 30/08) : chaque notification
// Telegram identifie clairement le sens du PnL net (valeur + fees − refSol).
// ⚠️ Fix affichage 24/09 (leçon GROK-SOL « PROFIT +6,5$ » alors que 490,6$
// rendus pour 500$ déposés = −9,4$ de capital) : les closes réelles affichent
// TOUJOURS le net cash réel (valeur rendue − dépôt), jamais netPnlUsd qui
// inclut des fees déjà comptées ailleurs. Le solde de fees est dit en détail.
function pnlTag(netPnlUsd: number): string {
  return netPnlUsd >= 0
    ? `💰 PROFIT +${netPnlUsd.toFixed(1)}$`
    : `🔻 PERTE -${Math.abs(netPnlUsd).toFixed(1)}$`;
}

// Cumul des fees RÉELLEMENT encaissées (wallet) par position, pour le tag de
// close honnête (fix 24/09) : Σ claims passées (type real-claim, $ parseés du
// message) + solde de fees du dernier mark (encore on-chain → claimé par la tx
// de close qui fait removeLiquidity + claim). ≈ feesSol au mark près.
const _claimCache = new Map<number, number>();
function claimedSoFarUsd(posId: number): number {
  const hit = _claimCache.get(posId);
  if (hit !== undefined) return hit;
  let past = 0;
  for (const r of db
    .prepare(`SELECT message, payload FROM events WHERE type='real-claim' AND position_id=?`)
    .all(posId) as { message: string; payload: string | null }[]) {
    let v: number | null = null;
    try {
      const p = r.payload ? JSON.parse(r.payload) : null;
      if (p && typeof p.claimedUsd === "number") v = p.claimedUsd;
    } catch { /* payload absent/corrompu → fallback regex */ }
    if (v === null) {
      const m = r.message.match(/([0-9]+\.[0-9]+)\$/);
      if (m) v = parseFloat(m[1]);
    }
    if (v !== null) past += v;
  }
  _claimCache.set(posId, past);
  return past;
}

function lastAlertAt(positionId: number, type: string): number {
  const row = db
    .prepare(`SELECT MAX(created_at) AS at FROM events WHERE type = ? AND position_id = ?`)
    .get(type, positionId) as { at: number | null } | undefined;
  return row?.at ?? 0;
}

function logEvent(
  type: string,
  message: string,
  positionId: number,
  poolAddress: string,
  payload?: unknown
): void {
  db.prepare(
    `INSERT INTO events (created_at, position_id, pool_address, type, message, payload) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(Date.now(), positionId, poolAddress, type, message, payload ? JSON.stringify(payload) : null);
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
  creds: { token: string; chatId: string } | null,
  feesUsd = 0
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
    const m = `🚨 [${ts()}] DLMM RÉEL ${pos.name} : auto-close ${reason} DÉSARMÉ — ${pnlTag(netPnlUsd)} — valeurs anormales (value ${valueUsd.toFixed(1)}$) — fermer manuellement : ${manualCmd}`;
    logEvent("real-auto-close-fail", m, id, String(pos.pool_address));
    return m;
  }
  try {
    const sig = await realClosePosition(String(pos.pool_address), String(pos.position_pubkey), 10000);
    if (!sig) throw new Error("sig vide — on-chain inchangé, base NON marquée closed");
    db.prepare(
      `UPDATE real_positions SET status='closed', closed_at=?, close_reason=?, sig=? WHERE id=?`
    ).run(Date.now(), reason, sig, id);
    // Cooldown de ré-ouverture (validé David 2026-08-24) : après TOUT close
    // réel, le token est interdit de ré-entrée TOKEN_REOPEN_COOLDOWN_HOURS —
    // indépendant du volume (la blacklist vol ne couvre pas les dumps en
    // cours ; le cron open:paper ré-ouvrirait le même token dans l'heure).
    // Le 48h vol ci-dessous écrase si déclenché (cas le plus strict gagne).
    const reopenKey = String(pos.token_x_symbol ?? pos.name ?? "?").toLowerCase();
    // Livre principale : garde anti-ré-entrée 14 j alignée sur le pilote
    // (simulation 2026-09-15 : -1 900 -> -845$ ; la garde 6 h ne filtrait rien,
    // médiane réelle des ré-entrées = 0,5 j). Les closes take-profit gardent
    // la fenêtre courte (on rejoue un gagnant, doctrine L4-B TP ≠ poison).
    const reopenHours = pos.pilot || reason === "take-profit"
      ? config.tokenReopenCooldownHours
      : config.pilotReentryCooldownDays * 24;
    if (isBlacklistableToken(reopenKey)) {
      blacklistToken(
        reopenKey,
        reopenHours,
        `cooldown ré-ouverture (${reopenHours}h) après close ${reason}`,
        String(pos.pool_address)
      );
    }
    // Blacklist post-close (playbook gud, 2026-08-24) : chart mort → pas de
    // ré-entrée (leçon omo : 6 ré-ouvertures sur le même token en 24h).
    if (config.postCloseBlacklistEnabled) {
      const scan = db
        .prepare(`SELECT volume_24h FROM pool_scans WHERE pool_address = ? ORDER BY scanned_at DESC LIMIT 1`)
        .get(String(pos.pool_address)) as { volume_24h: number | null } | undefined;
      if (scan?.volume_24h != null && scan.volume_24h < config.postCloseVolMin24h) {
        const tokenKey = String(pos.token_x_symbol ?? pos.name ?? "?").toLowerCase();
        // Quotes réservées exclues (revue 2026-08-24) — voir src/db.ts.
        if (isBlacklistableToken(tokenKey)) {
          blacklistToken(
            tokenKey,
            config.postCloseBlacklistHours,
            `real close ${reason} — vol 24h ${(scan.volume_24h / 1000).toFixed(0)}k$ < ${(config.postCloseVolMin24h / 1000).toFixed(0)}k$ (chart mort)`,
            String(pos.pool_address)
          );
        }
      }
    }
    // Bilan honnête (fix 24/09) : capital rendu vs déposé + TOTAL des fees
    // réellement encaissées sur la vie de la position (claims passés loggés +
    // solde on-chain du tick courant, claimé par la tx de close).
    const feesTotal = claimedSoFarUsd(id) + Math.max(0, feesUsd);
    const netCashUsd = valueUsd - deposit;
    const gainLine =
      netCashUsd >= 0
        ? `🟢 Capital gagné ${netCashUsd.toFixed(2).padStart(8)} $  (rendu ${valueUsd.toFixed(0)} / déposé ${deposit.toFixed(0)})`
        : `🔻 Capital perdu ${netCashUsd.toFixed(2).padStart(8)} $  (rendu ${valueUsd.toFixed(0)} / déposé ${deposit.toFixed(0)})`;
    const m = [
      `✅ [${ts()}] DLMM RÉEL AUTO-CLOSE ${pos.name} : ${reason} — ${detail}`,
      `📊 Bilan réel de la position`,
      gainLine,
      `💰 Fees encaissées ${feesTotal.toFixed(2).padStart(6)} $  (claims + solde clos)`,
      `🧮 Net total position ${(netCashUsd + feesTotal).toFixed(2).padStart(6)} $`,
      `sig ${sig.slice(0, 16)}… — fonds retournés au wallet`,
    ].join("\n");
    logEvent("real-auto-close", m, id, String(pos.pool_address));
    return m;
  } catch (e) {
    const m = `🚨 [${ts()}] DLMM RÉEL ${pos.name} : AUTO-CLOSE ${reason} ÉCHOUÉ — ${pnlTag(netPnlUsd)} — ${String(e).slice(0, 140)} — fermer manuellement : ${manualCmd}`;
    logEvent("real-auto-close-fail", m, id, String(pos.pool_address));
    return m;
  }
}

export async function realMonitor(): Promise<number> {
  const creds = getTelegramCreds();
  const solUsdLive = await getSolPriceUsd();
  if (!solUsdLive) console.warn("[real-monitor] ⚠️ prix SOL indisponible — fallback 120$ (marks potentiellement biaisés)");
  const solUsd = solUsdLive ?? 120;
  const rows = db.prepare(`SELECT * FROM real_positions WHERE status = 'open'`).all() as Record<string, any>[];
  if (rows.length === 0) {
    console.log("[real-monitor] aucune position réelle ouverte");
    return 0;
  }
  const user = Keypair.fromSecretKey(Uint8Array.from(Buffer.from(config.walletPrivateKey, "base64")));
  // Bascule anti-429 (29/09) : si le compteur du watchdog signale une saturation persistante
  // (marqueur fichier posé par dlmm-realwatchdog.sh), le run courant part directement sur le
  // fallback — sinon primaire. Le marqueur expire après 10 min pour revenir au primaire vite.
  const fsR = require("node:fs") as typeof import("node:fs");
  let useFallback = false;
  try {
    const st = fsR.statSync("/tmp/dlmm-rpc-saturated");
    useFallback = Date.now() - st.mtimeMs < 10 * 60_000 && !!config.rpcFallbackUrl;
  } catch { /* pas de marqueur → primaire */ }
  const connection = new Connection(useFallback ? config.rpcFallbackUrl : config.rpcUrl, "confirmed");
  if (useFallback) console.warn("[real-monitor] ⚠️ RPC primaire saturé (marqueur) — run sur FALLBACK");
  let alerts = 0;

  // ⚠️ LECTURE BATCHÉE (fix anti-429 2026-08-26) : getAllLbPairPositionsByUser
  // fait ~3-4 RPC pour TOUTES les positions (1 getProgramAccounts owner-wide +
  // 2 getMultipleAccounts : clock+binArrays+lbPairs puis réserves+mints) au
  // lieu de ~4 RPC PAR position (createPool + getPositionsByUserAndLbPair =
  // getActiveBin + getProgramAccounts + getMultipleAccounts) → ~32-40 RPC/run
  // à 8 positions, ce qui saturait le tier Helius (429, vérifié 26/08 : 58 521
  // credits RPC = 98,7 % du breakdown). Montants IDENTIQUES (validé 26/08 :
  // totalXAmount/totalYAmount/feeX/feeY égaux sur 8/8 positions).
  let positionsByKey = new Map<string, { positionData: any; lbPair: any }>();
  // ⚠️ 3 tentatives, backoff 5s×n (incident 02/09/2026 11:36-12:18 : Helius a
  // DEPRIORITISÉ getProgramAccounts — "Request deprioritized due to number of
  // accounts requested. Please use getProgramAccountsV2" — 500 en rafale pendant
  // ~40 min, surveillance aveugle malgré le cron 1 min. Les 2 tentatives à 2 s
  // encaissaient mal un incident transitoire plus long ; le tick suivant réessaie
  // de toute façon, mais un run qui tient 15 s de retry couvre mieux un micro-
  // pic provider. Format des lignes de log CONSERVÉ (le watchdog compte « KO »).
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const all = await getAllLbPairPositionsByUser(connection, user.publicKey, { cluster: config.cluster });
      for (const info of all.values()) {
        for (const p of info.lbPairPositionsData) {
          positionsByKey.set(p.publicKey.toBase58(), { positionData: p.positionData, lbPair: info.lbPair });
        }
      }
      break;
    } catch (e) {
      if (attempt < 3) {
        console.warn(`[real-monitor] lecture batchée (transitoire, retentera) : ${String(e).slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 5000 * attempt));
      } else {
        console.warn(`[real-monitor] lecture batchée KO — skip run : ${String(e).slice(0, 120)}`);
        return 0;
      }
    }
  }

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

    // Position on-chain : lookup dans le batch owner-wide (0 RPC). Gardes
    // conservées : une position absente du batch → vérification getAccountInfo
    // indépendante AVANT d'alerter (une erreur RÉSEAU n'est pas une disparition).
    const hit = positionsByKey.get(pos.position_pubkey);
    if (!hit) {
      const acc = await connection
        .getAccountInfo(new PublicKey(pos.position_pubkey))
        .catch(() => null);
      if (acc) {
        console.warn(`[real-monitor] ${pos.name} : absent du batch mais compte présent on-chain — faux positif RPC, skip`);
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
    const pd = hit.positionData;

    const decX = Number(pool.token_x?.decimals ?? 6);
    const decY = Number(pool.token_y?.decimals ?? 9);
    // ⚠️ Échelle du prix Data API (leçon wNEAR-USDC 29/09, faux « +35 k$ ») :
    // current_price est en SOL par token pour les pools X-SOL, mais en $ USDC
    // par token pour les pools X-USDC/USDT. L'agrégation valueSol ci-dessous
    // doit donc convertir côté X dans LA DEVISE DU POOL avant de passer en SOL.
    const ySymNow = String(pool.token_y?.symbol ?? "").toUpperCase();
    const yIsStablePool = ySymNow === "USDC" || ySymNow === "USDT";
    if (yIsStablePool && !(pos.token_y_symbol ?? "").toUpperCase().match(/USDC|USDT/)) {
      console.warn(`[real-monitor] ${pos.name}: pool stable détecté mais pos marquée ${pos.token_y_symbol} — échelle suspecte`);
    }
    const amountX = Number(pd.totalXAmount ?? 0) / 10 ** decX; // bruts → unités
    const amountY = Number(pd.totalYAmount ?? 0) / 10 ** decY;
    const feeX = Number(pd.feeX ?? 0) / 10 ** decX;
    const feeY = Number(pd.feeY ?? 0) / 10 ** decY;
    // valeur en $ UI du pool (prix déjà en $ si pool stable), puis conversion $→SOL
    const valueUsdRaw = yIsStablePool
      ? amountX * price + amountY
      : (amountX * price + amountY) * solUsd;
    const feesUsdRaw = yIsStablePool ? feeX * price + feeY : (feeX * price + feeY) * solUsd;
    const valueSol = valueUsdRaw / solUsd;
    const feesSol = feesUsdRaw / solUsd;
    // Référence honnête : le SOL réellement déployé à l'ouverture (amount_y).
    // Le deposit_usd stocké (sizing satsmonkes) est dimensionné sur l'estimateur
    // yUsd du pool (≈87-90) alors que le prix SOL réel est ~93 → écart ~6%.
    // ⚠️ Pilote L4-B (2026-08-29) : pour une position BALANCÉE, amount_y ne
    // couvre que le dépôt SOL — le token X est ACHETÉ (capital sorti du wallet)
    // → ref = invested_sol (achat + dépôt), sinon le PnL est FAUX (+75 $ sur la
    // phase 0 HYPE le 29/08). Les positions du book (invested_sol NULL) gardent
    // le comportement historique.
    const refSol = Number(pos.pilot ? pos.invested_sol : pos.amount_y) || 0;
    const netPnlSol = valueSol + feesSol - refSol;
    const valueUsd = valueSol * solUsd;
    const feesUsd = feesSol * solUsd;
    const netPnlUsd = netPnlSol * solUsd;
    // in_range : comparaison SUR LA MÊME ÉCHELLE (piège 2026-08-24, cc-SOL).
    // Le prix Data API (pool.current_price) est par-TOKEN ; binPrice() est sur
    // l'échelle par-LAMPORT (échelle des min/max_bin_id on-chain) → le mélange
    // marquait OOR des positions EN RANGE (cc-SOL marquée OOR depuis 11:25
    // alors qu'elle encaissait des fees — Meteora les affichait bien). Source
    // fiable : l'activeBin ON-CHAIN du SDK (même échelle que min/max_bin_id).
    // Fallback : conversion par les decimals (per-lamport = per-token ×
    // 10^(decY−decX)) si getActiveBin échoue.
    let inRange = false;
    // Source 1 (PRIMAIRE) : bin temps réel du ws-pool-monitor — validé
    // 2026-08-25 : accord 100% avec le SDK sur 165 marks (9 positions),
    // 0 appel RPC, fraîcheur <1s contre 60s pour le getActiveBin.
    const wsBin = db
      .prepare(
        `SELECT active_bin_id FROM pool_events_rt
         WHERE pool_address = ? AND ts > ? AND active_bin_id IS NOT NULL
         ORDER BY ts DESC LIMIT 1`
      )
      .get(pos.pool_address, Date.now() - 300_000) as { active_bin_id: number } | undefined;
    if (wsBin && typeof wsBin.active_bin_id === "number") {
      inRange = wsBin.active_bin_id >= pos.min_bin_id && wsBin.active_bin_id <= pos.max_bin_id;
    } else {
      // Source 2 : activeId ON-CHAIN du lbPair du batch (même échelle que
      // min/max_bin_id, 0 RPC — le batch l'a déjà fetché). Validé 26/08 :
      // cohérent avec le wsBin sur 8 pools.
      const activeBin = hit.lbPair?.activeId as number | undefined;
      if (typeof activeBin === "number") {
        inRange = activeBin >= pos.min_bin_id && activeBin <= pos.max_bin_id;
      } else {
        // Source 3 : conversion par les decimals (per-lamport = per-token ×
        // 10^(decY−decX)) — dernier recours, 0 RPC.
        const priceLamport = price * 10 ** (decY - decX);
        inRange =
          priceLamport >= binPrice(pos.min_bin_id, pos.bin_step) && priceLamport <= binPrice(pos.max_bin_id, pos.bin_step);
      }
    }

    const lastMark = db
      .prepare(`SELECT net_pnl_usd FROM real_marks WHERE position_id = ? ORDER BY id DESC LIMIT 1`)
      .get(pos.id) as { net_pnl_usd: number } | undefined;
    // « Sous l'eau » = perte RÉELLE au mark précédent (deadband RECOVERY_EPS_USD
    // — correction 2026-08-23 : une position flat oscillant autour de 0 $ par
    // poussière de rounding déclenchait recovery-exit à PnL 0.0$).
    const prevUnderwater = lastMark ? lastMark.net_pnl_usd < -config.recoveryEpsUsd : false;

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
    // Garde « surtension » (gud, revue 2026-08-24) : tenir uniquement si la
    // position est IN RANGE (les fees s'accumulent) — OOR = 0 fee, rien à
    // protéger (piège omo #7/#8 : recovery à breakeven après passage en token).
    const surgeHold = isDip && inFeeSurge(pool) && inRange;
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
          creds,
          feesUsd
        );
        if (m && creds) await sendTelegram(creds.token, creds.chatId, m);
        alerts++;
      } else if (Date.now() - lastAlertAt(pos.id, "real-hard-stop") > ALERT_COOLDOWN_MS) {
        const msg = `🚨 [${ts()}] DLMM RÉEL ${pos.name} : HARD-STOP — ${pnlTag(netPnlUsd)} — chute ${(dayDrop * 100).toFixed(1)}% depuis l'entrée (prix ${price.toPrecision(4)}) — fermer : ${killCmd}`;
        logEvent("real-hard-stop", msg, pos.id, pos.pool_address);
        if (creds) await sendTelegram(creds.token, creds.chatId, msg);
        alerts++;
      }
      continue;
    }

    // 1.5) Value stop-loss (garde-fou CYBERLEEK/GTA6, 2026-08-27 ; révisé
    //      NET le 29/08) : le hard-stop prix ne coupe que la mort du token ;
    //      une échelle bidask-dip qui traverse son range perd −30/−50 % SANS
    //      qu'aucune règle ne tire (in-range = pas d'OOR, PnL < 0 = pas de
    //      recovery). Stop sur la PERTE NETTE (valeur + fees − refSol) : un
    //      fee-harvester in-range dont les fees compensent l'IL n'est PAS
    //      coupé (doctrine fees +++ ; leçon 29/08 CYBERLEEK coupé à −5,6 %
    //      de VALEUR alors qu'in-range). Seuil net 0.10 : coupe les death
    //      spirals (cc −12 %, Pistacio −11 %, Morty −13 % net), épargne les
    //      fee-harvesters (CYBERLEEK −3,8 %, GTA6 −2,8 % net). AUTO via le
    //      même kill-switch ; cooldown d'échec 1 h dans autoClose.
    const netLossRatio = refSol > 0 ? -netPnlSol / refSol : 0;
    // Book memes : seuil VALUE_STOP_LOSS (0.07 depuis sweep 28/09). Pilote
    // L4-B : PILOT_VALUE_STOP_LOSS (0.10 — isolé pour le verdict ANTHROPIC
    // du 26/10, cf. config.ts).
    const vsThreshold = pos.pilot ? config.pilotValueStopLoss : config.valueStopLoss;
    if (netLossRatio > vsThreshold) {
      if (config.realExitAuto) {
        const m = await autoClose(
          pos,
          "value-stop",
          `perte nette ${(netLossRatio * 100).toFixed(1)}% (fees ${feesUsd.toFixed(2)}$)`,
          netPnlUsd,
          valueUsd,
          creds,
          feesUsd
        );
        if (m && creds) await sendTelegram(creds.token, creds.chatId, m);
        alerts++;
      } else if (Date.now() - lastAlertAt(pos.id, "real-value-stop") > ALERT_COOLDOWN_MS) {
        const msg = `🚨 [${ts()}] DLMM RÉEL ${pos.name} : VALUE-STOP — ${pnlTag(netPnlUsd)} — perte nette ${(netLossRatio * 100).toFixed(1)}% — fermer : ${killCmd}`;
        logEvent("real-value-stop", msg, pos.id, pos.pool_address);
        if (creds) await sendTelegram(creds.token, creds.chatId, msg);
        alerts++;
      }
      continue;
    }

    // 2) Recovery-exit (dip/flip — playbook Djedje20x) : PnL net ≥ 0 au rebond,
    //    fees incluses, condition « était sous l'eau au mark précédent ».
    // Garde « surtension » (gud, 2026-08-24) : pas de recovery-exit pendant
    // que le dynamic fee imprime (fenêtre où les fees paient l'IL). Limitée
    // au bidask-dip — le flip distribue, le Bollinger reste son exit.
    if (isDipLike && prevUnderwater && netPnlSol >= 0 && !surgeHold) {
      if (config.realExitAuto) {
        const m = await autoClose(
          pos,
          "recovery-exit",
          `au rebond (fees ${feesUsd.toFixed(2)}$)`,
          netPnlUsd,
          valueUsd,
          creds,
          feesUsd
        );
        if (m && creds) await sendTelegram(creds.token, creds.chatId, m);
        alerts++;
        continue; // fermée (ou échec traité) — rien d'autre ce tick
      }
      if (Date.now() - lastAlertAt(pos.id, "real-recovery-exit") > ALERT_COOLDOWN_MS) {
        const msg = `🟢 [${ts()}] DLMM RÉEL ${pos.name} : RECOVERY-EXIT — ${pnlTag(netPnlUsd)} — au rebond, dont fees ${feesUsd.toFixed(2)}$ — fermer en gain ? ${killCmd}`;
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

    // 4) Claim AUTO des fees on-chain (mandat autonomie 2026-08-24) : au-dessus
    //    du seuil MIN_CLAIM_USD, on réclame (realClaimRewards — claim seul, ne
    //    ferme pas la position). Les fees sont le rendement des positions
    //    ouvertes ; les laisser on-chain ne rapporte rien. ✅/🚨 Telegram
    //    (mandataire : le système bouge de l'argent — même classe que le sweep).
    //    Cooldown 24 h (CLAIM_COOLDOWN_MS).
    if (feesUsd >= config.minClaimUsd && config.claimAutoEnabled) {
      // Cooldowns séparés succès (24 h) / échec (1 h) — un échec ne doit pas
      // être retenté à chaque run (spam Telegram 🚨, leçon 2026-08-26).
      const lastOk = lastAlertAt(pos.id, "real-claim");
      const lastFail = lastAlertAt(pos.id, "real-claim-fail");
      if (Date.now() - lastOk > CLAIM_COOLDOWN_MS && Date.now() - lastFail > CLAIM_FAIL_COOLDOWN_MS) {
        try {
          const sig = await realClaimRewards(String(pos.pool_address), String(pos.position_pubkey));
          if (!sig) throw new Error("sig vide — rien claimé");
          const m = `💰 [${ts()}] DLMM RÉEL ${pos.name} : claim AUTO ${feesUsd.toFixed(2)}$ de fees → wallet (sig ${sig.slice(0, 12)}…)`;
          // payload machine-lisible (récap « Gains nets du jour », 24/09) +
          // invalidation du cache claimsSoFarUsd pour cette position.
          _claimCache.delete(Number(pos.id));
          logEvent("real-claim", m, pos.id, pos.pool_address, {
            payload: { claimedUsd: Number(feesUsd.toFixed(2)) },
          });
          if (creds) await sendTelegram(creds.token, creds.chatId, m);
          alerts++;
        } catch (e) {
          const m = `🚨 [${ts()}] DLMM RÉEL ${pos.name} : claim AUTO ÉCHOUÉ (${String(e).slice(0, 120)}) — fees ${feesUsd.toFixed(2)}$ toujours on-chain, retentera`;
          logEvent("real-claim-fail", m, pos.id, pos.pool_address);
          if (creds) await sendTelegram(creds.token, creds.chatId, m);
          alerts++;
        }
      }
    }

    // 5) Position hors range : 0 fee = capital mort — décision AUTO (mandat
    //    autonomie 2026-08-24). net ≥ 0 → close + réallocation dès le seuil
    //    d'alerte (REAL_OOR_ALERT_HOURS, le capital doit retravailler —
    //    leçon BUTTHOLE 25 h OOR) ; sous l'eau → on attend
    //    REAL_OOR_FORCE_CLOSE_HOURS avant de libérer (pas de verrouillage de
    //    perte précipité, mais pas de position qui moisit — le sweep + le cron
    //    open:paper réallouent ≤ 1 h). Sans REAL_EXIT_AUTO : alerte info.
    if (!inRange && !pos.pilot) {
      // ⚠️ Pilote L4-B exclu de l'OOR auto (spec 29/08) : une position
      // BALANCÉE hors range détient le token (pas un capital mort au même
      // sens que l'échelle Y-only) — alerte seule + décision humaine ; le
      // value-stop/hard-stop/recovery restent actifs (filet de perte).
      const oorSince = (
        db
          .prepare(
            `SELECT taken_at FROM real_marks WHERE position_id = ? AND in_range = 1 ORDER BY id DESC LIMIT 1`
          )
          .get(pos.id) as { taken_at: number } | undefined
      )?.taken_at ?? pos.opened_at;
      const oorHours = (Date.now() - oorSince) / 3_600_000;
      const netOk = netPnlSol >= 0;
      const force = oorHours > config.realOorForceCloseHours;
      // ⚠️ FIX 03/09 (après coup) : le force-close sous l'eau (grace 1 h, levier
      // « renverser la balance ») NE DOIT PAS être masqué par la porte d'alerte
      // redeploy (6 h) — avant ce fix, passer force<alert ne servait à rien : le
      // bloc ne s'exécutait jamais avant 6 h (leçon CTO : −15$ → −110$ en 3 marks).
      if (oorHours > config.realOorAlertHours || (force && !netOk)) {
        if (config.realExitAuto && (netOk || force)) {
          const m = await autoClose(
            pos,
            netOk ? "oor-redeploy" : "oor-force",
            `hors range ${oorHours.toFixed(1)} h (0 fee) → ${netOk ? "redéploiement" : "libération du capital (grace 1 h écoulée)"}`,
            netPnlUsd,
            valueUsd,
            creds,
            feesUsd
          );
          if (m && creds) await sendTelegram(creds.token, creds.chatId, m);
          alerts++;
          continue; // fermée (ou échec traité) — rien d'autre ce tick
        }
        if (Date.now() - lastAlertAt(pos.id, "real-oor") > ALERT_COOLDOWN_MS) {
          // INFORMATIF (tri alertes 22/08) : log only — le dashboard suit,
          // pas de Telegram pour la position en attente.
          logEvent(
            "real-oor",
            `⏳ ${pos.name} : HORS RANGE depuis ${oorHours.toFixed(1)} h (0 fee, ${pnlTag(netPnlUsd)}) — ${config.realExitAuto ? (netOk ? "close auto au prochain tick (redéploiement)" : `sous l'eau — force-close auto à ${config.realOorForceCloseHours} h`) : `laisser dormir ou redéployer ? ${killCmd}`}`,
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

    // 6.5) TAKE-PROFIT MANCHE TENDANCE (L4-B étendue v2, 2026-09-14). Réservé
    //      aux positions pilote (pilot=1) : le book memes sort par
    //      recovery-exit/cooling-off (doctrine fees +++), jamais par un plafond
    //      de gain.
    //      Contre-factuel mark à mark des 11 closes du pilote : 6 gagnantes
    //      refermées à +13/+22$ via cooling-off, dont 2 avaient dépassé +20$
    //      AVANT de rendre la mise (HYPE 2 : +22,9 → −18,8 ; CATE : +32,2 →
    //      +13,8). Réel +1,9$ → TP +20$ : +120,3$. Plateau +25/+30$ :
    //      +137,9$/+142,3$ → seuil conservateur +20$ (les closes réelles se
    //      groupent à +13/+22$), ajustable par PILOT_TAKE_PROFIT_USD.
    const tpThreshold = pos.pilot ? config.pilotTakeProfitUsd : config.bookTakeProfitUsd;
    if (netPnlUsd >= tpThreshold) {
      const detail = `${pos.pilot ? "objectif manche tendance" : "take-profit livre"} atteint (${netPnlUsd.toFixed(1)}$ ≥ ${tpThreshold}$, dont fees ${feesUsd.toFixed(2)}$)`;
      if (config.realExitAuto) {
        const m = await autoClose(pos, "take-profit", detail, netPnlUsd, valueUsd, creds, feesUsd);
        if (m && creds) await sendTelegram(creds.token, creds.chatId, m);
        alerts++;
        continue; // fermée (ou échec traité) — rien d'autre ce tick
      }
      if (Date.now() - lastAlertAt(pos.id, "real-take-profit") > ALERT_COOLDOWN_MS) {
        logEvent("real-take-profit", `🎯 ${pos.name} : ${detail} — prendre le gain ? ${killCmd}`, pos.id, pos.pool_address);
        alerts++;
      }
    }

    // 7) Momentum refroidi (RocketScan, 2026-08-23) : miroir de l'exit paper
    //    « cooling off » (déclin du delta de volume : intervalle courant <
    //    COOLING_RATIO × pic des 30 dernières minutes) — topblast et
    //    bidask-dip. AUTO validé David 2026-08-23 (REAL_EXIT_AUTO) : même
    //    kill-switch que recovery/hard-stop. Garde miroir du paper :
    //    bidask-dip → pas de verrouillage de perte > COOLING_MAX_LOSS_BIDASK
    //    (leçon Bollinger 2026-08-18) ; topblast sans garde.
    // Garde « surtension » (gud, 2026-08-24, revue) : miroir du paper — pas de
    // cooling-off pendant que le dynamic fee imprime, SAUF si OOR (surgeHold).
    // topblast/resurrect : sans garde (« fast in fast out », Nowload : on sort
    // quand le momentum refroidit).
    if ((pos.strategy === "topblast" || pos.strategy === "resurrect" || !surgeHold) && config.coolingExitEnabled) {
      const cool = coolingOffState(String(pos.pool_address));
      if (cool && cool.ratio < config.coolingRatio) {
        const lossRatio = refSol > 0 ? -netPnlSol / refSol : 0;
        if (!isDip || lossRatio < config.coolingMaxLossBidask) {
          const detail = `momentum refroidi : intervalle courant ${(cool.current / 1000).toFixed(0)}k$/min = ${(cool.ratio * 100).toFixed(0)}% du pic ${(cool.peak / 1000).toFixed(0)}k$/min sur ${cool.windowMin.toFixed(0)}min (RocketScan)`;
          if (config.realExitAuto) {
            const m = await autoClose(pos, "cooling-off", detail, netPnlUsd, valueUsd, creds, feesUsd);
            if (m && creds) await sendTelegram(creds.token, creds.chatId, m);
            alerts++;
            continue; // fermée (ou échec traité) — rien d'autre ce tick
          }
          if (Date.now() - lastAlertAt(pos.id, "real-cooling-off") > ALERT_COOLDOWN_MS) {
            logEvent(
              "real-cooling-off",
              `🌡️ ${pos.name} : ${detail} — ${pnlTag(netPnlUsd)} — sortie anticipée ? ${killCmd}`,
              pos.id,
              pos.pool_address
            );
          }
        }
      }
    }
  }
  return alerts;
}

const n = await realMonitor();
console.log(`[real-monitor] terminé — ${n} alerte(s)`);
