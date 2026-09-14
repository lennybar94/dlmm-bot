// Vérif config L4-B v2 + choix d'un candidat MAJOR non bloqué (dry-run ensuite)
import { config } from '../src/config.js';
import Database from 'better-sqlite3';

console.log('--- config L4-B v2 ---');
console.log('pilotTakeProfitUsd       =', config.pilotTakeProfitUsd);
console.log('pilotReentryCooldownDays =', config.pilotReentryCooldownDays);
console.log('pilotUsdMajor            =', config.pilotUsdMajor);
console.log('pilotMajorMinTvl         =', config.pilotMajorMinTvl);
console.log('pilotMajorMinVolume24h   =', config.pilotMajorMinVolume24h);
console.log('trendSleeveShare         =', config.trendSleeveShare);
console.log('realExitAuto             =', config.realExitAuto);

const db = new Database('data/dlmm-bot.db', { readonly: true });
const last = db.prepare('SELECT MAX(scanned_at) m FROM pool_scans').get().m;
const rows = db
  .prepare(
    `SELECT token_x_symbol x, pool_address p, tvl, volume_24h, pool_age_days, signals
     FROM pool_scans WHERE scanned_at=? AND signals LIKE '%tendance (L4-A)%'
       AND LOWER(COALESCE(token_y_symbol,'')) IN ('sol','wsol')
       AND tvl>=500000 AND volume_24h>=5000000 ORDER BY volume_24h DESC LIMIT 12`
  )
  .all(last);
const played = new Set(
  db
    .prepare(
      `SELECT DISTINCT LOWER(token_x_symbol) t FROM real_positions
       WHERE pilot=1 AND token_x_symbol IS NOT NULL AND opened_at > ?`
    )
    .all(Date.now() - 14 * 86400000)
    .map((r: { t: string }) => r.t)
);
console.log('\n--- MAJORS du dernier scan (★ = libre, bloqué par anti-ré-entrée sinon) ---');
for (const r of rows as { x: string; p: string; tvl: number; volume_24h: number; pool_age_days: number }[]) {
  const blocked = played.has((r.x || '').toLowerCase());
  console.log(
    `${blocked ? '⛔' : '★ '} ${r.x}-SOL TVL ${Math.round(r.tvl / 1000)}k$ vol ${Math.round(r.volume_24h / 1000)}k$ âge ${Math.round(r.pool_age_days)}j · ${r.p}`
  );
}
