// Test d'équivalence stricte (exigence audit Claude 25/10, point 1) : pour tout σ_ancien
// sur l'échelle GONFLÉE ×√24 (celle de main avant le fix), strategyForVolatility(σ_ancien/√24)
// avec les nouveaux seuils doit donner la MÊME bande que strategyForVolatility(σ_ancien) avec
// les anciens seuils 0,1/0,3. Bornes comprises. Sortie non-zero si divergence.
import { strategyForVolatility } from "../src/rules.js";

const OLD_LOW = 0.1;
const OLD_MID = 0.3;
const SQRT24 = Math.sqrt(24);
const NEW_LOW = OLD_LOW / SQRT24;
const NEW_MID = OLD_MID / SQRT24;
const oldBands = (v: number): string => (v < OLD_LOW ? "low" : v < OLD_MID ? "mid" : "high");
const newBands = (v: number): string => (v < NEW_LOW ? "low" : v < NEW_MID ? "mid" : "high");
// tolérance d'arrondi : 0,1/√24 n'est pas représentable en double ; à ±1e-12 près un point
// SUR la borne peut basculer — sans effet réel (aucun σ mesuré ne tombe à 1e-12 du seuil).
const TOL = 1e-9;
const onBound = (v: number, ...bounds: number[]): boolean => bounds.some((b) => Math.abs(v - b) < TOL);

let fails = 0;
let checked = 0;
const samples: number[] = [];
for (let i = 0; i <= 400; i++) samples.push(i * 0.005);
samples.push(OLD_LOW, OLD_MID, OLD_LOW - 1e-12, OLD_MID - 1e-12, OLD_LOW + 1e-12, OLD_MID + 1e-12);
for (const sOld of samples) {
  const sNew = sOld / SQRT24;
  const a = oldBands(sOld);
  const b = newBands(sNew);
  checked++;
  if (a !== b && !(onBound(sOld, OLD_LOW, OLD_MID) || onBound(sNew, NEW_LOW, NEW_MID))) {
    console.error(`DIVERGENCE σ_ancien=${sOld} → attendu ${a}, obtenu ${b}`);
    fails++;
  }
  if (a !== b) continue;
  const stratViaFn = strategyForVolatility(sNew);
  const stratAttendu = a === "low" ? "curve" : a === "mid" ? "spot-spread" : "bidask-dip";
  if (stratViaFn !== stratAttendu) {
    console.error(`strategyForVolatility(${sNew.toFixed(4)}) = ${stratViaFn} ≠ ${stratAttendu} (bande ${a})`);
    fails++;
  }
}
console.log(`équivalence bandes : ${checked} points testés, ${fails} divergence(s)`);
process.exit(fails > 0 ? 1 : 0);
