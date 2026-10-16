// Garde de pause du book memes réel (décision David 16/10 : arrêt bidask-dip en réel).
// Fichier data/book-memes-PAUSE absent = comportement inchangé.
import * as fs from "fs";
import * as path from "path";

export function memesBookPaused(): { paused: boolean; note: string } {
  try {
    const p = path.join(process.cwd(), "data", "book-memes-PAUSE");
    if (fs.existsSync(p)) {
      return { paused: true, note: fs.readFileSync(p, "utf8").trim().split("\n")[0] };
    }
  } catch { /* fichier illisible → on ne bloque pas */ }
  return { paused: false, note: "" };
}
