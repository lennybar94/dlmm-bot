// Test unitaire de la porte S1 (audit PR #3, mineur) — sans DB ni réseau.
//   1) série constante → refus ; 2) marche aléatoire de σ connu → σ retrouvé à ±10 % ;
//   3) multiplier toute la série par une constante laisse σ inchangé.
import { sigmaIntradayFromScans, feeLvrRatio, poolWidthLog, type SigmaScanPoint } from "../src/strategies.js";

const DAY = 86_400_000;
let fails = 0;
const check = (name: string, cond: boolean, detail: string) => {
  console.log(`${cond ? "OK" : "ECHEC"}  ${name} — ${detail}`);
  if (!cond) fails++;
};

// mulberry32 : déterministe
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const gauss = (r: () => number) => {
  const u = Math.max(r(), 1e-12);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// 1) série constante → variance nulle → la porte refuse (σ ≤ 0)
{
  const t0 = 1_700_000_000_000;
  const flat: SigmaScanPoint[] = Array.from({ length: 49 }, (_, i) => ({ t: t0 + i * 300_000, priceXy: 0.5 }));
  const { sigma, n } = sigmaIntradayFromScans(flat, 12);
  check("série constante refusée", sigma === null || sigma < 1e-9, `sigma=${sigma} n=${n}`);
}

// 2) marche aléatoire de σ cible, pas de 5 min (fenêtre de 49 points)
{
  const target = 0.05; // 5 %/j
  const stepDays = 300_000 / DAY;
  // Tolérance ±10 % sur la moyenne des graines : l'estimateur à 48 rendements a un erreur
  // type propre de √(2/n) ≈ 20 % (χ² sur n=48), donc une seule fenêtre peut légitimement
  // dériver de 10 %. Ce qu'on exige, c que la MOYENNE tombe juste — sinon le test serait
  // un tirage au sort, pas une vérification.
  const measured: number[] = [];
  for (const seed of [1, 42, 777, 2026, 31337]) {
    const r = rng(seed);
    const t0 = 1_700_000_000_000;
    let p = 1;
    const pts: SigmaScanPoint[] = [{ t: t0, priceXy: p }];
    for (let i = 1; i < 4000; i++) {
      p *= Math.exp(target * Math.sqrt(stepDays) * gauss(r));
      pts.push({ t: t0 + i * 300_000, priceXy: p });
    }
    const win = pts.slice(-49);
    const { sigma, n } = sigmaIntradayFromScans(win, 12);
    if (sigma !== null) measured.push(sigma / target);
    console.log(`     graine ${seed}: sigma=${((sigma ?? 0) * 100).toFixed(2)}%/j (${(((sigma ?? 0) / target) * 100).toFixed(1)}% de la cible, n=${n})`);
  }
  const mean = measured.reduce((a, b) => a + b, 0) / measured.length;
  check(
    `marche aléatoire sigma=5%/j — moyenne sur ${measured.length} graines`,
    Math.abs(mean - 1) <= 0.1,
    `moyenne=${(mean * 100).toFixed(1)}% de la cible (±10 % exigé)`
  );
}

// 3) invariance d'échelle : x k sur toute la série ne change pas les log-rendements
{
  const r = rng(7);
  const t0 = 1_700_000_000_000;
  let p = 0.002;
  const base: SigmaScanPoint[] = [];
  for (let i = 0; i < 49; i++) {
    p *= Math.exp(0.06 * Math.sqrt(300_000 / DAY) * gauss(r));
    base.push({ t: t0 + i * 300_000, priceXy: p });
  }
  const scaled = base.map((x) => ({ t: x.t, priceXy: x.priceXy * 137.5 }));
  const a = sigmaIntradayFromScans(base, 12).sigma;
  const b = sigmaIntradayFromScans(scaled, 12).sigma;
  check(
    "invariance par multiplication d'une constante",
    a !== null && b !== null && Math.abs(a - b) < 1e-12,
    `sigma=${a?.toFixed(8)} vs ${b?.toFixed(8)}`
  );
}

// bonus : R et W conformes à la formule DLMM-Claude
{
  const w = poolWidthLog(0.02); // 9 × 0,02 = 0,18 (< max 0,25)
  const wMax = poolWidthLog(0.5); // 4,5 → clampé à 0,25
  const R = feeLvrRatio(0.2, 0.01, 0.04); // 2·0,2·0,01/0,0016 = 2,5
  check("W = clamp(9σ, 0,01, 0,25)", Math.abs(w - 0.18) < 1e-9 && Math.abs(wMax - 0.25) < 1e-9, `W(0,02)=${w.toFixed(3)} W(0,5)=${wMax.toFixed(3)}`);
  check("R = 2·W·f/σ²", Math.abs(R - 2.5) < 1e-9, `R=${R.toFixed(4)} attendu 2,5`);
}

console.log(fails === 0 ? "\nTOUS LES TESTS PASSENT" : `\n${fails} ECHEC(S)`);
process.exit(fails === 0 ? 0 : 1);
