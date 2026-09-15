import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function num(key: string, def: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return def;
  const v = Number(raw);
  return Number.isFinite(v) ? v : def;
}

function str(key: string, def: string): string {
  const raw = process.env[key];
  return raw === undefined || raw === "" ? def : raw;
}

function bool(key: string, def: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return def;
  return raw.toLowerCase() === "true" || raw === "1";
}

export const config = {
  root: path.resolve(__dirname, ".."),
  dataDir: path.resolve(__dirname, "..", "data"),
  logDir: path.resolve(__dirname, "..", "logs"),

  // API DLMM (Data API officielle)
  dlmmApiBase: str("DLMM_API_BASE", "https://dlmm.datapi.meteora.ag"),
  rpcUrl: str("SOLANA_RPC_URL", "https://api.mainnet-beta.solana.com"),

  // Cluster Solana pour le MODE RÉEL. Défaut "devnet" = sécurité : phase test
  // (SAFETY.md) — passer EXPLICITEMENT à "mainnet-beta" avant tout fonds réel.
  cluster: str("CLUSTER", "devnet"),

  // Mode réel : STRICTEMENT désactivé par défaut.
  realMode: bool("REAL_MODE", false),
  realConfirm: str("REAL_CONFIRM", ""),
  walletPrivateKey: str("WALLET_PRIVATE_KEY", ""),
  // Adresse PUBLIQUE du wallet du bot (pilote réel HsstWQz…). Sert au solde
  // libre affiché par le dashboard (getBalance) — jamais de clé ici.
  walletAddress: str("WALLET_ADDRESS", "HsstWQzA65Zh2DKJTfWP5zkDLaZUi49UrJpbjku2w3az"),

  // Scan / opportunités
  minTvl: num("MIN_TVL", 50_000),
  minVolume24h: num("MIN_VOLUME_24H", 10_000),
  minFeeTvlRatio24h: num("MIN_FEE_TVL_RATIO_24H", 0.02), // % (2 = 2%)
  minPoolAgeDays: num("MIN_POOL_AGE_DAYS", 1),
  maxVol24h: num("MAX_VOL_24H", 0.6), // σ journalière max (60 %/j) — protège les petits gains de l'IL
  scanTopPools: num("SCAN_TOP_POOLS", 150),
  apiRequestDelayMs: num("API_REQUEST_DELAY_MS", 120),
  apiMaxRetries: num("API_MAX_RETRIES", 3),

  // Stratégies / positions paper
  maxPositions: num("MAX_POSITIONS", 6),
  depositUsdPerPosition: num("DEPOSIT_USD_PER_POSITION", 1_000),
  rebalanceThreshold: num("REBALANCE_THRESHOLD", 0.45),
  hardStopDailyDrop: num("HARD_STOP_DAILY_DROP", 0.4),
  // Value stop-loss (garde-fou CYBERLEEK/GTA6, 2026-08-27 ; révisé NET 29/08) :
  // close auto si la PERTE NETTE (valeur + fees − SOL déployé) dépasse le seuil.
  // Historique : 0.30 (27/08) → 0.15 (27/08 soir) → 0.05 (29/08) → 0.10 NET
  // (29/08). Le hard-stop prix (dip 0.85) ne coupe que la mort du token ; une
  // échelle bidask-dip qui traverse son range perd −30/−50 % sans qu'aucune
  // règle ne tire (in-range = pas d'OOR, PnL < 0 = pas de recovery).
  // Décision 29/08 (données live) : un stop sur la VALEUR brute coupe des
  // fee-harvesters in-range en pleine collecte (CYBERLEEK −5,6 % valeur alors
  // qu'in-range 90 % du temps, fees +7,7 $). Stop sur le NET : coupe les death
  // spirals (cc −12 %, Pistacio −11 %, Morty −13 % net) et épargne les
  // fee-harvesters (CYBERLEEK −3,8 %, GTA6 −2,8 % net). Doctrine fees +++.
  valueStopLoss: num("VALUE_STOP_LOSS", 0.10),
  minClaimUsd: num("MIN_CLAIM_USD", 25),
  // Pilote réel : alerte « position en attente » après X h hors range (aucun
  // fee) — décision laisser dormir / redéployer (kill-switch).
  realOorAlertHours: num("REAL_OOR_ALERT_HOURS", 6),
  // Décision OOR AUTO (mandat autonomie 2026-08-24) : hors range > X h sous
  // l'eau → force-close pour libérer le capital (le sweep + le cron open:paper
  // réallouent ≤ 1 h). net ≥ 0 → close dès REAL_OOR_ALERT_HOURS (oor-redeploy).
  realOorForceCloseHours: num("REAL_OOR_FORCE_CLOSE_HOURS", 24),
  // Claim AUTO des fees (mandat autonomie 2026-08-24) : fees ≥ MIN_CLAIM_USD
  // → realClaimRewards + ✅/🚨 Telegram (mandataire — même classe que le sweep).
  claimAutoEnabled: bool("CLAIM_AUTO_ENABLED", true),
  // Pilote réel : exécution AUTOMATIQUE des exits définis (recovery-exit,
  // hard-stop, cooling-off, oor-redeploy/oor-force depuis 2026-08-24) —
  // validé David 22/08, autonomie complète 24/08. Flip/fee-decline restent
  // des décisions humaines. Le wrapper dlmm-realmonitor.sh pose REAL_MODE en
  // process-local (JAMAIS dans .env — le cron open:paper doit rester paper).
  realExitAuto: bool("REAL_EXIT_AUTO", true),
  maxDailyDrop: num("MAX_DAILY_DROP", 0.4),
  // Régime machine réelle (validé David 2026-08-24) : garde de solde — ne
  // jamais déployer plus de REAL_MAX_DEPLOY_RATIO × solde SOL du wallet
  // (buffer gas + marge de manœuvre), appliquée à CHAQUE ouverture réelle
  // (cron open:paper compris). 0.8 = 80 % max déployés.
  realMaxDeployRatio: num("REAL_MAX_DEPLOY_RATIO", 0.8),
  // Manches book hybride (01/09, go David) : TREND_SLEEVE_SHARE = part du
  // capital TOTAL réservée à la manche tendance (spot/curve balancés L4-B).
  // Manche memes (fees, open-paper) = (1−share). Gardes : open-paper →
  // déployé memes ≤ 0.8×(1−share)×total ; l4b-open → déployé tendance +
  // besoin ≤ 0.8×share×total. Remplace PILOT_RESERVE_SOL (réserve fixe 6.5,
  // 31/08 — preuve : open-paper */5 re-consommait toute marge <5 min) : la
  // part dynamique scale avec les top-ups.
  trendSleeveShare: num("TREND_SLEEVE_SHARE", 0.4),
  // ─── Manche tendance L4-B « étendue » v2 (2026-09-14) ───────────────────
  // Le pilote était FLAT (+1,9$ net sur 11 closes) pour DEUX fuites trouvées
  // par contre-factuel mark à mark, pas par intuition :
  //  1) TP — les 6 gagnantes se refermaient à +13/+22$ via cooling-off, mais 2
  //     avaient d'abord dépassé +20$ avant de rendre la mise (HYPE 2 : +22,9 →
  //     −18,8 ; CATE : +32,2 → +13,8). Sans TP : +1,9$. Avec TP +20$ : +120,3$.
  //     Plateau mesuré +25$ (+137,9$) / +30$ (+142,3$) → seuil conservateur
  //     +20$ retenu (les closes réelles se groupent à +13/+22$).
  //  2) anti-ré-entrée — 4 tokens rejoués sur 11 closes ; les 3 ré-entrées ≤ 7 j
  //     ont coûté −49,6$ net. Fenêtre 14 j (attrape aussi cbBTC rejoué à 9 j,
  //     −13,4$) : +144,4$ combinée au TP.
  // Réservés AU PILOTE : le book memes sort par recovery/cooling-off (doctrine
  // fees +++), jamais par un plafond de gain.
  pilotTakeProfitUsd: num("PILOT_TAKE_PROFIT_USD", 20),
  pilotReentryCooldownDays: num("PILOT_REENTRY_COOLDOWN_DAYS", 14),
  // Take-profit BOOK PRINCIPAL (bidask-dip) — décision David 2026-09-15 après
  // simulation sur les 240 positions réelles : baseline -1 900$ → TP+10$ +271$,
  // seul seuil positif dans les DEUX moitiés OOS (+107/+164). Entry-drift +2
  // marks le ramène à +16$ : c'est un coupe-perte déguisé (38% des perdantes
  // ont touché >=+10$ avant de sombrer), pas un edge de profit. Plateau
  // +15/+20 nettement moins robuste → seuil bas retenu.
  bookTakeProfitUsd: num("BOOK_TAKE_PROFIT_USD", 10),
  // Anti-ré-entrée GLOBALE (fenêtre 14j comme le pilote) : 184 ré-entrées du
  // book sur 240 trades, médiane 0,5j — la garde 6h existante ne filtre rien
  // (seules 4 étaient <=6h). Simulation : -1 900 -> -845$ à elle seule.
  // Palier de mise « major » (classe conviction du sizing satsmonkes) : TVL ≥
  // 500k$ ET vol24h ≥ 5M$ → 1 000$ au lieu de 500$. 8 pools distincts de ce
  // type sur 14 j (MET, ZEC, JUP, HYPE…). La garde de manche (0.8×share×total
  // ≈ 8,85 SOL aujourd'hui) borne toujours : 1 major + 1 standard tiennent.
  pilotUsdMajor: num("PILOT_USD_MAJOR", 1_000),
  pilotMajorMinTvl: num("PILOT_MAJOR_MIN_TVL", 500_000),
  pilotMajorMinVolume24h: num("PILOT_MAJOR_MIN_VOLUME_24H", 5_000_000),
  // Plafond de mise par position en mode RÉEL (décision David 2026-08-24,
  // réévalué 2026-08-25) : le sizing satsmonkes par classe (500/1000/2000$) est
  // calibré pour un capital 5-10k$. Avec 13.29 SOL il fallait un sizing RELATIF
  // → cap 335$ (3 positions, gas ~3% du cycle, plancher de rentabilité ~300$).
  // Avec 44.2 SOL (top-up David 25/08) le cap remonte à 500$ = la classe
  // exploratoire (les pools meme tradees) ; la garde 80% reste le plafond réel
  // du book (≈ 35 SOL déployés max). Le PAPER garde le sizing satsmonkes pur.
  realPositionUsdCap: num("REAL_POSITION_USD_CAP", 500),
  // Cooldown de ré-ouverture par token après TOUT close réel (validé David
  // 2026-08-24) : indépendant du volume — la blacklist vol (100k$) ne couvre
  // pas les dumps en cours, et le cron open:paper ré-ouvrirait le même token
  // dans l'heure qui suit un close (leçon omo : 6 ré-ouvertures en 24h).
  // Le token reste interdit de ré-entrée cette durée même s'il est toujours
  // top du scan ; la blacklist 48h vol prend le relais si le volume meurt.
  tokenReopenCooldownHours: num("TOKEN_REOPEN_COOLDOWN_HOURS", 6),
  // Sweep des résidus post-close (leçon omo 24/08 : le gain marqué n'est
  // réalisé qu'en cash — un résidu token peut dumper -41% en une nuit).
  // Après un close, les tokens résiduels du wallet (hors positions ouvertes)
  // sont swappés en SOL si leur valeur ≥ RESIDUE_SWAP_MIN_USD.
  residueSwapMinUsd: num("RESIDUE_SWAP_MIN_USD", 15),
  residueSwapSlippageBps: num("RESIDUE_SWAP_SLIPPAGE_BPS", 500), // 5 % max
  residueSwapCooldownMin: num("RESIDUE_SWAP_COOLDOWN_MIN", 30), // par token

  // Couverture de dump typée (playbook Tiagogo/MeteoraFR) : le target dépend du
  // profil du token — shitcoin récent pump.fun → -90%, token établi → -60/-70%.
  dipTargetRisky: num("DIP_TARGET_RISKY", 0.9),
  dipTargetSafe: num("DIP_TARGET_SAFE", 0.65),
  dipTargetRunner: num("DIP_TARGET_RUNNER", 0.8),
  runnerMinVolume24h: num("RUNNER_MIN_VOLUME_24H", 500_000),
  dipRiskyAgeDays: num("DIP_RISKY_AGE_DAYS", 7),
  maxDipBins: num("MAX_DIP_BINS", 400),
  // Volume 24h min pour les pools bidask-dip (Tiagogo : "volume 24h > 1-2M
  // minimum" — l'échelle anti-dump compte sur les frais dynamiques des gros
  // volumes ; un pool à petit volume = capital immobilisé sans frais).
  minVolume24hBidask: num("MIN_VOLUME_24H_BIDASK", 250_000),
  // Entrée sur rebond : n'ouvrir une échelle bidask-dip que si le prix est déjà
  // ≥ ce drawdown sous son high 24h ("rentrer sur les rebonds après gros dumps").
  minDipDrawdown: num("MIN_DIP_DRAWDOWN", 0.3),
  // Veto RSI (LP Army academy 2026-08-25) : pas d'échelle anti-dump quand le
  // RSI(7, daily) est ≥ ce seuil — un RSI surachat APRÈS un dump ≥ 30% signale
  // un blow-off top (pump verticale), la pire configuration pour une échelle.
  rsiMaxEntryBidask: num("RSI_MAX_ENTRY_BIDASK", 70),
  // L4-A (pivot pur, 2026-08-29) : filtre de TENDANCE sur le scan — ne pas
  // ouvrir sur un token en tendance baissière CONFIRMÉE (drift 24h < 0 ET
  // RSI(7) en baisse ET prix < MA7) = profil de dump mortel (−50/−68 %).
  // ⚠️ SHADOW par défaut : le filtre LOGGE ses rejets (signal ⚠️ shadow L4-A),
  // il ne bloque AUCUNE ouverture → 0 fee perdue (contrainte David 29/08 :
  // la collecte des fees est le moteur du bot, les specs L4 ne doivent pas la
  // sacrifier). Veto = TREND_FILTER_SHADOW=false, uniquement après preuve par
  // rejeu que les pools rejetées avaient un net négatif (scripts/trend-replay.ts).
  trendFilterEnabled: bool("TREND_FILTER_ENABLED", true),
  trendFilterShadow: bool("TREND_FILTER_SHADOW", true),
  // Diversification : max 1 position par token (les 3× ANSEM-SOL étaient 3 pools
  // du même token — risque corrélé zap-out, contre le playbook 6-7 positions).
  maxPositionsPerToken: num("MAX_POSITIONS_PER_TOKEN", 1),

  // Exit Bollinger (Tiagogo : cassure de la Bollinger haute en 15 min → sortie).
  // Bougies 15 min construites depuis les marks du bot (monitor 15 min).
  bollingerExitEnabled: bool("BOLLINGER_EXIT_ENABLED", true),
  bollingerPeriod: num("BOLLINGER_PERIOD", 20),
  bollingerStd: num("BOLLINGER_STD", 2),
  bollingerMinSamples: num("BOLLINGER_MIN_SAMPLES", 20),

  // Playbook quick in & out (Tikz1070, MeteoraFR) : entrée = spike de volume
  // ≥ 30K$/min (≈ 900K$/30min) sur un pool RÉCENT (nouveau pool = edge, détection
  // tôt) à frais élevés, position SERRÉE, sortie rapide (spike essoufflé ou
  // OOR → pull, style salarycat). Les pools candidats passent les filtres
  // d'âge/TVL/volatilité — la porte d'entrée EST le spike 30m.
  quickMinVolume30m: num("QUICK_MIN_VOLUME_30M", 900_000), // 30K$/min × 30 min
  quickMaxPoolAgeDays: num("QUICK_MAX_POOL_AGE_DAYS", 2), // « nouveau pool »
  quickMinFeeTvlRatio30m: num("QUICK_MIN_FEE_TVL_30M", 0.02), // % fees/TVL sur 30m (frais qui tournent)
  quickVolumeFadeFactor: num("QUICK_VOLUME_FADE_FACTOR", 0.5), // sortie si vol 30m < 50% du seuil

  // Exit « cooling off » (RocketScan, 2026-08-23) : le post sort quand le
  // momentum refroidit (colonne running → cooling off) — on n'avait que le
  // feeDecay (fees du pool). Complément direct : déclin du DELTA de volume
  // entre observations (pool_scans 5 min + accel_observations 60 s) — le
  // volume de l'intervalle courant < COOLING_RATIO × pic des dernières
  // COOLING_LOOKBACK_MIN minutes = le momentum meurt → exit topblast (sans
  // garde : « fast in fast out ») et bidask-dip (garde anti-verrouillage de
  // perte — leçon Bollinger 2026-08-18 : ne pas vendre au creux d'un pump).
  coolingExitEnabled: bool("COOLING_EXIT_ENABLED", true),
  coolingRatio: num("COOLING_RATIO", 0.4),
  coolingLookbackMin: num("COOLING_LOOKBACK_MIN", 30),
  coolingMinPeakDeltaPerMin: num("COOLING_MIN_PEAK_DELTA_PER_MIN", 10_000),
  coolingMaxLossBidask: num("COOLING_MAX_LOSS_BIDASK", 0.15),
  // Refroidissement SOUTENU (correction 2026-08-23) : nombre d'intervalles
  // CONSÉCUTIFS sous le seuil requis pour sortir — à la cadence accel 60 s un
  // seul intervalle sans trade est normal. 2 = ≥ 2 min à 60 s / ≥ 10 min à 5 min.
  coolingConsecutive: num("COOLING_CONSECUTIVE", 2),
  // Deadband anti-bruit du recovery-exit (correction 2026-08-23 20:06) : une
  // position FLAT (marks oscillant autour de 0 $ par poussière de rounding)
  // déclenchait « recovery-exit PnL 0.0$ au rebond » — le « sous l'eau au mark
  // précédent » comptait -0,0001 $ comme sous l'eau. EPS = perte minimale
  // RÉELLE du mark précédent pour être considéré sous l'eau (paper et réel).
  recoveryEpsUsd: num("RECOVERY_EPS_USD", 1),

  // Dynamic fee en surtension (playbook gud, 2026-08-24) : « le dynamic fee a
  // fait le travail » — pendant le dump CATE il a dépassé 1% (≈ 2× la base)
  // EXACTEMENT quand le volume était vertical : la fenêtre où les fees paient
  // l'IL. Signal « ⚡ » au scan (info, sans impact score) + GARDE d'exit :
  // ne pas sortir (cooling-off / recovery-exit) sur bidask-dip pendant la
  // surtension — « I didn't touch it, the position was built for this ».
  dynamicFeeSurgeEnabled: bool("DYNAMIC_FEE_SURGE_ENABLED", true),
  dynamicFeeSurgeMult: num("DYNAMIC_FEE_SURGE_MULT", 2), // × base_fee_pct requis
  dynamicFeeSurgeMinAbs: num("DYNAMIC_FEE_SURGE_MIN_ABS", 0.5), // % absolu min (fees matérielles)

  // Blacklist post-close (playbook gud, 2026-08-24) : « dead chart = dead
  // position » — « fees only print when people are trading ». Après un close,
  // si le volume 24h du pool est sous le seuil, le token est blacklisté
  // POST_CLOSE_BLACKLIST_HOURS : on ne ré-entre pas sur un chart mort (leçon
  // omo 23-24/08 : 6 ré-ouvertures sur le même token en 24 h).
  postCloseBlacklistEnabled: bool("POST_CLOSE_BLACKLIST_ENABLED", true),
  postCloseVolMin24h: num("POST_CLOSE_VOL_MIN_24H", 100_000), // vol 24h min au close
  postCloseBlacklistHours: num("POST_CLOSE_BLACKLIST_HOURS", 48),

  // Radar « pool neuve qui chauffe » (RocketScan, 2026-08-23) : le post trie
  // par date de création et chasse le pool < 24 h qui chauffe immédiatement
  // (>50k$/5min). Notre topblast exige un spike ≥ 30k$/min — la variante
  // radar couvre la fenêtre D'AVANT le spike (vol 30m élevé sans porte
  // topblast) — « voir tôt ≠ entrer tôt », jamais en auto.
  radarNewPoolMaxAgeHours: num("RADAR_NEWPOOL_MAX_AGE_HOURS", 24),
  radarNewPoolMinVol30m: num("RADAR_NEWPOOL_MIN_VOL_30M", 300_000),

  // Monitor accéléré (RocketScan, 2026-08-23) : le post rafraîchit toutes les
  // 5 s, nos scans à 5 min / marks à 15 min — le seul vrai gap structurel est
  // le TIMING. Le monitor accéléré (60 s) surveille les pools CHAUDES (top N
  // par score du dernier scan) : enregistre leur volume (accel_observations →
  // deltas 60 s) et marque les positions paper ouvertes → l'exit
  // « cooling off » se déclenche en ≤ 1 min au lieu de 5.
  accelMonitorTopN: num("ACCEL_MONITOR_TOP_N", 5),
  accelMonitorIntervalS: num("ACCEL_MONITOR_INTERVAL_S", 60),

  // ♻️ Résurrection (Nowload 2026-08-25 — « LP sniping » ; complète HALO) :
  // « an old forgotten token suddenly rising from the dead » / « a narrative
  // unexpectedly regaining attention » — vieux token (> QUICK_MAX_POOL_AGE_DAYS,
  // hors fenêtre topblast) en spike de volume SANS drawdown ≥ 30 % (le prix
  // n'est pas dans un dump : la porte bidask-dip ne s'applique pas). Le post
  // entre en SPOT one-side SOL large (~70 bins ≈ notre clamp 69) quand le
  // volume explose et sort quand le momentum refroidit. Même plancher de spike
  // que le topblast (30k$/min). STRATÉGIE OUVRABLE (décision David 2026-08-25
  // — « le bot fait le choix des meilleures profits ») : mêmes gardes que le
  // reste (cap 335$, solde 80 %, 1/token, Y-only, exits auto) + garde de
  // fraîcheur du spike à l'ouverture (open-paper lit le dernier scan ≤
  // OPEN_MAX_SCAN_AGE_MIN et revérifie le vol 30m — pas d'entrée zombie).
  resurrectionMinVol30m: num("RESURRECTION_MIN_VOL_30M", 900_000),
  // Fraîcheur du scan pour l'OUVERTURE (audit 2026-08-25, post Nowload) :
  // open:paper lit le dernier scan (pool_scans, écrit */5 par le monitor) au
  // lieu de re-scanner — un scan plus vieux que ce seuil bloque l'ouverture
  // (les fenêtres de spike durent des minutes, pas des heures).
  openMaxScanAgeMin: num("OPEN_MAX_SCAN_AGE_MIN", 10),

  // Astuce « trending court » (DucatelRomain03, 2026-08-17) : sur GMGN, le
  // filtre Trending 5 min + Volume ≥ 50k (≈ 10k$/min) sert à VOIR tôt les
  // tokens qui démarrent, pas à entrer tôt. Proxy DLMM : delta de volume_24h
  // entre deux scans rapprochés (= volume échangé pendant l'intervalle) →
  // signal « ⚡ trending court » sans dépendre des fenêtres fixes de l'API
  // (30m/1h). Avec un scan toutes les 5 min, le delta mesure ~5 min de volume.
  spikeMinDeltaPerMin: num("SPIKE_MIN_DELTA_PER_MIN", 10_000), // 10k$/min (GMGN : 50k/5min)
  // Leçon anti-rug (GMGN : « 0,8 de fees = rug, tout est fait artificiellement ») :
  // un gros volume qui ne génère quasi pas de frais = volume wash/artificiel.
  washMinVolume24h: num("WASH_MIN_VOLUME_24H", 250_000), // palier « gros volume » (GMGN : 250k)
  // Radar early (« voir tôt ≠ entrer tôt ») : pools jeunes qui démarrent en
  // volume mais ne passent pas encore les filtres d'entrée → surveillés au
  // dashboard pour analyse, jamais ouverts automatiquement.
  earlyMaxPoolAgeDays: num("EARLY_MAX_POOL_AGE_DAYS", 3),

  // Playbook fee printers (0xmiir, 2026-08-16) : les meilleurs encaisseurs de
  // frais du marché (ANSEM/MANLET/TOAD/CATE) font 0.5-2.5% de fees/TVL 24h avec
  // une volatilité extrême — le plafond σ (60%/j, antérieur au playbook
  // bidask-dip) les EXCLUAIT du scan. Un pool à gros volume + gros ratio de
  // frais passe le plafond : l'échelle anti-dump + le filtre drawdown ≥ 30%
  // (entrée sur rebond) sont les protections.
  minFeeTvlFeePrinter: num("MIN_FEE_TVL_FEEPRINTER", 0.5), // % fees/TVL 24h min
  watchlistTokens: str("WATCHLIST_TOKENS", "ANSEM,MANLET,TOAD,CATE"), // watchlist 0xmiir
  migrationMinVolume24h: num("MIGRATION_MIN_VOLUME_24H", 5_000_000), // « 5M+ volume sur le DLMM » (0xmiir)
  // Top blast (setup 1, validé David 2026-08-18) : la stratégie spike du bot,
  // single-sided SOL, range 10-15 bins au total — « tu es présent pendant la
  // première jambe haussière » (satsmonkes). Absorbe l'ancien quick-inout
  // (Tikz : même porte d'entrée spike ≥ 30K$/min + pool récent + fees, sortie
  // rapide). Cap de slots dédié : le playbook twitchy ne doit pas cannibaliser
  // le book (bidask-dip / fee printers = le cœur).
  maxTopblastPositions: num("MAX_TOPBLAST_POSITIONS", 2),

  // Playbook satsmonkes (setup 2, 2026-08-18) : ancre Fibonacci du bidask-dip.
  // Au lieu d'un % de dump fixe, la range est ancrée sur la STRUCTURE — zone
  // 0.5 → 0.786 du retracement du swing (ATH → low majeur) sur l'OHLCV dispo :
  // « tu déploies à travers toute la zone où le marché réagit statistiquement,
  // là où la majorité des buyers ré-entrent ». Le % de couverture découle du
  // swing, pas d'un présupposé. Fallback silencieux sur dipTarget si le swing
  // est trop petit (token sans structure) ou si le prix a déjà traversé la zone.
  satsFibEnabled: bool("SATS_FIB_ENABLED", true),
  satsFibZoneLo: num("SATS_FIB_ZONE_LO", 0.5), // bord haut de la zone (retracement 0 = ATH)
  satsFibZoneHi: num("SATS_FIB_ZONE_HI", 0.786), // bord bas (1 = low du swing)
  satsFibMinSwing: num("SATS_FIB_MIN_SWING", 0.2), // amplitude min high/low (20%) pour un swing valide
  // Signal « flip candidat » (playbook satsmonkes, setup 4, 2026-08-18) :
  // DÉTECTION SEULE. Sur une position bidask-dip en accumulation, quand la
  // structure montre les premiers signes de retournement (pas de nouveau low,
  // premier higher low), satsmonkes INVERSE la range au-dessus du prix pour
  // distribuer à la reprise. Ici on ne fait que SIGNALER (event + Telegram) —
  // l'exécution du flip reste une décision humaine (paper-first, rollout
  // approuvé). Cooldown par position pour éviter le spam.
  satsFlipSignalEnabled: bool("SATS_FLIP_SIGNAL_ENABLED", true),
  satsFlipLookback: num("SATS_FLIP_LOOKBACK", 6), // marks considérés (~90 min à 15 min/scan)
  satsFlipCooldownHours: num("SATS_FLIP_COOLDOWN_HOURS", 6), // 1 signal max / position / fenêtre
  // Exécution du flip en paper (setup 4, validé David 2026-08-18) : quand la
  // structure se retourne (higher low + rebond) sur une bidask-dip avec un bag
  // partiel, la position est RE-PROJETÉE single-sided token AU-DESSUS du prix —
  // le moteur d'accumulation devient un moteur de distribution (fees des deux
  // côtés). Paper-first : mesurable, réversible. Désactivé = signal seul.
  satsFlipExecute: bool("SATS_FLIP_EXECUTE", true),
  satsFlipMinTokenShare: num("SATS_FLIP_MIN_TOKEN_SHARE", 0.2), // bag ≥ 20% en token avant de flipper
  // Sizing par classe (satsmonkes : « la taille est inverse à la volatilité et
  // inverse au gap de conviction ») : exploratoire petit (memecoin inconnu),
  // conviction moyen (établi), majors gros (blue chip / gros TVL+volume).
  // Remplace le dépôt fixe DEPOSIT_USD_PER_POSITION quand activé.
  satsSizingEnabled: bool("SATS_SIZING_ENABLED", true),
  satsSizeExploratoryUsd: num("SATS_SIZE_EXPLORATORY_USD", 500),
  satsSizeConvictionUsd: num("SATS_SIZE_CONVICTION_USD", 1_000),
  satsSizeMajorUsd: num("SATS_SIZE_MAJOR_USD", 2_000),
  satsMajorMinTvl: num("SATS_MAJOR_MIN_TVL", 500_000),
  satsMajorMinVolume24h: num("SATS_MAJOR_MIN_VOLUME_24H", 5_000_000),
  satsExploratoryMaxAgeDays: num("SATS_EXPLORATORY_MAX_AGE_DAYS", 7),

  // Apprentissage (outcome reviews + tuner)
  tuneMinSamples: num("TUNE_MIN_SAMPLES", 10),
  tuneMinHoursBetween: num("TUNE_MIN_HOURS_BETWEEN", 24),
  weeklyReviewDays: num("WEEKLY_REVIEW_DAYS", 7),

  // Dashboard
  dashboardPort: num("DASHBOARD_PORT", 4001),
  dashboardLive: bool("DASHBOARD_LIVE", true),
  dashboardHost: str("DASHBOARD_HOST", "0.0.0.0"),

  // Intervalle monitor (minutes)
  monitorIntervalMin: num("MONITOR_INTERVAL_MIN", 15),
};

/** Garde d'exécution : interdit tout passage en réel sauf config explicite. */
export function assertPaperOnly(action: string): void {
  if (!config.realMode || config.realConfirm !== "CONFIRMED-REAL-MODE") {
    throw new Error(
      `[EXECUTION GUARD] ${action} est BLOQUÉ : mode réel non confirmé. ` +
        `Le bot est PAPER ONLY. Pour activer le réel (DÉCONSEILLÉ en prod sans revue), ` +
        `il faut REAL_MODE=true ET REAL_CONFIRM=CONFIRMED-REAL-MODE dans .env.`
    );
  }
}
