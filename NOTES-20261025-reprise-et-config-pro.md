# Reprise du bot DLMM + config « trader pro » — analyse du 25/10/2026

Contexte : bot arrêté et archivé le 20/10 (synthèse Hermes du 25/10). David
envisage de remettre 56,86 SOL sur le wallet Jupiter HsstWQ… et demande
(1) les améliorations pour que le bot devienne rentable, (2) la croissance
journalière qu'on peut espérer, (3) si la config d'un trader pro (divergence
MACD + entrée Fib) répond à la demande.

## 1. Verdict court

1. **Aucune stratégie active ne fait monter le solde tous les jours.** Le seul
   placement qui augmente le solde en SOL chaque jour est le staking liquide
   (JupSOL, JitoSOL…) : ≈ 0,009 à 0,012 SOL/jour sur 56,86 SOL (6-8 %/an,
   taux à revérifier sur jup.ag le jour J).
2. **Le book memes (bidask-dip) ne doit pas être relancé.** Ses pertes sont
   structurelles (échelle SOL sous le prix d'un memecoin = vente de puts) :
   aucun réglage des sorties ne l'a rendu rentable sur 352 closes.
3. **Le code contient encore deux erreurs de mesure** qui faussaient la
   sélection des pools (§2) ; elles sont à corriger avant tout nouveau test.
4. **La config du trader pro ne correspond pas à la demande** : c'est du
   scalping directionnel (perps), pas de l'apport de liquidité. Par
   construction, la stratégie a beaucoup de jours rouges, et son stop très
   serré la rend très sensible aux frais (§4). Elle peut se tester sur papier
   avec `scripts/pro-config-backtest.ts`, sur de vraies données, avant d'y
   mettre un seul SOL.
5. **Plan proposé** : le cœur du capital en staking (croissance quotidienne
   réelle), une petite part (≤ 10 %) pour un satellite actif, et seulement
   après un test papier avec des critères d'arrêt écrits AVANT (§5).

## 2. Ce que dit le code (diagnostic vérifié sur main @ 862955b)

| # | Où | Constat | Effet |
|---|---|---|---|
| 1 | `src/strategies.ts:243-256` + `src/api.ts:185` | L'OHLCV de la Data API renvoie **10 bougies DAILY** (commentaire de `fetchOhlcv`), mais `realizedVolatility` les traite comme des bougies horaires et multiplie par √24. | σ surestimée **×4,9**. Le filtre `MAX_VOL_24H=0.6` rejette en réalité les pools dont la σ dépasse ~12 %/j ; `strategyForVolatility` (seuils 0,1/0,3) classe presque tout en « high » → bidask-dip ; les largeurs de range (`binsPerSideForVolatility`) sont gonflées d'autant. Le bug était identifié par les backtests DLMM-Claude (synthèse §8) mais **n'est pas corrigé sur main**. |
| 2 | `src/strategies.ts:424-427`, `src/scanner.ts:326,391` | `drawdownFromHigh` est documentée « vs high des 24 dernières heures (bougies 1h) », mais elle reçoit les mêmes 10 bougies daily. | La porte « rebond » (`MIN_DIP_DRAWDOWN=0.3`) veut dire en réalité : prix 30 % sous son plus haut à **10 jours**. On entrait sur des couteaux qui tombent, pas sur des rebonds intraday. |
| 3 | `src/scanner.ts:101` (score), `src/api.ts:88` | Le score se fonde sur l'APR des frais, **sans coût de volatilité**. | Les pools les plus volatils ont l'APR affichée la plus haute… et la perte LVR (≈ σ²/8 par jour, ×concentration) la plus forte. Les backtests DLMM-Claude ont mesuré que la porte frais/LVR ≥ 2,5 était **le levier n° 1** (supprimée : −6,2 SOL à l'entraînement, −2,6 SOL au test). Elle n'existe pas dans ce code. |
| 4 | `src/scanner.ts:362` | Le filtre de tendance L4-A est en `TREND_FILTER_SHADOW=true` par défaut : il écrit dans le log mais ne bloque jamais une entrée. | Rien n'empêchait d'ouvrir une échelle sur une tendance baissière confirmée. |
| 5 | Univers | Memecoins (81 % finissent à −90 % de l'ATH, Coin Metrics ; 98,6 % des pump.fun = rug ou pump & dump, Solidus — cf. synthèse §5). | Les frais tiennent, puis le dump traverse la range (`NOTES-20260827-value-stop.md` : pertes « binaires »). |

Ce qui a **marché** et mérite d'être réutilisé : les sorties recovery-exit
(+207 $, 100 % gagnantes), cooling-off (+130 $), le take-profit 10 $
(`lab/NOTES-20260928-sweep.md`), la comptabilité en SOL (`sol_total`), les
gardes d'argent réel (double variable, plancher, pause étanche).

## 3. Combien espérer (chiffres, pas promesses)

Base : 56,86 SOL. Tout est exprimé **en SOL** : en dollars, le solde suit le
prix du SOL, qui peut baisser n'importe quel jour.

| Option | Croissance | Jours verts (en SOL) | Ce qui peut mal tourner |
|---|---|---|---|
| Staking liquide (JupSOL/JitoSOL), APY 6-8 % | **0,009-0,012 SOL/jour**, 0,27-0,36 SOL/mois, 3,4-4,6 SOL/an | ~100 % | Risque smart contract / décote du LST ; la valeur en $ suit le SOL |
| Ancien bot, book memes | Historique : **−441 $ en 28 jours** (≈ −0,25 %/jour). Meilleure fenêtre (14→21/09) : +0,6 à +0,85 %/jour, puis régime cassé | non | Queue −90 % des memecoins, incidents d'exécution |
| DLMM « majors » (SOL-USDC, LST-SOL…) avec porte LVR | **Inconnu, à mesurer.** Objectif crédible : battre le staking de quelques points **par an** | non | IL/LVR, rebalancing coûteux (reynarenatan : le rebalancing s'effondre à 0,5 % de coût) |
| Config trader pro (perps) | **Inconnu, à mesurer.** Coûts mécaniques : 0,6 à 1,5 R par trade (§4) | non, par construction | Levier, liquidation, séries de pertes |

Repère de bon sens : 0,3 %/jour composé = ×3 par an ; 1 %/jour = ×38 par an.
Une stratégie qui annonce ce genre de rythme « tous les jours » cache un
risque de queue (c'est exactement ce qu'a fait le book memes : 8 jours verts
d'affilée, puis le régime a cassé).

## 4. La config du trader pro

Texte reçu : divergence MACD(12,26,9) en 30s-5m (short = prix HH + MACD LH,
long = prix LL + MACD HL), taille +1 par divergence RSI(14) et +1 par
divergence de volume, entrée 1 tick au-delà du 23,6 du Fib local, SL 1 tick
au-delà du 0, TP1 38,2 / TP2 ~66 % du Fib du swing plus large, BE seulement en
profit, S/R du timeframe supérieur, éviter l'ouverture.

**Pourquoi elle ne colle pas à la demande :**

1. **Ce n'est pas un bot DLMM.** C'est du trading directionnel avec stop et
   objectifs. Une position DLMM n'a ni stop ni TP ; il faudrait un autre bot
   (perps Jupiter/Drift ou CEX), un autre flux de données, une autre
   exécution. Le code actuel ne réutilise presque rien.
2. **Les données n'existent pas dans le bot.** La Data API ne donne que
   10 bougies daily ; il faut des bougies 30s-5m (Binance, Birdeye…).
3. **Les frais pèsent très lourd.** « SL 1 tick au-dessus du 0 » sur un
   micro-swing donne un stop très serré. Le moteur, calé sur une volatilité
   type SOL (σ 4 %/jour), mesure un stop médian de **11 bps en 1 min, 19 bps
   en 3 min, 25 bps en 5 min**. Avec ≈ 6 bps de frais + 2 bps de slippage par
   exécution (barème Jupiter Perps ≈ 0,06 % à l'ouverture et à la fermeture,
   à revérifier), un aller-retour coûte 16-20 bps, soit **≈ 1,5 R par trade
   en 1 min et ≈ 0,7 R en 5 min**. La stratégie doit dégager un avantage brut
   au moins égal juste pour finir à zéro. Sur du spot memecoin (30-100 bps
   par côté), c'est impossible.
4. **Beaucoup de jours rouges, par construction.** Un stop serré avec des
   objectifs à 0,6-1,8 R donne un faible taux de réussite (14-23 % dans le
   moteur sur marche aléatoire). Même rentable, une telle stratégie aligne
   des séries de pertes : c'est l'inverse de « vert tous les jours ».
5. **Une partie de la config n'est pas codable telle quelle** : « S/R HTF
   pour le contexte », la taille d'une unité, la définition d'un pivot. Les
   choix faits sont écrits en tête du script ; changer ces choix peut changer
   les résultats du tout au tout. Aucun historique de résultats du trader
   n'accompagne la config : avant d'y croire, demander son relevé (nombre de
   trades, P&L net de frais, sur plusieurs mois).

**Ce que le script fait** (`scripts/pro-config-backtest.ts`,
`npm run backtest:pro`) :

- bougies Binance perps (1m agrégées en 3m/5m) ou spot 1s (pour le 30 s),
  ou un CSV ;
- les règles ci-dessus, sans regard vers le futur (un pivot n'est connu que
  `PIVOT` barres après coup) ;
- exécution pessimiste (si une bougie touche le SL et un TP, le SL passe en
  premier ; un stop qui gappe est servi au pire prix), frais et slippage à
  chaque exécution, levier plafonné ;
- comparaison avec/sans filtre S/R HTF, résultats par moitié (la 2e moitié
  sert de contrôle hors échantillon), part de jours verts, pire jour, plus
  longue série rouge.

**Contrôle du moteur** (`--synthetic`, marche aléatoire, 4 graines, sans
frais) : ≈ 0 R par trade en 1 min (−0,02 à −0,03 R), légèrement négatif en
5 min (−0,15 R en moyenne, effet des hypothèses pessimistes). Le moteur ne
fabrique pas d'avantage là où il n'y en a pas. **Ce ne sont pas des résultats
de la stratégie** : les vrais chiffres viennent du run sur données réelles.

⚠️ Le réseau de la session d'analyse bloquait Binance, Bybit, OKX,
GeckoTerminal et la Data API Meteora : le backtest sur données réelles reste
à lancer (sur le serveur, ou après avoir autorisé `fapi.binance.com` et
`data-api.binance.vision` dans les réglages réseau de l'environnement).

```bash
npm run backtest:pro -- --symbol=SOLUSDT --days=180 --tf=1m,3m,5m --out=data/pro-sol.json
npm run backtest:pro -- --base=1s --days=14 --tf=30s,1m          # le 30 s
npm run backtest:pro -- --fee-bps=30 --slip-bps=50 ...           # profil spot DEX memecoin
```

**Critères GO / NO-GO, écrits avant le run** (sur SOL perps 180 j, frais
réels, avec ET sans S/R HTF, retenir la meilleure des deux mais l'exiger sur
les DEUX moitiés) :

- ≥ 200 trades ; profit factor ≥ 1,3 ; R moyen ≥ +0,15 ; DD max ≤ 15 % ;
- sinon NO-GO définitif. Pas de réglage des paramètres pour « sauver » un
  NO-GO : chaque réglage testé est un essai de plus, et à force d'essais un
  paramétrage finit par gagner par hasard.

## 5. Plan proposé

**Aujourd'hui (0 risque d'exécution)**
- Ne pas mettre les 56,86 SOL sur HsstWQ… : c'est le **hot wallet du bot**,
  dont la clé privée vivait en clair dans le `.env` du serveur (et dans
  l'archive du 20/10). Aucune clé n'apparaît dans l'historique git (vérifié :
  les longues chaînes sont des hashes du lockfile et des signatures de tx),
  mais une clé sur un serveur reste une clé exposée.
- Cœur (≥ 90 %, ~51 SOL) : staking liquide depuis le Ledger (via Phantom ou Solflare + Ledger
  connecté à Jupiter). C'est la seule option qui fait monter le solde en SOL
  tous les jours : ≈ +0,01 SOL/jour.

**Semaines 1-4 (papier uniquement)**
- A. Lancer le backtest de la config pro sur données réelles → verdict
  GO/NO-GO selon §4.
- B. Si on veut garder le DLMM : corriger §2-1 et §2-2, ajouter la porte
  frais/LVR (§2-3), restreindre l'univers aux majors et aux paires LST-SOL,
  abandonner bidask-dip memes et topblast, garder les sorties qui ont
  marché. Tourner en lab jusqu'à **≥ 100 closes**. GO si le gain en SOL
  dépasse le staking sur la même période, frais inclus, sur les deux moitiés.

**Ensuite seulement**
- Satellite réel ≤ 10 % (~5 SOL), plafond en dur, arrêt automatique à −10 %
  du satellite (−0,5 SOL). Décision datée de David à chaque palier, comme
  avant.

## 6. Améliorations de code proposées (à implémenter sur GO)

1. `realizedVolatility` : σ daily = écart-type des log-returns daily, sans
   √24 ; idéalement σ intraday depuis une source minute.
2. `drawdownFromHigh` : renommer en drawdown à 10 jours, ou alimenter avec
   de vraies bougies 1h ; revoir `MIN_DIP_DRAWDOWN` en conséquence.
3. Porte LVR dans le scan : `fees_jour / (σ_jour² / 8 × concentration) ≥ 2,5`
   (seuil mesuré par les backtests DLMM-Claude), en veto, pas en badge.
4. Presets : retirer bidask-dip/topblast/resurrect de l'ouverture auto ;
   garder spot-spread/curve sur majors et LST-SOL.
5. Lab : comparer la stratégie au **staking** (pas à zéro) : un bot qui fait
   +3 %/an en SOL perd de l'argent face à un JupSOL à 7 %.

Pas un conseil financier. Aucune transaction n'a été envoyée, aucun réglage
de prod n'a été modifié.

## 7. Suite du 25/10 — run réel (Hermes) et arbitrages

**Backtest config pro sur données réelles** (lancé par Hermes sur le serveur :
SOLUSDT perps Binance, 180 j, 259 199 bougies 1 m, 28/04→25/10, 6 + 2 bps par
exécution) : PF 0,14 à 0,39 selon le TF, R moyen −0,97 à −2,04, 2 à 19 % de
jours verts, aucune configuration au-dessus de PF 1 sur l'une ou l'autre
moitié. Contrôle sans frais (5 m) : PF 1,02, R +0,01 (1re moitié 1,30,
2e moitié 0,75). **NO-GO définitif** selon les critères du §4 : l'avantage brut
est nul, les frais ne font que rendre la perte visible. Aucun paramètre ne
sera retouché pour « sauver » la config.

**Arbitrages sur les corrections du §6 :**

1. σ : pas de nouvelle source. Les bougies sont daily, donc σ daily direct
   (√24 supprimé). Estimateur : `max(close-to-close, Parkinson)` sur les
   10 bougies, Parkinson = √(moyenne(ln(H/L)²) / (4 ln 2)). Il exploite
   les mèches intraday déjà présentes dans les bougies daily, il est moins
   bruité sur 9 rendements, et prendre le max reste prudent.
2. La porte frais/LVR s'applique à **toutes** les stratégies, y compris
   bidask-dip/topblast/resurrect. Si elle ferme le book memes presque tout
   le temps (fees/TVL médiane ≈ 0,28 %/j contre σ²/8 ≈ 0,5-1,1 %/j pour
   σ = 20-30 %/j), c'est la mesure qui confirme le §1-2, pas un défaut à
   contourner. Pas de baisse du seuil pour rouvrir la porte.
3. Concentration : **pas de multiplicateur**. Tant que le prix est dans la
   range, les frais ET le LVR d'une position croissent tous deux en
   proportion de sa concentration, et le facteur s'annule dans le ratio.
   Le « × concentration » du §2-3 et du §6-3 était une erreur de ma part.
   Porte codée : `R = (fee_tvl_ratio_24h/100 × (1 − protocol_fee_pct/100))
   / (σ_daily² / 8)`. Condition de validité : le seuil 2,5 ne vaut qu'avec
   la formule qui l'a calibré. Reprendre la formule exacte des backtests
   DLMM-Claude (archive `dlmm-claude/`) ; si elle diffère de celle-ci, c'est
   elle qui fait foi, ou le seuil doit être re-mesuré.
4. Corrections 1-2 et règles calibrées dessus (réserve d'Hermes, juste) :
   `MIN_DIP_DRAWDOWN`, `analyzeTrend` et `fibSwingFromCandles` ont été réglés
   sur la fenêtre réelle de 10 jours. On **renomme et on documente** (drawdown
   à 10 j, drift daily, swing 10 j) **sans changer le comportement**. Le book
   memes ne rouvre pas, donc il n'y a rien à recalibrer.
5. Intouchés : recovery-exit, cooling-off, TP 10 $, comptabilité SOL. Le veto
   L4-A garde sa condition de preuve par rejeu avant de bloquer.

**Clé du wallet HsstWQ (archive serveur)** : avant d'effacer la seule copie,
vérifier on-chain que HsstWQ ne détient plus rien : solde SOL, comptes de
jetons, et surtout **aucun compte de position DLMM vivant** (piège de la
close partielle, USDC-SOL #331). Tout reliquat est rapatrié vers le Ledger
d'abord. L'effacement est ensuite irréversible : c'est la décision datée de
David, à écrire de sa main dans le LISEZ-MOI d'archive.

## 8. Porte S1 : la formule DLMM-Claude fait foi (remplace §7-1 et §7-3 pour la porte)

Formule relevée par Hermes dans `dlmm-claude/src/policy.ts` et `config.ts`
(cf. `REPONSE-HERMES-20261025.md`, branche `hermes/reponse-20261025`) :
`R = 2·W·f / σ²`, avec f = fees/TVL 24 h nets du protocole,
W = largeur log effective (on-chain, sinon clamp(9σ, 0,01, 0,25)), et σ =
σ journalier **intraday** sur une fenêtre de 4 h (Σr²/Δt, au moins 12
rendements). Seuils : rMin 2,5 ET rMin1h 2,0, plus un plancher minFeeDaily
de 0,25 %/j.

- Elle se reprend **en bloc, telle quelle** : formule, W, double seuil et
  plancher. La porte `f/(σ²/8)` du §7-3 est retirée.
- Le σ de la porte doit être **le même estimateur intraday 4 h**. Si W n'est
  pas clampé, R = 18·f/σ : un biais sur σ déplace R d'autant. Pour un
  memecoin, le σ daily (close-to-close comme Parkinson) sous-estime le σ
  intraday. R serait alors surestimé et la porte trop permissive, soit le
  mauvais sens d'erreur. Donc pas de σ daily dans cette porte.
- Il n'y a pas besoin de source externe. Le bot enregistre `current_price`
  dans `pool_scans` à chaque scan (5 min), soit 48 rendements en 4 h. On
  porte l'estimateur de DLMM-Claude sur cette série ; une pool sans
  ≥ 12 rendements est refusée. Point d'attention : sur les pools X-USDC,
  `current_price` est exprimé en SOL (bug wNEAR). Les rendements y seraient
  pollués par les mouvements du SOL, il faut donc utiliser le prix natif X/Y.
- Le σ daily direct (√24 supprimé) ne sert qu'aux autres usages. Corriger le
  √24 change `MAX_VOL_24H`, `strategyForVolatility` et
  `binsPerSideForVolatility`, qui ont été calibrés sur le σ gonflé. Pour
  garder un comportement identique, il faut diviser leurs seuils par √24 :
  0,6 → 0,12 ; 0,1/0,3 → 0,02/0,06 ; et multiplier le mapping des bins
  par √24. Les valeurs deviennent honnêtes, le comportement ne bouge pas.
- Destination du code : une branche dédiée avec une PR ouverte, sans merge
  dans main tant que le bot ne redémarre pas. main reste l'état de
  l'archive (décision David).
