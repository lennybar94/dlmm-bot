// Ferme toutes les positions paper ouvertes (réallocation après changement de filtres).
// Usage : npm run close:all — crée des reviews 'closed' (évidence pour le tuner).
import { getOpenPositions, closePosition } from "../src/paper.js";

const pos = getOpenPositions();
for (const p of pos) {
  closePosition(p.id, "reconfig", "réallocation manuelle — filtres changés");
}
console.log(`${pos.length} position(s) fermée(s).`);
