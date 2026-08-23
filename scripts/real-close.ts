// Ferme des positions RÉELLES (kill-switch du pilote) — removeLiquidity + claim.
// Usage :
//   npm run real:close -- --all              # ferme TOUTES les positions real_positions ouvertes
//   npm run real:close -- --id <id>          # ferme la position DB id
//   npm run real:close -- --pubkey <addr>    # ferme par clé de position on-chain
//   npm run real:close -- --pool <addr> --pubkey <addr> --bps 5000
// Après succès on-chain : la ligne real_positions passe en 'closed'.
import { db } from "../src/db.js";
import { config } from "../src/config.js";
import { realClosePosition } from "../src/real.js";

const args = process.argv.slice(2);
const argVal = (name: string) => {
  // Supporte --key=value ET --key value (forme documentée dans l'usage).
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return eq.split("=")[1];
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : undefined;
};
const hasFlag = (name: string) => args.includes(`--${name}`);

if (!config.realMode) {
  console.log("⚠️  REAL_MODE=false dans .env — rien à fermer (mode paper).");
  process.exit(0);
}

const bps = Number(argVal("bps") ?? "10000");
if (!Number.isFinite(bps) || bps <= 0 || bps > 10000) {
  console.error("--bps invalide (1-10000)");
  process.exit(1);
}

const openRows = db
  .prepare(`SELECT * FROM real_positions WHERE status='open' ORDER BY opened_at`)
  .all() as Array<Record<string, unknown>>;

let targets: Array<{ pool: string; pubkey: string; id: number }> = [];
if (hasFlag("all")) {
  targets = openRows.map((r) => ({ pool: String(r.pool_address), pubkey: String(r.position_pubkey), id: Number(r.id) }));
} else if (argVal("id")) {
  const r = openRows.find((x) => Number(x.id) === Number(argVal("id")));
  if (!r) {
    console.error(`id ${argVal("id")} introuvable parmi les positions réelles ouvertes.`);
    process.exit(1);
  }
  targets = [{ pool: String(r.pool_address), pubkey: String(r.position_pubkey), id: Number(r.id) }];
} else if (argVal("pubkey")) {
  const r = openRows.find((x) => String(x.position_pubkey) === argVal("pubkey"));
  const pool = argVal("pool");
  if (!r && !pool) {
    console.error("--pubkey inconnu en base : fournir aussi --pool=<address>");
    process.exit(1);
  }
  targets = [{ pool: pool ?? String(r!.pool_address), pubkey: argVal("pubkey")!, id: r ? Number(r.id) : 0 }];
} else {
  console.log(`Positions réelles ouvertes : ${openRows.length}`);
  for (const r of openRows) {
    console.log(
      `  #${r.id}  ${String(r.name).slice(0, 28)}  ${String(r.strategy)}  dep ${Number(r.deposit_usd).toFixed(0)}$  ${String(r.position_pubkey).slice(0, 12)}…`
    );
  }
  console.log("Usage : --all | --id <id> | --pubkey <addr> [--pool <addr>] [--bps <1-10000>]");
  process.exit(0);
}

if (targets.length === 0) {
  console.log("Aucune position réelle ouverte à fermer.");
  process.exit(0);
}
console.log(`Fermeture de ${targets.length} position(s) réelle(s) (bps=${bps})…`);
for (const t of targets) {
  try {
    const sig = await realClosePosition(t.pool, t.pubkey, bps);
    if (!sig) {
      throw new Error("aucune tx envoyée (sig vide) — on-chain inchangé, base NON marquée closed");
    }
    console.log(`  ✅ ${t.pubkey.slice(0, 12)}… fermée — sig ${sig.slice(0, 16)}…`);
    if (t.id) {
      // La sig de CLOSE est persistée (traçabilité : le champ sig portait
      // jusqu'ici la sig d'ouverture — leçon 2026-08-23, close BUTTHOLE).
      db.prepare(`UPDATE real_positions SET status='closed', closed_at=?, close_reason='manual-close', sig=? WHERE id=?`).run(
        Date.now(),
        sig,
        t.id
      );
    }
  } catch (e) {
    console.error(`  ❌ ${t.pubkey.slice(0, 12)}… : ${(e as Error).message}`);
  }
}
console.log("Terminé.");
