// Scanner d'opportunités : pools top volume → filtres de sécurité → volatilité →
// score → signaux + hint de stratégie.

import { db, logEvent } from "./db.js";
import { config } from "./config.js";
import { fetchOhlcv, fetchNewestPools, fetchTopPools } from "./api.js";
import { realizedVolatility, s1Gate, sigmaIntradayFromScans, type SigmaScanPoint, buildStrategyHint, binIdFromPrice, dipTargetForPool, binsForDumpTarget, drawdownFromHigh, isQuickInOutCandidate, isTopBlastCandidate, isFeePrinterCandidate, isResurrectionCandidate, fibSwingFromCandles, fibRetraceLevel, rsi, analyzeTrend, DEFAULT_STRATEGY } from "./strategies.js";
import { getRules, strategyForVolatility, type RuleSet } from "./rules.js";
import type { OpportunityScore, Pool } from "./types.js";

export interface ScanResult {
  scannedAt: number;
  poolsSeen: number;
  poolsKept: number;
  opportunities: OpportunityScore[];
  earlyWatch: { pool: Pool; note: string }[];
}

function passesFilters(p: Pool, rules: RuleSet): { ok: boolean; reason: string } {
  if (p.is_blacklisted) return { ok: false, reason: "blacklisté" };
  // Playbook quick in & out (Tikz1070) : la porte d'entrée EST le spike 30m —
  // un pool récent/à petit TVL avec ≥ 30K$/min de volume + frais qui tournent
  // est EXACTEMENT la cible (nouveau pool, détection tôt). Ces candidats
  // passent les filtres d'âge et de TVL.
  const quick = isQuickInOutCandidate(p);
  if (p.tvl < config.minTvl && !quick)
    return { ok: false, reason: `TVL < ${config.minTvl}$` };
  if (p.volume_24h < config.minVolume24h)
    return { ok: false, reason: `vol 24h < ${config.minVolume24h}$` };
  if (p.pool_age_days < config.minPoolAgeDays && !quick)
    return { ok: false, reason: "pool trop récent" };
  if (p.fee_tvl_ratio_24h < rules.minFeeTvlRatio24h) {
    // Leçon anti-rug (GMGN/DucatelRomain03 : « 0,8 de fees = rug, tout est
    // fait artificiellement ») : un GROS volume qui ne génère quasi pas de
    // frais = volume wash/artificiel (pompe de bots). Raison explicite au
    // lieu du rejet générique pour les volumes significatifs.
    if (p.volume_24h >= config.washMinVolume24h)
      return {
        ok: false,
        reason: `⚠️ wash suspect : vol 24h ${(p.volume_24h / 1000).toFixed(0)}k$ pour fees/TVL ${p.fee_tvl_ratio_24h.toFixed(3)}% (GMGN : gros volume sans frais = artificiel)`,
      };
    return { ok: false, reason: `fees/TVL 24h < ${rules.minFeeTvlRatio24h}%` };
  }
  if (!p.current_price || p.current_price <= 0) return { ok: false, reason: "prix absent" };
  return { ok: true, reason: "" };
}

/**
 * Volume échangé depuis le scan précédent du même pool (= volume pendant
 * l'intervalle de scan, proxy du « trending 5 min » de GMGN — les fenêtres
 * fixes de l'API (30m/1h) sont trop lentes pour voir un démarrage tôt).
 * Retourne { delta, minutes } ou null si pas d'historique / delta incohérent.
 */
// Série σ de la porte S1 : prix natifs archivés de la pool sur la fenêtre. Borne haute
// strictement < scannedAt : en prod la ligne du tour courant n'est pas encore insérée, et
// sur une copie figée où plusieurs runs partagent le même timestamp, écarter les lignes
// d'un run précédent évite les rendements à Δt=0 et une fausse idée de la fraîcheur.
const sigmaSeriesStmt = db.prepare(
  `SELECT scanned_at, current_price FROM pool_scans
   WHERE pool_address = ? AND scanned_at >= ? AND scanned_at < ? AND current_price > 0 ORDER BY scanned_at`
);
const prevScanStmt = db.prepare(
  `SELECT scanned_at, volume_24h FROM pool_scans
   WHERE pool_address = ? AND scanned_at < ? AND volume_24h > 0
   ORDER BY scanned_at DESC LIMIT 1`
);

export function recentVolumeDelta(
  poolAddress: string,
  scannedAt: number,
  currentVolume24h: number
): { delta: number; minutes: number } | null {
  const prev = prevScanStmt.get(poolAddress, scannedAt) as { scanned_at: number; volume_24h: number } | undefined;
  if (!prev) return null;
  const delta = currentVolume24h - prev.volume_24h;
  const minutes = (scannedAt - prev.scanned_at) / 60_000;
  if (!Number.isFinite(delta) || delta <= 0 || minutes <= 0) return null;
  return { delta, minutes };
}

