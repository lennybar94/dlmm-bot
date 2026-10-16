// Ouverture d'une position ladder RÉELLE sur un pool donné — politique Claude.
// Usage : npx tsx scripts/ladder-open.ts --pick=<pool_addr> [--confirm=LADDER-REAL-OPEN]
// Triple verrou (config.realLadder, pause levée, --confirm) — voir src/ladder.ts + docs/PR-REAL-LADDER.md.

import { createRequire } from "node:module";
import { db, logEvent } from "../src/db.js";
import { config } from "../src/config.js";
import { fetchPool, fetchOhlcv } from "../src/api.js";
import { getSolPriceUsd } from "../src/export.js";
import { realOpenPosition } from "../src/real.js";
import {
  LADDER_CAP_SOL, LADDER_MAX_POSITIONS, LADDER_MIN_ENTRY_SOL,
  ladderGate, loadClaude, mapPoolToFeatures, walletSol,
} from "../src/ladder.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Connection, Keypair, PublicKey } = require("@solana/web3.js") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DLMM } = require("@meteora-ag/dlmm") as any;

async function main() {
  const pickArg = process.argv.find((a) => a.startsWith("--pick="));
  if (!pickArg) { console.error("Usage: ladder-open.ts --pick=<pool_addr> [--confirm=LADDER-REAL-OPEN]"); process.exit(1); }
  const poolAddress = pickArg.split("=")[1];

  const inactive = ladderGate("--confirm=LADDER-REAL-OPEN");
  if (inactive) { console.log(`⏹ ladder-open inactif : ${inactive}`); process.exit(0); }
  if (!config.walletPrivateKey) { console.error("⛔ WALLET_PRIVATE_KEY absent"); process.exit(1); }

  // --- Plafonds en dur -------------------------------------------------------
  const deployed = (db.prepare("SELECT COALESCE(SUM(amount_y),0) s FROM real_positions WHERE status='open' AND strategy='sol-ladder-spot'").get() as { s: number }).s;
  const openCount = (db.prepare("SELECT COUNT(*) n FROM real_positions WHERE status='open' AND strategy='sol-ladder-spot'").get() as { n: number }).n;
  if (openCount >= LADDER_MAX_POSITIONS) { console.log(`P4 ladder : ${openCount}/${LADDER_MAX_POSITIONS} ouverte(s) — plafond.`); process.exit(0); }
  if (deployed >= LADDER_CAP_SOL) { console.log(`Plafond ${LADDER_CAP_SOL} SOL atteint (${deployed.toFixed(2)}).`); process.exit(0); }

  // --- Données marché → features claude -------------------------------------
  const { claudePolicy, DEFAULT_LEVERS, sigmaDaily } = await loadClaude();
  const p = await fetchPool(poolAddress);
  const candles = await fetchOhlcv(poolAddress, 24 * 10);
  const solUsd = (await getSolPriceUsd()) ?? 0;
  if (!(solUsd > 0)) { console.error("⛔ prix SOL indisponible"); process.exit(1); }
  const lv = DEFAULT_LEVERS as any;
  const sig = sigmaDaily(candles.map((c) => ({ t: c.time * 1000, price: c.close })), lv.sigmaMinReturns ?? 12);
  const f = mapPoolToFeatures(p, candles, solUsd, sig);

  // --- Verdict politique (source unique) ------------------------------------
  const freeSol = await walletSol();
  const equity = freeSol + deployed;
  const book = {
    name: "ladder-real", cashSol: Math.min(equity, LADDER_CAP_SOL) - deployed, initialSol: LADDER_CAP_SOL,
    open: new Map(), closed: [], entriesByToken: new Map(), cooldownUntil: new Map(),
    pausedUntil: 0, peakEquity: equity, deployedSol: () => deployed,
  } as any;
  const market = {
    pool: p.address, token: p.token_x?.symbol ?? p.name,
    tick: { t: Date.now(), price: p.current_price, feeDaily: f.feeDaily24h, tvlSol: f.tvlSol, swapFee: f.swapFee },
    f, mint: p.token_x?.address ?? null,
  } as any;
  const decision = claudePolicy.entry(market, book, lv);
  if (!decision.ok) {
    console.log(`Refus politique Claude : ${(decision as any).reason}`);
    logEvent("ladder-refuse", `${p.name} — refus Claude policy : ${(decision as any).reason}`, { poolAddress: p.address });
    process.exit(0);
  }
  const plan = (decision as any).plan;
  const width = plan.upperBin - plan.lowerBin + 1;
  if (width > 69) { console.error(`⛔ largeur ${width} bins > 69 : le plan ne peut pas être exécuté fidèlement (realOpenPosition clumperait) — refus.`); process.exit(1); }
  const sizeSol = Math.min(plan.sizeSol, LADDER_CAP_SOL - deployed, freeSol - config.walletThesarFloorSol - 0.1);
  if (!(sizeSol >= LADDER_MIN_ENTRY_SOL)) { console.log(`Taille effective ${sizeSol.toFixed(3)} SOL < ${LADDER_MIN_ENTRY_SOL} (plafond/plancher) — refus.`); process.exit(0); }

  console.log(`Plan Claude : ${plan.strategy} bins [${plan.lowerBin}..${plan.upperBin}] (${width}), taille paper ${plan.sizeSol.toFixed(3)} → réel ${sizeSol.toFixed(3)} SOL`);
  console.log(`  σ=${f.sigmaDaily?.toFixed(5)} nRet=${f.nReturns} f24=${(f.feeDaily24h * 100).toFixed(2)} %/j TVL=${Math.round(f.tvlUsd)}$ âge=${f.poolAgeDays.toFixed(1)} j entry=${JSON.stringify(plan.entry)}`);

  // --- Bin arrays : refus si création non remboursable requise --------------
  // La range doit être couverte par des bin arrays EXISTANTS (la rent d'un compte
  // neuf ~0,02–0,07 SOL n'est pas remboursée tant que le compte vit ; cahier 16/10).
  const conn = new Connection(config.rpcUrl, "confirmed");
  const dlmm = await DLMM.create(conn, new PublicKey(p.address), { cluster: config.cluster as any });
  const lowerArr = Math.floor(plan.lowerBin / dlmm.binArrayInterval);
  const upperArr = Math.floor(plan.upperBin / dlmm.binArrayInterval);
  const existing = await dlmm.getBinArraysInRange(lowerArr, upperArr);
  const missing = (upperArr - lowerArr + 1) - existing.length;
  if (missing > 0) {
    console.error(`⛔ ${missing} bin array(s) à créer pour [${plan.lowerBin}..${plan.upperBin}] — rent non remboursable : entrée refusée (cahier David 16/10).`);
    logEvent("ladder-refuse", `${p.name} — refus bin arrays manquants (${missing})`, { poolAddress: p.address });
    process.exit(1);
  }

  // --- Dry-run vs envoi ------------------------------------------------------
  if (!process.argv.includes("--confirm=LADDER-REAL-OPEN")) {
    console.log("\nDRY-RUN — aucune tx envoyée. Relancer avec --confirm=LADDER-REAL-OPEN.");
    process.exit(0);
  }

  const opp = {
    pool: p, vol_24h: 0, score: 0, signals: [], id: 0, opened_at: Date.now(),
    pool_address: p.address, name: p.name, strategy: "sol-ladder-spot" as const,
    deposit_usd: sizeSol * solUsd, min_bin_id: plan.lowerBin, max_bin_id: plan.upperBin,
    bin_step: p.bin_step, entry_price: p.current_price, entry_active_bin: plan.activeBin,
    token_x_symbol: p.token_x?.symbol, token_y_symbol: p.token_y?.symbol,
    amount_x: 0, amount_y: sizeSol,
    strategyHint: { strategy: "sol-ladder-spot" as const, minBinId: plan.lowerBin, maxBinId: plan.upperBin, binsPerSide: width, vol_24h: f.sigmaDaily ?? 0 },
  } as any;

  const solBefore = await walletSol();
  const r = await realOpenPosition(opp, sizeSol * solUsd, { yOverrideRaw: BigInt(Math.floor(sizeSol * 1e9)), xOverrideRaw: 0n });
  const solAfter = await walletSol();

  const posId = db.prepare(
    `INSERT INTO real_positions
     (opened_at, pool_address, name, strategy, deposit_usd, position_pubkey, sig,
      min_bin_id, max_bin_id, bin_step, entry_price, token_x_symbol, token_y_symbol,
      amount_x, amount_y, status, pilot)
     VALUES (?, ?, ?, 'sol-ladder-spot', ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, 'open', 0)`
  ).run(Date.now(), p.address, p.name, sizeSol * solUsd, r.positionPubkey, r.sig,
    plan.lowerBin, plan.upperBin, p.bin_step, p.current_price,
    p.token_x?.symbol, p.token_y?.symbol, sizeSol).lastInsertRowid as number;

  db.prepare(
    `INSERT INTO ladder_costs (position_id, side, taken_at, sig, sol_before, sol_after, tx_fees_sol, slippage_pct, price_signal, price_exec, note)
     VALUES (?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(posId, Date.now(), r.sig, solBefore, solAfter, solBefore - solAfter - sizeSol,
    (p.current_price / plan.entry?.price - 1) * 100, plan.entry?.price ?? p.current_price, p.current_price,
    `bins[${plan.lowerBin},${plan.upperBin}] size=${sizeSol.toFixed(4)}`);

  db.prepare(
    `INSERT INTO ladder_compare (event, taken_at, pool_address, token, real_position_id, size_sol_real, size_sol_paper, entry_json, note)
     VALUES ('open', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(Date.now(), p.address, p.name, posId, sizeSol, plan.sizeSol,
    JSON.stringify({ sigma: f.sigmaDaily, f24: f.feeDaily24h, r24: plan.entry?.r24, depth: plan.entry?.depth }),
    `latence plan→exécution incluse`);

  logEvent("ladder-open", `OUVERT ladder réel #${posId} — ${p.name}, ${sizeSol.toFixed(2)} SOL, bins [${plan.lowerBin}..${plan.upperBin}], sig ${String(r.sig).slice(0, 12)}…`, { positionId: posId, poolAddress: p.address });
  console.log(`\n✅ OUVERT ladder #${posId} : ${p.name} — ${sizeSol.toFixed(2)} SOL\n   sig : ${r.sig}\n   pub : ${r.positionPubkey}`);
}

main().catch((e) => { console.error("⛔ ladder-open:", e?.message ?? e); process.exit(1); });
