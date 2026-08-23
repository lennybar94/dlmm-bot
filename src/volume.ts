// Volume observé d'un pool : série temporelle UNIFIÉE (pool_scans 5 min +
// accel_observations 60 s) + état « cooling off » (RocketScan, 2026-08-23).
// Le post sort quand le momentum refroidit (colonne running → cooling off) :
// proxy = déclin du DELTA de volume entre observations — le volume de
// l'intervalle courant chute sous une fraction du pic récent.
import { db } from "./db.js";
import { config } from "./config.js";

export interface VolumePoint {
  t: number;
  volume24h: number;
}

/** Série des volumes 24h observés pour un pool dans la fenêtre, ordonnée par temps. */
export function volumeSeries(poolAddress: string, now: number, lookbackMs: number): VolumePoint[] {
  const since = now - lookbackMs;
  const rows = db
    .prepare(
      `SELECT scanned_at AS t, volume_24h AS v FROM pool_scans
       WHERE pool_address = ? AND scanned_at >= ? AND scanned_at < ? AND volume_24h > 0
       UNION ALL
       SELECT taken_at AS t, volume_24h AS v FROM accel_observations
       WHERE pool_address = ? AND taken_at >= ? AND taken_at < ? AND volume_24h > 0
       ORDER BY t ASC`
    )
    .all(poolAddress, since, now, poolAddress, since, now) as { t: number; v: number }[];
  return rows.map((r) => ({ t: r.t, volume24h: r.v }));
}

/**
 * Série UNIQUEMENT pool_scans (la source cohérente — le listing /pools du scan).
 * ⚠️ Ne PAS mélanger avec accel_observations pour un SIGNAL : le listing API
 * renvoie des volume_24h parfois PÉRIMÉS vs le détail /pools/{addr} → deltas
 * fantômes (jusqu'à 289 k$/min sur omo) → faux pics → fausses sorties
 * (2 positions réelles omo fermées à tort 2026-08-23 19:00). L'exit
 * « cooling off » n'utilise QUE cette série ; accel reste pour l'historique.
 */
export function volumeSeriesScansOnly(poolAddress: string, now: number, lookbackMs: number): VolumePoint[] {
  const since = now - lookbackMs;
  const rows = db
    .prepare(
      `SELECT scanned_at AS t, volume_24h AS v FROM pool_scans
       WHERE pool_address = ? AND scanned_at >= ? AND scanned_at < ? AND volume_24h > 0
       ORDER BY t ASC`
    )
    .all(poolAddress, since, now) as { t: number; v: number }[];
  return rows.map((r) => ({ t: r.t, volume24h: r.v }));
}

export interface CoolingState {
  /** Volume par minute de l'intervalle courant ($/min). */
  current: number;
  /** Pic par minute sur la fenêtre ($/min). */
  peak: number;
  /** current / peak (0-1). */
  ratio: number;
  /** Minutes couvertes par la fenêtre observée. */
  windowMin: number;
}

/**
 * État « cooling off » d'un pool : le delta de volume (volume échangé entre
 * deux observations, normalisé PAR MINUTE — les sources 5 min et 60 s sont
 * ainsi comparables) courant < COOLING_RATIO × pic des COOLING_LOOKBACK_MIN
 * dernières minutes ET un vrai momentum a existé (pic ≥
 * COOLING_MIN_PEAK_DELTA_PER_MIN $/min — sinon rien à refroidir, on ne sort
 * pas sur du bruit). Retourne null si pas assez d'observations ou pas de
 * momentum (ou exit désactivé).
 */
export function coolingOffState(poolAddress: string, now = Date.now()): CoolingState | null {
  if (!config.coolingExitEnabled) return null;
  const windowMs = config.coolingLookbackMin * 60_000;
  // ⚠️ UNIQUEMENT pool_scans (source cohérente) — pas d'accel_observations :
  // le mélange des deux sources créait des deltas fantômes (faux positifs
  // 2026-08-23, 2 positions réelles fermées à tort). Voir volumeSeriesScansOnly.
  const pts = volumeSeriesScansOnly(poolAddress, now, windowMs);
  if (pts.length < 3) return null; // besoin d'au moins 2 deltas

  const perMin: number[] = [];
  for (let i = 1; i < pts.length; i++) {
    const minutes = (pts[i].t - pts[i - 1].t) / 60_000;
    const delta = pts[i].volume24h - pts[i - 1].volume24h;
    // Deltas positifs cohérents seulement (volume 24h croissant — l'API peut
    // renvoyer des séries réinitialisées à la baisse : à ignorer).
    if (minutes <= 0 || !Number.isFinite(delta) || delta <= 0) continue;
    perMin.push(delta / minutes);
  }
  // ⚠️ Faux positifs 2026-08-23 (corrigé le soir même — 2 positions RÉELLES
  // omo-SOL fermées à 19:00 + 2 paper) : à la cadence accel 60 s, un intervalle
  // sans trade est NORMAL (pools à ~0,5-2 k$/min de moyenne, trades irréguliers)
  // et un intervalle anormal (pic 37 k$/min, artefact API jusqu'à 1,8 M$/min)
  // fixait la barre du pic → n'importe quel trou de 60 s déclenchait la sortie.
  // Correctifs :
  //  1. pic ROBUSTE = 2e plus haut delta par minute (un seul intervalle
  //     anormal ne fixe plus la barre ; le gate momentum tombe dessus) ;
  //  2. refroidissement SOUTENU = COOLING_CONSECUTIVE derniers intervalles tous
  //     sous le seuil (≥ 2 min à 60 s, ≥ 10 min à 5 min) au lieu d'un seul.
  if (perMin.length < 3) return null;
  const sorted = [...perMin].sort((a, b) => b - a);
  const peak = sorted[1] ?? sorted[0]; // 2e plus haut (robuste aux anomalies)
  if (peak < config.coolingMinPeakDeltaPerMin) return null; // pas de momentum soutenu

  const threshold = config.coolingRatio * peak;
  const k = Math.max(1, Math.min(perMin.length, config.coolingConsecutive));
  const cooled = perMin.slice(-k).every((d) => d < threshold);
  if (!cooled) return null;

  return {
    current: perMin[perMin.length - 1],
    peak,
    ratio: perMin[perMin.length - 1] / peak,
    windowMin: (pts[pts.length - 1].t - pts[0].t) / 60_000,
  };
}