/**
 * Radar « pool neuve qui chauffe » (RocketScan, 2026-08-23) : pool < 24 h avec
 * un volume 30m élevé mais SANS la porte spike du topblast (vol 30m < 900k OU
 * frais 30m < seuil — pas encore de première jambe confirmée). Le post trie par
 * date de création et chasse ces pools — « voir tôt ≠ entrer tôt » : radar
 * uniquement (score 0 → jamais ouvert en auto, pas de notif).
 */
function newPoolHeating(p: Pool): boolean {
  return (
    p.pool_age_days < config.radarNewPoolMaxAgeHours / 24 &&
    p.volume_30m >= config.radarNewPoolMinVol30m &&
    !isQuickInOutCandidate(p)
  );
}

/**
 * Score composite (0-100), pondérations issues des RÈGLES (apprises par le tuner) :
 * - log(fee_apr_24h) normalisé (les APR suivent une loi de puissance)
 * - stabilité du volume (volume_1h vs volume_24h/24)
 * - pénalité pour les pools très jeunes / sans launchpad connu
 */
export function scorePool(
  p: Pool,
  vol24h: number,
  rules: RuleSet,
  strategy: string = DEFAULT_STRATEGY
): { score: number; signals: string[] } {
  const signals: string[] = [];
  const aprLog = Math.log10(1 + p.fee_apr_24h); // 1+ → APR 1000% ≈ 3.0
  const volStability = Math.min(1, p.volume_1h / Math.max(1, p.volume_24h / 24));
  const tvlScore = Math.min(1, Math.sqrt(p.tvl / 500_000));
  const farmBonus = p.farm_apr > 10 ? rules.farmBonus : 0;
  // Stratégies tolérantes à la σ (bidask-dip, topblast, resurrect) : l'échelle
  // anti-dump et la sortie rapide SONT les protections contre la volatilité —
  // pas de pénalité (cohérent avec leur exemption du plafond σ au scan). La
  // pénalité ne s'applique qu'aux stratégies spot/curve où l'IL détruit les
  // gains. (Résout la contradiction scan-admet/score-pénalise.)
  const sigmaTolerant = strategy === "bidask-dip" || strategy === "topblast" || strategy === "resurrect";
  // Fix 25/10 : seuil ÷√24 exact (unité σ daily directe). Périmètre sigmaTolerant
  // CONSERVÉ — c'est la porte S1 (commit suivant) qui ferme le trou des stratégies
  // « tolérantes », pas cette pénalité (effets attribuables à une seule cause).
  const volPenalty = vol24h > 1.2 / Math.sqrt(24) && !sigmaTolerant ? rules.volPenalty : 0; // volatilité extrême

  let score =
    (rules.wApr / 100) * Math.min(1, aprLog / 3) * 100 +
    (rules.wVolStability / 100) * volStability * 100 +
    (rules.wTvl / 100) * tvlScore * 100 +
    rules.wBase +
    farmBonus * 100 +
    volPenalty * 100;
  score = Math.max(0, Math.min(100, score));

  if (p.fee_apr_24h > 100) signals.push("APR fees 24h > 100%");
  if (volStability > 0.7) signals.push("volume stable");
  if (p.fee_tvl_ratio_24h > 0.5) signals.push("fees/TVL très élevé");
  // Durabilité des frais (Lamsito_eth/$NET : la sustainable-ness, pas l'APR
  // affiché — « le casino fait grossir la maison » = les frais RÉCURRENTS).
  // fee_tvl_ratio est par fenêtre → rythme uniforme ⇒ ratio_1h ≈ ratio_24h/24.
  // feeDecay = rythme horaire actuel / rythme moyen 24h (≈1 = durable).
  if (p.fee_tvl_ratio_24h >= 0.05 && p.fee_tvl_ratio_1h != null) {
    const feeDecay = (24 * p.fee_tvl_ratio_1h) / Math.max(0.0001, p.fee_tvl_ratio_24h);
    // Retiré 2026-08-20 (audit signaux, ROI 0.36% < baseline 0.90% sur 18 pos) :
    // le badge « fees en accélération » ne discriminait pas — l'accélération 1h
    // ne prédisait pas de meilleures entrées. Seuls durables/déclin sont gardés.
    if (feeDecay >= 0.6) signals.push(`fees durables (rythme 1h ≈ ${(feeDecay * 100).toFixed(0)}% de la moyenne 24h)`);
    else signals.push(`⚠️ fees en déclin (1h = ${(feeDecay * 100).toFixed(0)}% du rythme 24h) — le yield s'essouffle`);
  }
  // Dynamic fee en surtension (playbook gud, 2026-08-24) : pendant le dump
  // CATE le dynamic fee a dépassé 1% (≈ 2× la base) EXACTEMENT quand le
  // volume était vertical — « the dynamic fee did the lifting ». La
  // surtension = la fenêtre de harvest : les fees paient l'IL. Signal INFO
  // (aucun impact score, comme feeDecay) — la garde d'exit vit dans
  // markPosition/real-monitor (inFeeSurge, bidask-dip).
  if (p.dynamic_fee_pct != null && p.base_fee_pct != null && p.base_fee_pct > 0) {
    if (p.dynamic_fee_pct > config.dynamicFeeSurgeMinAbs && p.dynamic_fee_pct > config.dynamicFeeSurgeMult * p.base_fee_pct) {
      signals.push(
        `⚡ dynamic fee en surtension (${p.dynamic_fee_pct.toFixed(2)}% = ${(p.dynamic_fee_pct / p.base_fee_pct).toFixed(1)}× la base ${p.base_fee_pct.toFixed(2)}%)`
      );
    }
  }
  // Profil réflexif (Lamsito_eth/$NET) : APR délirant + σ extrême = ponzinomics
  // — le yield peut être réel TANT QUE la demande tient, mais l'unwind est
  // violent si elle meurt (émissions dynamiques/premium absents côté DLMM).
  if (p.fee_apr_24h >= 500 && vol24h >= 1.5 / Math.sqrt(24)) // fix 25/10 : unité σ daily directe
    signals.push(`⚠️ profil réflexif (ponzinomics) : APR ${p.fee_apr_24h.toFixed(0)}% + σ ${(vol24h * 100).toFixed(0)}%/j — unwind violent si la demande meurt`);
  if (p.launchpad) signals.push(`launchpad: ${p.launchpad}`);
  if (p.farm_apr > 10) signals.push(`farm APR ${p.farm_apr.toFixed(0)}%`);
  // Retiré 2026-08-20 (audit signaux, ROI 0.28% < baseline 0.90% sur 137 pos) :
  // « volatilité élevée » était quasi-constant (le bot ne sélectionne QUE des
  // pools volatils) → zéro info discriminante sur les opportunités affichées.
  // Playbook quick in & out (LP Army) : volume ≥ 30k$/min ≈ ≥ 900k$/30min
  if (p.volume_1h >= 900_000) signals.push("volume burst (≥30k$/min sur 1h)");
  // Playbook quick in & out (Tikz1070) : mesure 30 MIN exacte (l'API l'expose)
  // — spike ≥ 30K$/min sur la fenêtre de trading réelle du playbook.
  if (p.volume_30m >= config.quickMinVolume30m)
    signals.push(`⚡ top blast (satsmonkes) : vol 30m ${(p.volume_30m / 1000).toFixed(0)}k$ (≥30K$/min)`);
  // 🍰 Volume / TVL (Nowload 2026-08-25 — « Volume is king, but TVL determines
  // how many guests must share the cake ») : le volume par minute rapporté au
  // TVL mesure la concurrence entre LPs — plus le ratio est haut, moins il y a
  // de convives pour le gâteau de frais. Sur notre univers (MIN_TVL=50k$) les
  // meilleurs pools font 2-4 %/min (MANLET 4,3 %/min au spike du 24/08). INFO
  // seul (aucun impact score — fee_tvl_ratio capte déjà le partage du gâteau).
  if (p.volume_30m > 0 && p.tvl > 0) {
    const vTvlPerMin = p.volume_30m / 60 / p.tvl;
    if (vTvlPerMin >= 0.02)
      signals.push(
        `🍰 V/TVL ${(vTvlPerMin * 100).toFixed(1)}%/min — le volume est roi, le TVL compte les convives (Nowload)`
      );
  }
  if (isQuickInOutCandidate(p))
    signals.push(`pool récent (${p.pool_age_days.toFixed(1)} j) + spike — première jambe (satsmonkes/Tikz)`);
  // Retiré 2026-08-20 (audit signaux, ROI −0.12% < baseline 0.90% sur 34 pos) :
  // le badge « 🖨️ fee printer watchlist » corrélait à des entrées SOUS la
  // moyenne (dont MANLET −205$). La logique d'exemption du plafond maxVol24h
  // (isFeePrinterCandidate) est conservée — seul le badge d'affichage disparaît.
  // « Les fees trouvent leur chemin » (0xmiir) : tokens lancés ailleurs (ex.
  // pump.fun) qui font un volume majeur sur le DLMM Meteora — le volume migre
  // vers le pool de frais.
  if (p.volume_24h >= config.migrationMinVolume24h)
    signals.push(
      `volume migré : ${(p.volume_24h / 1e6).toFixed(1)}M$/24h sur le DLMM${p.launchpad ? ` (lancé ${p.launchpad})` : " (lancé ailleurs)"} — 0xmiir`
    );
  // Insight LP Army : gros bin step = couverture de dump large + fees dynamiques
  // qui s'envolent sur gros volume. Couverture typée par profil de token.
  if (p.bin_step >= 100) {
    const t = dipTargetForPool(p);
    signals.push(`bin step large (${p.bin_step} bp — couverture dump -${Math.round(t * 100)}% en ~${binsForDumpTarget(t, p.bin_step)} bins)`);
  }
  if (score >= 55) signals.push("top opportunité");
  return { score, signals };
}

