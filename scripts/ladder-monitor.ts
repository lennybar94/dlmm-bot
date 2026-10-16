// Surveillance des positions ladder RÉELLES — décisions X1/X2/X3 via claudePolicy.
// Usage : npx tsx scripts/ladder-monitor.ts            (dry-run : affiche, ne ferme pas)
//         npx tsx scripts/ladder-monitor.ts --confirm=LADDER-REAL-CLOSE   (ferme)
// Clôture = removeLiquidity 100 % + claim (realClosePosition), puis revente de
// l'inventaire token→SOL par le chemin existant (sweep */15 ou sell-residues-jup).

import { createRequire } from "node:module";
import { db, logEvent } from "../src/db.js";
import { config } from "../src/config.js";
import { fetchPool, fetchOhlcv } from "../src/api.js";
import { getSolPriceUsd } from "../src/export.js";
import { realClosePosition } from "../src/real.js";
import { ladderGate, loadClaude, mapPoolToFeatures, computeMark, toClaudePosition } from "../src/ladder.js";

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { Connection, Keypair, PublicKey } = require("@solana/web3.js") as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const { DLMM } = require("@meteora-ag/dlmm") as any;

async function main() {
  const gateNoConfirm = ladderGate(undefined); // hors pause/flag → inactif, sec
  if (gateNoConfirm && !process.argv.includes("--force-test")) { console.log(`⏹ ladder-monitor inactif : ${gateNoConfirm}`); process.exit(0); }
  const confirm = process.argv.includes("--confirm=LADDER-REAL-CLOSE");

  const rows = db.prepare(
    "SELECT id, pool_address, name, position_pubkey, deposit_usd, min_bin_id, max_bin_id, bin_step, entry_price, opened_at FROM real_positions WHERE status='open' AND strategy='sol-ladder-spot'"
  ).all() as any[];
  if (!rows.length) { console.log("Aucune position ladder ouverte."); process.exit(0); }

  const { claudePolicy, DEFAULT_LEVERS, sigmaDaily } = await loadClaude();
  const lv = DEFAULT_LEVERS as any;
  const solUsd = (await getSolPriceUsd()) ?? 0;
  const conn = new Connection(config.rpcUrl, "confirmed");

  for (const pos of rows) {
    const p = await fetchPool(pos.pool_address);
    const candles = await fetchOhlcv(pos.pool_address, 24 * 10);
    const sig = sigmaDaily(candles.map((c) => ({ t: c.time * 1000, price: c.close })), lv.sigmaMinReturns ?? 12);
    const f = mapPoolToFeatures(p, candles, solUsd, sig);

    // Montants on-chain du compte de position + fees claimables.
    const dlmm = await DLMM.create(conn, new PublicKey(pos.pool_address), { cluster: config.cluster as any });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const positions = await (dlmm as any).getPositionsByUserAndLbPair(new PublicKey(config.walletAddress));
    const mine = (positions.userPositions ?? []).find((x: any) => x.publicKey.toBase58() === pos.position_pubkey);
    if (!mine) { console.error(`#${pos.id} ${pos.name}: compte introuvable on-chain — à vérifier manuellement.`); continue; }
    const activeBin = await dlmm.getActiveBin();
    const decX = p.token_x?.decimals ?? 9;
    const feesClaimable = await dlmm.getFeesClaimableForPosition(mine.publicKey);
    const feesSol = Number(feesClaimable?.feeY?.amount ?? 0) / 1e9; // SOL côté Y
    const mark = computeMark(pos, BigInt(mine.positionData.totalXAmount.toString()), BigInt(mine.positionData.totalYAmount.toString()), decX, p.current_price, activeBin.binId, solUsd, feesSol);

    // Compteur de ticks hors range : cumulé depuis l'ouverture dans ladder_costs.note
    // (format JSON) — un tick = une passe de monitor (~1 min ; latence vs paper notée PR).
    let ticksAbove = 0, ticksBelow = 0;
    try {
      const prev: { a?: number; b?: number } = (JSON.parse(String((db.prepare("SELECT note FROM ladder_costs WHERE position_id=? AND side='open'").get(pos.id) as { note?: string } | undefined)?.note ?? "{}")) as { ticks?: { a?: number; b?: number } }).ticks ?? {};
      ticksAbove = prev.a ?? 0; ticksBelow = prev.b ?? 0;
    } catch { /* premier mark */ }
    if (mark.aboveTicks > 0) ticksAbove++; else if (mark.belowTicks > 0) ticksBelow++;

    const cp = toClaudePosition(pos, mark, ticksAbove, ticksBelow);
    const market = { pool: pos.pool_address, token: pos.name, tick: { t: Date.now(), price: p.current_price, feeDaily: f.feeDaily24h, tvlSol: f.tvlSol, swapFee: f.swapFee }, f, mint: p.token_x?.address ?? null } as any;
    const book = { name: "ladder-real", cashSol: 0, initialSol: 0, open: new Map([[pos.id, cp]]), closed: [], entriesByToken: new Map(), cooldownUntil: new Map(), pausedUntil: 0, peakEquity: 0, deployedSol: () => mark.valueSol } as any;

    const action = claudePolicy.exit(cp, market, book, lv);
    console.log(`#${pos.id} ${pos.name}: valeur ${mark.valueSol.toFixed(3)} SOL · pure ${mark.pureSol >= 0 ? "+" : ""}${mark.pureSol.toFixed(3)} · fees ${feesSol.toFixed(4)} · above=${ticksAbove} below=${ticksBelow} → ${action.kind}${(action as any).reason ? ` (${(action as any).reason})` : ""}`);

    // Persistance des compteurs pour la prochaine passe.
    db.prepare("UPDATE ladder_costs SET note=? WHERE position_id=? AND side='open'")
      .run(JSON.stringify({ ticks: { a: ticksAbove, b: ticksBelow } }), pos.id);

    if (action.kind === "close" && confirm) {
      const solBefore = (await conn.getBalance(new PublicKey(config.walletAddress))) / 1e9;
      const closeSig = await realClosePosition(pos.pool_address, pos.position_pubkey, 10_000);
      const solAfter = (await conn.getBalance(new PublicKey(config.walletAddress))) / 1e9;
      db.prepare("UPDATE real_positions SET status='closed', closed_at=?, close_reason=? WHERE id=?")
        .run(Date.now(), String((action as any).reason ?? "claude-exit"), pos.id);
      db.prepare(
        `INSERT INTO ladder_costs (position_id, side, taken_at, sig, sol_before, sol_after, tx_fees_sol, note)
         VALUES (?, 'close', ?, ?, ?, ?, ?, ?)`
      ).run(pos.id, Date.now(), closeSig, solBefore, solAfter, solBefore - solAfter,
        `rendu ${mark.valueSol.toFixed(3)} SOL avant close · inventaire token ${mark.xUi.toFixed(2)} → sweep/sell-jup`);
      db.prepare(
        `INSERT INTO ladder_compare (event, taken_at, pool_address, token, real_position_id, size_sol_real, delta_sol, note)
         VALUES ('close', ?, ?, ?, ?, ?, ?, ?)`
      ).run(Date.now(), pos.pool_address, pos.name, pos.id, mark.valueSol, mark.pureSol, String((action as any).reason ?? ""));
      logEvent("ladder-close", `CLOSE ladder #${pos.id} ${pos.name} — ${(action as any).reason} · pur ${mark.pureSol.toFixed(3)} SOL · sig ${String(closeSig).slice(0, 12)}…`, { positionId: pos.id, poolAddress: pos.pool_address });
      console.log(`   fermée : ${closeSig} · inventaire ${mark.xUi.toFixed(2)} ${p.token_x?.symbol ?? "?"} à revendre (sweep auto <48 h post-close)`);
    } else if (action.kind === "close" && !confirm) {
      console.log("   (dry-run — relancer avec --confirm=LADDER-REAL-CLOSE)");
    }
  }
}

main().catch((e) => { console.error("⛔ ladder-monitor:", e?.message ?? e); process.exit(1); });
