// Test du garde-fou WALLET_THESAR_FLOOR_SOL (mock RPC, aucune tx réelle).
// Vérifie la logique : ouvertures autorisées tant que le solde projeté reste
// au-dessus du plancher ; refus/troncature en dessous.
import { config } from "../src/config.js";

process.env.WALLET_THESAR_FLOOR_SOL = "45";
// re-import forcé avec l'env (config lit process.env à l'import) — ici on simule
const floor = Number(process.env.WALLET_THESAR_FLOOR_SOL);

function decide(freeLamports: bigint, solOutRaw: bigint, reserveSol: number) {
  const WSOL_DEC = 1e9;
  const reserve = BigInt(Math.floor(reserveSol * WSOL_DEC));
  const feeMargin = 5_000_000n;
  let verdict = "";
  if (solOutRaw > 0n) {
    const projected = freeLamports - solOutRaw - feeMargin;
    if (projected < reserve) {
      const allowed = freeLamports > reserve + feeMargin ? freeLamports - reserve - feeMargin : 0n;
      if (allowed >= 1_000_000_000n && allowed >= solOutRaw / 2n && allowed < solOutRaw) {
        verdict = `tronqué → ${Number(allowed) / 1e9} SOL`;
      } else {
        verdict = "REFUSÉE";
      }
    } else verdict = "OK plein";
  } else verdict = "OK (pas de SOL natif)";
  return verdict;
}

const S = (n: number) => BigInt(Math.floor(n * 1e9));
const cases: [string, bigint, bigint, string][] = [
  ["libre 60, dépôt 8 → sous plancher? 60-8-0.005=51.995 ≥45", S(60), S(8), "OK plein"],
  ["libre 50, dépôt 8 → 41.995 <45 mais allowed=4.99≥max(1,4)", S(50), S(8), "tronqué → 4.995 SOL"],
  ["libre 46, dépôt 8 → allowed=0.995<1", S(46), S(8), "REFUSÉE"],
  ["libre 44 (<plancher), dépôt 0.5 → allowed négatif→0", S(44), S(0.5), "REFUSÉE"],
  ["dépôt stable-only (pas de SOL natif)", S(44), 0n, "OK (pas de SOL natif)"],
];
let fails = 0;
for (const [label, free, out, want] of cases) {
  const got = decide(free, out, floor);
  const ok = got === want;
  if (!ok) fails++;
  console.log(`${ok ? "✅" : "❌"} ${label}\n   → ${got}${ok ? "" : ` (attendu: ${want})`}`);
}
console.log(fails ? `\n${fails} ÉCHEC(S)` : "\nTous les cas passent.");
process.exit(fails ? 1 : 0);