/** nowMs : horloge injectable pour le test de fumée sur copie figée. La prod appelle
 * runScan() sans argument → Date.now(). */
export async function runScan(nowMs?: number): Promise<ScanResult> {
  const scannedAt = nowMs ?? Date.now();
  const rules = getRules();
  const pools = await fetchTopPools(config.scanTopPools);
  const kept: Pool[] = [];
  const rejected: { pool: Pool; reason: string }[] = [];
  // Radar early (GMGN/DucatelRomain03 : « voir tôt ≠ entrer tôt ») : pools
  // jeunes qui démarrent en volume mais ne passent pas encore les filtres
  // d'entrée (âge/TVL) → surveillés au dashboard, JAMAIS ouverts en auto.
  const earlyWatch: { pool: Pool; note: string }[] = [];

  for (const p of pools) {
    const f = passesFilters(p, rules);
    if (f.ok) kept.push(p);
    else {
      rejected.push({ pool: p, reason: f.reason });
      const young =
        f.reason.startsWith("pool trop récent") || f.reason.startsWith("TVL <");
      const active30m = p.volume_30m >= config.quickMinVolume30m;
      const d = recentVolumeDelta(p.address, scannedAt, p.volume_24h);
      const activeDelta = d !== null && d.delta >= config.spikeMinDeltaPerMin * d.minutes;
      if (young && p.pool_age_days <= config.earlyMaxPoolAgeDays && (active30m || activeDelta)) {
        const note = d && d.delta >= config.spikeMinDeltaPerMin * d.minutes
          ? `+${(d.delta / 1000).toFixed(0)}k$ en ~${Math.round(d.minutes)}min`
          : `vol 30m ${(p.volume_30m / 1000).toFixed(0)}k$`;
        earlyWatch.push({ pool: p, note });
      } else if (newPoolHeating(p)) {
        // Variante « pool neuve qui chauffe » (RocketScan, 2026-08-23) : le
        // post trie par date de création et chasse le pool < 24 h qui chauffe
        // immédiatement (>50k$/5min). Notre topblast exige un spike ≥ 30k$/min —
        // cette variante radar couvre la fenêtre D'AVANT le spike (vol 30m
        // élevé sans porte topblast) — voir tôt ≠ entrer tôt, jamais en auto.
        earlyWatch.push({
          pool: p,
          note: `🌱 pool < 24 h qui chauffe (vol 30m ${(p.volume_30m / 1000).toFixed(0)}k$, pas encore de spike ≥ 30k$/min) — fenêtre du post (RocketScan)`,
        });
      }
    }
  }

  // Radar « pool neuve qui chauffe » (RocketScan) — complément du tri du scan
  // principal : un pool < 24 h avec un vrai volume 30m n'apparaît pas dans le
  // top 150 par volume 24h (son volume 24h est encore petit). On interroge les
  // plus jeunes pools (sort_by=pool_created_at:desc, 1 requête) et on les
  // ajoute au radar s'ils chauffent sans avoir la porte spike du topblast.
  try {
    const newest = await fetchNewestPools(100);
    for (const p of newest) {
      if (pools.some((q) => q.address === p.address)) continue; // déjà vu (rejeté ou retenu)
      if (newPoolHeating(p)) {
        earlyWatch.push({
          pool: p,
          note: `🌱 pool < 24 h qui chauffe (vol 30m ${(p.volume_30m / 1000).toFixed(0)}k$, pas encore de spike ≥ 30k$/min) — fenêtre du post (RocketScan)`,
        });
      }
    }
  } catch (err) {
    logEvent("scan", `Radar pool neuve indisponible ce scan : ${String(err)}`);
  }

  // Volatilité réalisée sur les pools retenus (30 RPS max → délai).
  let s1SigmaAvailable = 0;
  let ohlcvFailures = 0;
  const rejectedBeforeLoop = rejected.length; // filtres passesFilters (pools jamais dans kept)
  const opportunities: OpportunityScore[] = [];
  for (let i = 0; i < kept.length; i++) {
    const p = kept[i];
    try {
      const candles = await fetchOhlcv(p.address, 24);
      const vol = realizedVolatility(candles);
      // Candidat quick in & out (Tikz1070) : pool récent en spike de volume.
      // La volatilité journalière extrême de ces pools ne s'applique pas à une
      // position SERRÉE de quelques minutes — la protection EST l'exit
      // « OOR → pull » + « volume fade ». On ne lui applique pas le plafond σ.
      const quick = isQuickInOutCandidate(p);
      // ♻️ Candidat résurrection (Nowload 2026-08-25, complète HALO) : vieux
      // token (> 2 j, hors fenêtre topblast) en spike de volume SANS drawdown
      // (le prix n'est pas dans un dump). Disjoint du topblast par l'âge et du
      // bidask-dip par le drawdown — même famille de protection que le topblast
      // (exemption σ : la sortie rapide EST la protection).
      const resurrect = !quick && isResurrectionCandidate(p);
      // Candidat fee printer (0xmiir) : gros volume + gros fees/TVL 24h — les
      // meilleurs encaisseurs de frais (ANSEM/MANLET/TOAD/CATE) ont une σ
      // extrême (80-200%/j) et étaient EXCLUS par le plafond (antérieur au
      // playbook bidask-dip). L'échelle anti-dump + le filtre drawdown ≥ 30%
      // (entrée sur rebond) sont les protections.
      const feePrinter = isFeePrinterCandidate(p);
      if (!quick && !feePrinter && !resurrect && vol > config.maxVol24h) {
        rejected.push({
          pool: p,
          reason: `volatilité ${(vol * 100).toFixed(0)}% > max ${(config.maxVol24h * 100).toFixed(0)}%`,
        });
        continue;
      }
      // PORTE S1 frais/LVR (NOTES-20261025 §8 — formule DLMM-Claude en bloc, TOUTES stratégies).
      // σ = mean-zero Σr²/Δt sur les 4 dernières heures RÉELLES de pool_scans (en prod le
      // cron tourne toutes les 5 min ⇒ ~48 rendements) + snapshot live du tour courant (la
      // ligne du scan n'est pas encore insérée). Fenêtre ancrée sur scannedAt, jamais sur le
      // dernier scan archivé : S1 juge le régime courant. Moins de 12 rendements → REFUS DUR
      // (§8 : un filtre de sécurité à données manquantes refuse ; l'historique total ne dit
      // rien du régime des 4 dernières heures). Aucune exception, même au premier lancement.
      // UNITÉ — mesuré sur la base d'archive, pas supposé : current_price est TOUJOURS le
      // prix NATIF de la paire (quote par token), quel que soit le quote. Preuve par
      // recoupement interne, sans API : pour 22 pools X-SOL présentes dans le même scan que
      // leur jumelle X-USDC et que SOL-USDC, le ratio stocké/(prix$X ÷ prix$SOL) vaut
      // 0,991 à 1,009 (CATE 0,9986 ; wNEAR 0,9998 ; cbBTC 0,9999 ; DOGE 0,9985…). Donc :
      //   · X-SOL  → SOL/token (prix natif X/SOL)
      //   · X-USDC → $/token  (prix natif X/USDC)
      //   · SOL-USDC → $/SOL
      // C'est exactement ce que demande §8 : le LVR d'une pool se calcule sur le σ du prix
      // QUE CETTE POOL EXPLOITE. Dans une pool X-SOL, un arbitrageur qui pousse X/SOL vers
      // le haut achète du X contre du SOL ; si X et SOL montent ensemble, la pool ne perd
      // presque rien. Mesurer σ(X/$) serait donc le mauvais objet — et diviser la série par
      // le SOL (ce que faisait la version précédente) donne r(X/$) − 2·r(SOL/$), qui ne
      // correspond à rien : c'est ce qui faisait passer SOL-USDC de 4 % à 11 %/j.
      // Conséquence : AUCUNE conversion n'est appliquée à aucune pool — série brute partout.
      let s1: { ok: boolean; reason?: string; r24?: number; r1h?: number; sigma?: number; n?: number; w?: number } | null = null;
      if (config.s1GateEnabled) {
        const sinceMs = scannedAt - config.s1SigmaWindowHours * 3_600_000;
        const series = sigmaSeriesStmt.all(p.address, sinceMs, scannedAt) as {
          scanned_at: number; current_price: number;
        }[];
        // Série BRUTE : current_price est le prix natif de la paire (voir l'unité plus haut),
        // donc c'est exactement l'objet que σ doit décrire pour CETTE pool. Aucune conversion,
        // aucun appariement à un autre quote, pas de
        // plafond de σ ajouté (W clampé à 0,25 au-delà de ~2,8 %/j ⇒ R = 0,5·f/σ² : il
        // faudrait ~84 %/j de frais pour atteindre 2,5 à σ = 41 %/j — la formule rejette déjà).
        const pts: SigmaScanPoint[] = series
          .map((r) => ({ t: r.scanned_at, priceXy: r.current_price }))
          .filter((x) => x.priceXy > 0);
        if (p.current_price > 0) pts.push({ t: scannedAt, priceXy: p.current_price });
        const v = s1Gate(p, pts);
        if (v.ok) {
          s1SigmaAvailable++;
          s1 = v;
        } else {
          rejected.push({ pool: p, reason: `${v.reason} · série ${series.length} pts` });
          continue;
        }
      }

      // Priorité de playbook par ÂGE (ressenti des users X, résout le
      // recouvrement spike / bidask-dip) :
      // - pool RÉCENT (≤ 2 j) en spike ≥ 30K$/min → top blast (satsmonkes,
      //   ex-quick-inout Tikz : chasser le nouveau pool tôt, sortie rapide)
      // - pool ÉTABLI avec gros volume + gros fees/TVL → bidask-dip (0xmiir :
      //   les fee printers persistants — échelle anti-dump sur rebond)
      // Top blast (satsmonkes setup 1) : spike ≥ 30K$/min sur pool récent
      // (≤ 2 j) à frais qui tournent = la première jambe haussière →
      // single-sided SOL, 10-15 bins, sortie rapide (volume fade / OOR → pull).
      // Prime sur le pipeline bidask-dip (le spike est la fenêtre de trading,
      // pas l'échelle).
      let strategy = strategyForVolatility(vol, rules);
      if (quick) strategy = "topblast";
      else if (resurrect) strategy = "resurrect";
      const { score, signals } = scorePool(p, vol, rules, strategy);
      if (s1?.ok)
        signals.push(
          `✅ porte S1 : R24 ${s1.r24!.toFixed(2)} · R1h ${s1.r1h!.toFixed(2)} · σ intraday ${(s1.sigma! * 100).toFixed(1)}%/j (${s1.n} rendements) · W ${s1.w!.toFixed(3)}`
        );
      if (quick)
        signals.push("⚡ top blast (satsmonkes) : première jambe — SOL-only 10-15 bins, fees en quelques minutes");
      // ♻️ Résurrection (Nowload 2026-08-25) : vieux token en spike de volume
      // sans drawdown — SPOT SOL large (40-69 bins, « classic range ~70 bins »
      // du post), fees tant que le momentum tient, sortie sur refroidissement.
      if (resurrect)
        signals.push(
          `♻️ résurrection (Nowload/HALO) : vieux token ${p.pool_age_days.toFixed(1)} j en spike vol 30m ${(p.volume_30m / 1000).toFixed(0)}k$ — SPOT SOL large 40-69 bins, sortie sur refroidissement`
        );
      // Trending court (GMGN/DucatelRomain03) : delta de volume entre scans =
      // volume échangé pendant l'intervalle (≈ 5 min avec un scan rapproché).
      // Voir le démarrage tôt, avant que la fenêtre 30m de l'API ne confirme.
      const deltaInfo = recentVolumeDelta(p.address, scannedAt, p.volume_24h);
      if (deltaInfo && deltaInfo.delta >= config.spikeMinDeltaPerMin * deltaInfo.minutes)
        signals.push(
          `⚡ trending court (GMGN) : +${(deltaInfo.delta / 1000).toFixed(0)}k$ en ~${Math.round(deltaInfo.minutes)}min — voir tôt ≠ entrer tôt`
        );
      const activeBinId = binIdFromPrice(p.current_price, p.bin_step);
      const drawdown = drawdownFromHigh(candles, p.current_price);
      // Indicateur de momentum (LP Army academy 2026-08-25, Evil Panda/LogicalTA) :
      // RSI calculé sur les MÊMES bougies OHLCV déjà fetchées (0 requête API).
      // Signal INFO uniquement — croiser avec le reste, JAMAIS un exit autonome
      // (leçon Bollinger 2026-08-18 : un indicateur seul qui déclenche une
      // sortie ferme des positions à perte).
      // ⚠️ Supertrend NON émis (2026-08-25, testé sur données réelles) : sur 10
      // bougies DAILY de meme coins, l'ATR est dominé par les ranges énormes →
      // à mult 3 le trend est haussier en PERMANENCE (XST -61% sur 10j restait
      // 🟢), à mult 1 il devient whippy et contredit le prix (LOOKSMAX +36%
      // baissier). La fonction supertrend() reste dispo dans strategies.ts pour
      // une future source intraday (marks accel-monitor) — ne pas ré-émettre le
      // badge sur l'OHLCV daily actuel.
      const rsiVal = rsi(candles);
      if (rsiVal !== null) {
        if (rsiVal <= 30)
          signals.push(
            `📉 RSI ${rsiVal.toFixed(0)} (7, bougies daily) : zone de survente — momentum vendeur qui s'essouffle, pas un signal d'achat seul (LP Army)`
          );
        else if (rsiVal >= 70)
          signals.push(
            `📈 RSI ${rsiVal.toFixed(0)} (7, bougies daily) : euphorie/surachat — attention au pic, pas un signal de vente seul (LP Army)`
          );
      }
      // L4-A (pivot pur, 2026-08-29) : filtre de TENDANCE. downTrend = les 3
      // signaux négatifs ensemble (drift 24h < 0 ET RSI(7) en baisse ET prix <
      // MA7) = tendance baissière CONFIRMÉE, profil de dump mortel (−50/−68 %).
      // ⚠️ SHADOW par défaut (TREND_FILTER_SHADOW=true) : log seul, AUCUNE
      // ouverture bloquée → 0 fee perdue (contrainte David 29/08 : la collecte
      // des fees est le moteur du bot). Le veto (TREND_FILTER_SHADOW=false) ne
      // s'activera qu'après preuve par rejeu (scripts/trend-replay.ts) que les
      // pools rejetées avaient un net négatif — et jamais sur topblast/resurrect
      // (le momentum EST leur porte d'entrée par construction).
      const trend = analyzeTrend(candles);
      if (trend.downTrend && config.trendFilterEnabled) {
        const trendReason = `pas de tendance : drift 24h ${(trend.drift24h! * 100).toFixed(0)}%, RSI ${trend.rsiNow!.toFixed(0)}↘, prix < MA7 (L4-A)`;
        if (config.trendFilterShadow) {
          signals.push(`⚠️ shadow L4-A (${trendReason}) — log seul, veto après rejeu fees`);
        } else if (strategy !== "topblast" && strategy !== "resurrect") {
          rejected.push({ pool: p, reason: trendReason });
          continue;
        }
      } else if (
        !trend.downTrend &&
        trend.drift24h !== null &&
        trend.drift24h > 0 &&
        trend.priceAboveSma
      ) {
        signals.push(
          `📈 tendance (L4-A) : drift 24h +${(trend.drift24h * 100).toFixed(0)}%, RSI ${trend.rsiNow?.toFixed(0) ?? "?"}${trend.rsiRising ? "↗" : ""}, prix > MA7`
        );
      }
      // Filtres bidask-dip (playbook Tiagogo) :
      // D — volume min : l'échelle anti-dump compte sur les frais dynamiques
      // des gros volumes ("volume 24h > 1-2M minimum"). Pool à petit volume =
      // capital immobilisé sans frais → on passe.
      if (strategy === "bidask-dip" && p.volume_24h < config.minVolume24hBidask) {
        rejected.push({
          pool: p,
          reason: `vol 24h ${(p.volume_24h / 1000).toFixed(0)}k$ < ${(config.minVolume24hBidask / 1000).toFixed(0)}k$ (bidask-dip)`,
        });
        continue;
      }
      // E — entrée sur rebond : on n'ouvre l'échelle anti-dump qu'après un dump
      // déjà significatif ("rentrer sur les rebonds après les gros dumps").
      if (strategy === "bidask-dip" && drawdown < config.minDipDrawdown) {
        rejected.push({
          pool: p,
          reason: `pas de rebond : drawdown ${(drawdown * 100).toFixed(0)}% < ${(config.minDipDrawdown * 100).toFixed(0)}% (bidask-dip)`,
        });
        continue;
      }
      // F — veto RSI (LP Army academy 2026-08-25) : un RSI(7, daily) ≥ seuil
      // APRÈS un dump ≥ 30% = blow-off top (pump verticale qui ne s'est pas
      // encore dégonflée) — la pire configuration pour déployer une échelle
      // anti-dump. Le badge INFO ne suffisait pas : veto d'entrée réel.
      // (topblast/resurrect NON concernés : le momentum élevé est leur porte
      // d'entrée par construction.)
      if (strategy === "bidask-dip" && rsiVal !== null && rsiVal >= config.rsiMaxEntryBidask) {
        rejected.push({
          pool: p,
          reason: `RSI ${rsiVal.toFixed(0)} ≥ ${config.rsiMaxEntryBidask} (surachat) — blow-off top, pas d'échelle (bidask-dip)`,
        });
        continue;
      }
      // Retiré 2026-08-20 (audit signaux, ROI 0.31% < baseline 0.90% sur 130
      // pos) : « rebond après dump » était quasi-constant (84% des positions,
      // c'est un filtre d'entrée bidask-dip, pas un signal) → badge retiré,
      // le filtre minDipDrawdown et le hint drawdown24h restent actifs.
      // Ancre Fibonacci (playbook satsmonkes, setup 2) : où le prix se situe
      // dans le retracement du swing ATH→low. Dans la zone 0.5-0.786 → le
      // sweet spot (« la majorité des buyers ré-entrent ici »). Sinon, le
      // niveau de retracement pour suivre l'approche de la zone.
      if (strategy === "bidask-dip") {
        const fib = fibSwingFromCandles(candles);
        if (fib) {
          const lvl = fibRetraceLevel(fib, p.current_price);
          // Retiré 2026-08-20 (audit signaux) : le badge « 📐 swing Fib » hors
          // zone (14 pos, PnL moy 6.7$ < 15.8$ baseline) était du bruit —
          // seul le sweet spot 🎯 zone Fib (ROI à surveiller, n=6) est gardé.
          if (lvl >= config.satsFibZoneLo && lvl <= config.satsFibZoneHi)
            signals.push(
              `🎯 zone Fib ${(config.satsFibZoneLo * 100).toFixed(0)}-${(config.satsFibZoneHi * 100).toFixed(0)} (satsmonkes) : retrace ${(lvl * 100).toFixed(0)}% du swing ATH→low — sweet spot ré-entrée`
            );
        }
      }
      const hint = buildStrategyHint(p, activeBinId, vol, strategy, p.current_price, candles);
      if (hint.dipTarget !== undefined) hint.drawdown24h = drawdown;
      opportunities.push({
        pool: p,
        vol_24h: vol,
        sigma_intraday: s1?.ok ? s1.sigma ?? null : null,
        s1_r24: s1?.ok ? s1.r24 ?? null : null,
        score,
        signals,
        strategyHint: hint,
      });
    } catch (err) {
      ohlcvFailures++;
      logEvent("scan", `OHLCV échoué pour ${p.name}: ${String(err)}`, {
        poolAddress: p.address,
      });
    }
    await new Promise((r) => setTimeout(r, config.apiRequestDelayMs));
  }

  opportunities.sort((a, b) => b.score - a.score);

  const insertPool = db.prepare(
    `INSERT INTO pool_scans (scanned_at, pool_address, name, token_x_symbol, token_y_symbol,
       tvl, volume_1h, volume_30m, volume_24h, fee_tvl_ratio_1h, fee_tvl_ratio_30m, fee_tvl_ratio_24h, fee_apr_24h, farm_apr,
       base_fee_pct, dynamic_fee_pct, bin_step, launchpad, is_blacklisted, current_price,
       vol_24h, sigma_intraday, s1_r24, score, signals, strategy_hint, pool_age_days, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertSignal = db.prepare(
    `INSERT INTO signals (created_at, pool_address, name, score, fee_apr_24h, tvl, volume_24h, signal_type, message)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'opportunity', ?)`
  );

  for (const opp of opportunities) {
    const p = opp.pool;
    insertPool.run(
      scannedAt,
      p.address,
      p.name,
      p.token_x.symbol,
      p.token_y.symbol,
      p.tvl,
      p.volume_1h,
      p.volume_30m,
      p.volume_24h,
      p.fee_tvl_ratio_1h,
      p.fee_tvl_ratio_30m,
      p.fee_tvl_ratio_24h,
      p.fee_apr_24h,
      p.farm_apr,
      p.base_fee_pct,
      p.dynamic_fee_pct,
      p.bin_step,
      p.launchpad,
      p.is_blacklisted ? 1 : 0,
      p.current_price,
      opp.vol_24h,
      opp.sigma_intraday ?? null,
      opp.s1_r24 ?? null,
      opp.score,
      JSON.stringify(opp.signals),
      JSON.stringify(opp.strategyHint),
      p.pool_age_days,
      p.created_at
    );
    for (const sig of opp.signals) {
      insertSignal.run(Date.now(), p.address, p.name, opp.score, p.fee_apr_24h, p.tvl, p.volume_24h, sig);
    }
  }
  for (const r of rejected) {
    insertPool.run(
      scannedAt,
      r.pool.address,
      r.pool.name,
      r.pool.token_x.symbol,
      r.pool.token_y.symbol,
      r.pool.tvl,
      r.pool.volume_1h,
      r.pool.volume_30m,
      r.pool.volume_24h,
      r.pool.fee_tvl_ratio_1h,
      r.pool.fee_tvl_ratio_30m,
      r.pool.fee_tvl_ratio_24h,
      r.pool.fee_apr_24h,
      r.pool.farm_apr,
      r.pool.base_fee_pct,
      r.pool.dynamic_fee_pct,
      r.pool.bin_step,
      r.pool.launchpad,
      r.pool.is_blacklisted ? 1 : 0,
      r.pool.current_price,
      0, // vol_24h
      null, // sigma_intraday
      null, // s1_r24
      0, // score
      JSON.stringify([`rejeté: ${r.reason}`]),
      "{}",
      r.pool.pool_age_days,
      r.pool.created_at
    );
  }

  // Radar early : pools jeunes en activité mais exclus des filtres d'entrée —
  // insérés en pool_scans (score 0 → pas une opportunité, pas de notif) pour
  // la section « 👁 radar early » du dashboard.
  for (const e of earlyWatch) {
    const p = e.pool;
    insertPool.run(
      scannedAt,
      p.address,
      p.name,
      p.token_x.symbol,
      p.token_y.symbol,
      p.tvl,
      p.volume_1h,
      p.volume_30m,
      p.volume_24h,
      p.fee_tvl_ratio_1h,
      p.fee_tvl_ratio_30m,
      p.fee_tvl_ratio_24h,
      p.fee_apr_24h,
      p.farm_apr,
      p.base_fee_pct,
      p.dynamic_fee_pct,
      p.bin_step,
      p.launchpad,
      p.is_blacklisted ? 1 : 0,
      p.current_price,
      0, // vol_24h
      null, // sigma_intraday
      null, // s1_r24
      0, // score
      JSON.stringify([`👁 radar early (GMGN : voir tôt ≠ entrer tôt) : ${e.note} — pas d'entrée auto`]),
      "{}",
      p.pool_age_days,
      p.created_at
    );
  }

  // Vérification de bouclage (audit Claude 25/10) : chaque pool RETENUE par les filtres
  // d'entrée doit finir en opportunité, en rejet motivé, ou en échec OHLCV — sans perte
  // silencieuse. Un écart signale un `continue` mort ou une variable écrasée.
  const rejectedInLoop = rejected.length - rejectedBeforeLoop;
  const accounted = opportunities.length + rejectedInLoop + ohlcvFailures;
  if (accounted !== kept.length) {
    logEvent(
      "scan",
      `⚠️ BOUCLAGE INCOMPLET : ${kept.length} retenues ≠ ${opportunities.length} opportunités + ${rejectedInLoop} rejets (boucle σ) + ${ohlcvFailures} OHLCV = ${accounted} (perte ${kept.length - accounted})`
    );
  }
  logEvent(
    "scan",
    `Scan terminé : ${pools.length} pools vus, ${kept.length} retenus, ${opportunities.length} opportunités scorées, ${earlyWatch.length} en radar early · S1 σ mesuré sur ${s1SigmaAvailable} · bouclage ${accounted}/${kept.length} (rejets intra-boucle ${rejectedInLoop}).`
  );
  return { scannedAt, poolsSeen: pools.length, poolsKept: kept.length, opportunities, earlyWatch };
}
