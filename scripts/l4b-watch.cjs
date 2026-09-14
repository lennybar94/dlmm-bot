// Veille pilote L4-B : imprime les candidats conformes ET « presque conformes » du dernier scan
// (rien sinon = watchdog pattern). Critères = spec L4-B : tendance L4-A confirmée, âge ≥ 7 j,
// TVL ≥ 100k, vol24h ≥ 1M, SOL-quoté, hors positions ouvertes, hors blacklist.
// ⚠️ Fix 30/08 : la colonne `signals` manquait au SELECT → le badge n'était JAMAIS lu → veille
// silencieuse depuis la création. Tier near-miss ajouté (1 critère manquant = signalé pour
// décision humaine, RSI re-vérifié par l4b-open au dry-run). Cooldown 6h/pool (fichier
// data/l4b-watch-notified.json, clés 'ok:<pool>' et 'near:<pool>').
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, '..', 'data', 'dlmm-bot.db');
const NOTIFIED_PATH = path.join(__dirname, '..', 'data', 'l4b-watch-notified.json');
const COOLDOWN_MS = 6 * 60 * 60 * 1000;
const MAX_NEAR = 5;

let db;
try {
  db = new Database(DB_PATH, { readonly: true });
} catch {
  process.exit(0); // DB injoignable → silencieux
}

try {
  const last = db.prepare('SELECT MAX(scanned_at) m FROM pool_scans').get().m;
  if (!last) process.exit(0);
  const scanAgeMin = (Date.now() - last) / 60000;
  if (scanAgeMin > 15) process.exit(0); // scan périmé → silencieux

  const inPos = new Set(db.prepare("SELECT pool_address FROM real_positions WHERE status='open'").all().map(r => r.pool_address));
  const now = Date.now();
  const bl = new Set(db.prepare('SELECT token_key, until FROM token_blacklist').all().filter(b => !b.until || b.until > now).map(b => b.token_key.toLowerCase()));
  // Anti-ré-entrée manche tendance (L4-B « étendue » v2, 14/09) : un token déjà
  // joué en pilote dans la fenêtre n'est MÊME PAS présenté au décideur. Sans ce
  // filtre, MET/cbBTC/HYPE/JUP reviennent à chaque scan et le décideur rejoue le
  // même token (4 tokens rejoués sur 11 closes ; 3 ré-entrées ≤7 j = −49,6$ net).
  const REENTRY_DAYS = Number(process.env.PILOT_REENTRY_COOLDOWN_DAYS || 14);
  const recentPilotTokens = new Set(
    db.prepare(`SELECT DISTINCT LOWER(token_x_symbol) t FROM real_positions
      WHERE pilot=1 AND token_x_symbol IS NOT NULL AND opened_at > ?`)
      .all(now - REENTRY_DAYS * 86400000).map(r => r.t)
  );

  let notified = {};
  try { notified = JSON.parse(fs.readFileSync(NOTIFIED_PATH, 'utf8')); } catch {}

  const rows = db.prepare(`SELECT pool_address, token_x_symbol, token_y_symbol, tvl, volume_24h,
    pool_age_days, score, signals
    FROM pool_scans WHERE scanned_at=? ORDER BY volume_24h DESC`).all(last);

  const ok = [], near = [];
  for (const r of rows) {
    const sig = (r.signals || '');
    if (!sig.includes('tendance (L4-A)')) continue;
    const symY = (r.token_y_symbol || '').toLowerCase();
    if (symY !== 'sol' && symY !== 'wsol') continue;
    if (inPos.has(r.pool_address)) continue;
    if (bl.has((r.token_x_symbol || '').toLowerCase())) continue;
    if (recentPilotTokens.has((r.token_x_symbol || '').toLowerCase())) continue; // anti-ré-entrée L4-B v2
    const age = r.pool_age_days ?? 0, tvl = r.tvl ?? 0, vol = r.volume_24h ?? 0;
    const fails = [];
    if (age < 7) fails.push(`âge ${Math.round(age)} j < 7 j`);
    if (tvl < 100000) fails.push(`TVL ${Math.round(tvl / 1000)}k$ < 100k$`);
    if (vol < 1000000) fails.push(`vol24h ${Math.round(vol / 1000)}k$ < 1M$`);
    const key = (fails.length ? 'near:' : 'ok:') + r.pool_address;
    const prev = notified[key];
    if (prev && now - prev < COOLDOWN_MS) continue;
    if (fails.length) { if (near.length < MAX_NEAR) near.push({ r, fails }); }
    else ok.push(r);
  }

  if (!ok.length && !near.length) process.exit(0); // rien → aucun stdout → aucune livraison

  for (const { r } of near) notified['near:' + r.pool_address] = now;
  for (const r of ok) notified['ok:' + r.pool_address] = now;
  fs.writeFileSync(NOTIFIED_PATH, JSON.stringify(notified));

  const lines = [];
  for (const r of ok) {
    const major = (r.tvl ?? 0) >= 500000 && (r.volume_24h ?? 0) >= 5000000;
    lines.push(`🎯 PILOTE L4-B : candidat CONFORME — ${r.token_x_symbol}-${r.token_y_symbol}`);
    lines.push(`Pool : ${r.pool_address}`);
    lines.push(`TVL ${Math.round((r.tvl ?? 0) / 1000)}k$ · vol24h ${Math.round((r.volume_24h ?? 0) / 1000)}k$ · âge ${Math.round(r.pool_age_days ?? 0)} j · tendance ✓${major ? " · ⭐ MAJOR (mise 1 000$)" : " · mise 500$"}`);
    lines.push(`Ouverture (décideur auto) : cd /home/polybot/dlmm-bot && npx tsx scripts/l4b-open.ts --pick=${r.pool_address} --confirm=REAL-OPEN`);
    lines.push(`(pas de --usd : palier automatique 500$ / 1 000$ major · TP +20$ et anti-ré-entrée 14 j actifs)`);
  }
  for (const { r, fails } of near) {
    lines.push(`👀 PILOTE L4-B : PRESQUE conforme — ${r.token_x_symbol}-${r.token_y_symbol}`);
    lines.push(`Pool : ${r.pool_address}`);
    lines.push(`TVL ${Math.round((r.tvl ?? 0) / 1000)}k$ · vol24h ${Math.round((r.volume_24h ?? 0) / 1000)}k$ · âge ${Math.round(r.pool_age_days ?? 0)} j · tendance ✓`);
    lines.push(`Critère manquant : ${fails.join(' · ')}`);
    lines.push(`Valider (dry-run) : cd /home/polybot/dlmm-bot && npx tsx scripts/l4b-open.ts --pick=${r.pool_address}`);
  }
  console.log(lines.join('\n'));
} catch {
  process.exit(0);
}
