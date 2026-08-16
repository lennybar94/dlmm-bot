// Ferme toutes les positions paper ouvertes (réallocation après changement de filtres).
// Usage : npm run close:all — NE crée PAS de review (reason admin filtrée par
// review.ts — une fermeture admin n'est pas un outcome de stratégie).
import { getOpenPositions, closePosition } from "../src/paper.js";

const pos = getOpenPositions();
for (const p of pos) {
  closePosition(p.id, "reconfig", "réallocation manuelle — filtres changés");
}
console.log(`${pos.length} position(s) fermée(s) (sans review — fermeture admin).`);
