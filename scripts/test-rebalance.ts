// Test unitaire de rebalancePosition (garde anti-artefact lab 04/10).
// Invariant : après rebalance, la valeur Y au prix d'entrée doit rester ≈ le
// dépôt en Y effectif (±5 %) — l'artefact du lab était valueY@entry = 2 à 3×
// le dépôt (positions nées « en gain »). Le dépôt en Y est recalculé par
// division USD/Y comme dans markPosition (valueUsd / yUsd), PAS multiplié.
// Usage : DLMM_DB_PATH=/tmp/x.db LAB_MODE=true node ... scripts/test-rebalance.ts
import { db } from "../src/db.js";
import { rebalancePosition, getPosition, evaluatePosition, buildLiquidity } from "../src/paper.js";

const bp = (id: number, s: number) => Math.pow(1 + s / 10_000, id);

const ins = db.prepare(
  `INSERT INTO paper_positions
   (opened_at,pool_address,name,strategy,deposit_usd,min_bin_id,max_bin_id,bin_step,
    entry_price,entry_active_bin,token_x_symbol,token_y_symbol,amount_x,amount_y,
    fees_earned_usd,fees_claimed_usd,status,last_mark_price,last_value_usd,last_il_usd,
    rebalance_count,day_start_price,last_mark_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
);

interface Case {
  label: string;
  strategy: string;
  oneSided: "none" | "x" | "y";
  depositUsd: number;
  yUsd: number; // $ par unité de Y (prix SOL simulé)
  step: number;
  startBin: number;
  newPriceFactor: number;
}

const cases: Case[] = [
  { label: "y-only bidask-dip", strategy: "bidask-dip", oneSided: "y", depositUsd: 500, yUsd: 120, step: 100, startBin: -644, newPriceFactor: 1.5 },
  { label: "balancée spot-spread hausse", strategy: "spot-spread", oneSided: "none", depositUsd: 1000, yUsd: 120, step: 100, startBin: -700, newPriceFactor: 1.2 },
  { label: "balancée spot-spread baisse", strategy: "spot-spread", oneSided: "none", depositUsd: 1000, yUsd: 120, step: 100, startBin: -700, newPriceFactor: 0.8 },
  { label: "x-only spot-concentrated", strategy: "spot-concentrated", oneSided: "x", depositUsd: 1000, yUsd: 120, step: 100, startBin: -700, newPriceFactor: 0.7 },
];

let failures = 0;
for (const c of cases) {
  const depY = c.depositUsd / c.yUsd;
  const P0 = bp(c.startBin, c.step);
  const halfSpan = c.oneSided === "y" ? 100 : 10;
  const minB = c.startBin - halfSpan;
  const maxB = c.startBin + (c.oneSided === "y" ? 0 : halfSpan);
  const liq = buildLiquidity({ depositY: depY, price: P0, minBinId: minB, maxBinId: maxB, binStep: c.step, oneSided: c.oneSided });
  const valueY0 = evaluatePosition(
    { amount_x: liq.x0, amount_y: liq.y0, entry_price: P0, min_bin_id: minB, max_bin_id: maxB, bin_step: c.step } as any,
    P0
  ).valueY;
  const valueUsdAtMark = valueY0 * c.yUsd;

  ins.run(
    Date.now(), "TEST-" + c.label, c.label, c.strategy, c.depositUsd,
    minB, maxB, c.step, P0, c.startBin, "TOK", "SOL", liq.x0, liq.y0, 0, 0, "open", P0, valueUsdAtMark, 0, 0, P0, Date.now()
  );
  const id = Number((db.prepare("SELECT last_insert_rowid() i").get() as { i: number }).i);

  const newPrice = P0 * c.newPriceFactor;
  rebalancePosition(id, newPrice, valueUsdAtMark);
  const p = getPosition(id)!;
  const ev = evaluatePosition(p, p.entry_price);

  // Dépôt en Y EFFECTIF après recentering : pour x-only, le capital est converti
  // en X (x0 = depY/P) → sa valeur nominale Y change ; on compare donc valueY@entry
  // à ce que le même dépôt injecté FRAÎCHEMENT dans le nouveau range produirait.
  // Le dépôt courant est la valeur USD du mark / yUsd (même conversion que
  // markPosition — l'USD/Y se DIVISE, jamais ne se multiplie).
  const depositYNow = valueUsdAtMark > 0 && c.yUsd > 0 ? valueUsdAtMark / c.yUsd : depY;
  const freshLiq = buildLiquidity({ depositY: depositYNow, price: p.entry_price, minBinId: p.min_bin_id, maxBinId: p.max_bin_id, binStep: p.bin_step, oneSided: c.oneSided });
  const freshValY = evaluatePosition(
    { amount_x: freshLiq.x0, amount_y: freshLiq.y0, entry_price: p.entry_price, min_bin_id: p.min_bin_id, max_bin_id: p.max_bin_id, bin_step: p.bin_step } as any,
    p.entry_price
  ).valueY;
  const ratio = ev.valueY / freshValY;
  const ok = ratio >= 0.95 && ratio <= 1.05;
  console.log(
    `${ok ? "✅" : "❌"} ${c.label}: valueY@entry=${ev.valueY.toFixed(4)} attendu=${freshValY.toFixed(4)} ratio=${ratio.toFixed(4)} ` +
      `(bins ${p.min_bin_id}..${p.max_bin_id}, amounts ${p.amount_x.toFixed(2)}/${p.amount_y.toFixed(2)}, reb ${p.rebalance_count})`
  );
  if (!ok) failures++;
  db.prepare("DELETE FROM paper_positions WHERE id=?").run(id);
}

console.log(failures === 0 ? "\n✓ Test rebalance: 4/4 cas conformes." : `\n✗ ${failures} échec(s).`);
process.exit(failures === 0 ? 0 : 1);
