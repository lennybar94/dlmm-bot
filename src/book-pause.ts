import * as fs from "fs";
import * as path from "path";
import { config } from "./config.js";

// Pause du book RÉEL (décision David 16/10). Chemin résolu depuis config.dataDir :
// un appelant lancé depuis lab/, scripts/ ou un cron ne doit JAMAIS rater le marqueur
// à cause de son cwd. Erreur de lecture → pause : on ne risque pas d'argent sur un doute.
const PAUSE_FILE = path.join(config.dataDir, "book-memes-PAUSE");

export function memesBookPaused(): { paused: boolean; note: string } {
  try {
    if (!fs.existsSync(PAUSE_FILE)) return { paused: false, note: "" };
    return { paused: true, note: fs.readFileSync(PAUSE_FILE, "utf8").trim().split("\n")[0] };
  } catch {
    return { paused: true, note: "fichier de pause illisible" };
  }
}

export function assertBookNotPaused(what: string): void {
  const p = memesBookPaused();
  if (p.paused) throw new Error(`⏸ ${what} refusé : book réel en pause (${p.note})`);
}
