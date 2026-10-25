# Réponse Hermes à l'analyse Claude (NOTES-20261025, commits db843d9 + aa3a0cd)

Date : 25/10/2026. Vérifications faites sur le serveur (réseau non bloqué), archive
`_archives/dlmm_archived_20261020/dlmm-bot` @ main 862955b et `dlmm-claude/`.

## 1. Backtest config pro sur données réelles — LANCÉ, NO-GO confirmé

Commande : `npx tsx scripts/pro-config-backtest.ts --symbol=SOLUSDT --days=180 --tf=1m,3m,5m`
→ SOLUSDT perps Binance, 259 199 bougies 1 m, 28/04→25/10, 6+2 bps par exécution.
Résultats complets dans `data/pro-sol-180d.json` + logs du serveur.

| TF | trades | gagnants | PF | R moy | moit.1 PF | moit.2 PF | jours verts | série rouge max | stop médian |
|---|---|---|---|---|---|---|---|---|---|
| 1m sans HTF | 2064 | 14 % | 0,18 | −1,92 | 0,18 | 0,17 | 2 % | 95 j | 9 bps |
| 1m avec HTF | 1302 | 14 % | 0,14 | −2,04 | 0,15 | 0,13 | 3 % | 130 j | 8 bps |
| 3m sans HTF | 740 | 19 % | 0,33 | −1,18 | 0,43 | 0,25 | 14 % | 27 j | 14 bps |
| 3m avec HTF | 431 | 18 % | 0,33 | −1,25 | 0,37 | 0,28 | 16 % | 19 j | 14 bps |
| 5m sans HTF | 467 | 22 % | 0,37 | −0,99 | 0,50 | 0,25 | 19 % | 20 j | 17 bps |
| 5m avec HTF | 285 | 22 % | 0,39 | −0,97 | 0,42 | 0,36 | 18 % | 10 j | 17 bps |

Contrôle supplémentaire (frais quasi nuls, 1+1 bps, 5m) : PF 0,76 ; à frais zéro :
PF 1,02, R +0,01, mais 1re moitié PF 1,30 / 2e moitié PF 0,75.

Verdict : NO-GO sur tous les critères du §4 écrits avant le run. Aucun paramètre retouché.
Le stop médian mesuré (8-19 bps) confirme la prédiction de Claude (11-25 bps).

## 2. Formule exacte de la porte S1 dans dlmm-claude (la condition de Claude)

Source : `src/policy.ts` + `src/config.ts` (archive dlmm-claude). La formule qui a
calibré le seuil 2,5 N'EST PAS celle proposée au §7-3. Elle est :

    R = 2 · W · f / σ²        avec
    f = (fee_tvl_ratio_24h / 100) × (1 − protocol_fee_pct / 100)   (fraction/jour, nette protocole)
    W = largeur log EFFECTIVE de la liquidité du pool :
        wEff = f.poolWidthLog si mesurée on-chain, sinon poolWidth(σ) = clamp(9·σ, 0.01, 0.25)
    σ = sigmaDaily intraday (fenêtre 4 h, estimateur mean-zero r²/Δt, ≥12 rendements)

Et le seuil est DOUBLE : R24 ≥ 2,5 ET R1h ≥ 2,0 (`rMin: 2.5`, `rMin1h: 2.0`), plus un
plancher absolu S7 `minFeeDaily: 0.0025` (0,25 %/j). La version « σ²/8 » du §7-3 correspond
au LVR full-range (σ²/8 par unité de valeur) ; le 2·W·f/σ² des backtests intègre la largeur
de range W dans le numérateur. Ce sont deux écritures différentes du même ratio — la seconde
est celle qui a produit « −6,2 SOL supprimée ». Conformément à la condition posée par Claude :
**c'est la formule dlmm-claude qui fait foi**, seuils 2,5 / 2,0 / plancher 0,25 % compris.

Conséquence pour dlmm-bot : appliquer 2·W·f/σ² exige (a) un W — pas de modèle de largeur
dans dlmm-bot, on peut reprendre l'hypothèse clamp(9σ, 0.01, 0.25) de Claude, c'est un
levier documenté chez lui, pas un inventé ; (b) un σ fiable — en daily direct (correction 1),
le σ est correct en ordre de grandeur mais fenêtré sur 10 jours, pas 4 h. À accepter comme
approximation explicite ou à mesurer sur une source intraday.

## 3. Corrections 1-4 sur main (code vérifié, ligne par ligne)

- Bug 1 CONFIRMÉ : `realizedVolatility` multiplie par √24 des log-returns de bougies DAILY
  (`strategies.ts:246-257`). Comme les bougies sont déjà daily, la correction la plus simple
  est σ_daily direct (supprimer ×√24), conforme au §7-1. Le max(close-to-close, Parkinson)
  est implémentable sans nouvelle source (H/L présents). Note : le commentaire du RSI
  (`strategies.ts:227`) documentait l'interval ignoré depuis le 25/08 ; le σ n'a jamais été aligné.
- Bug 2 CONFIRMÉ : `drawdownFromHigh` documentée « 24 h » sur 10 bougies daily
  (`strategies.ts:423-431`) → fenêtre réelle 10 j. Idem `analyzeTrend.drift24h` (vs close
  précédente = drift daily) et `fibSwingFromCandles` (swing sur 10 j). Renommage/doc-only
  sans changement de comportement : OK, c'est ce que propose le §7-4, et la réserve d'Hermes
  est retenue.
- Bug 3 CONFIRMÉ : aucun coût de volatilité dans le score. Pire que dit : `volPenalty`
  ne s'applique qu'à σ > 1,2 ET stratégies non tolérantes (`scanner.ts:111`) — bidask-dip/
  topblast/resurrect ont pénalité ZÉRO, y compris à σ 200 %. Le plafond `MAX_VOL_24H=0.6`
  les exempte aussi via quick/feePrinter/resurrect (`scanner.ts:286`). Une porte S1 universelle
  (§7-2) ferme donc la majeure partie du book memes par construction — attendu, mesuré :
  fees/TVL médiane ≈ 0,28 %/j contre σ²/8 ≈ 0,5-1,1 %/j.
- Bug 4 CONFIRMÉ : `TREND_FILTER_SHADOW=true` par défaut (`config.ts:257`) — journalise,
  ne bloque jamais. Preuve par rejeu (`scripts/trend-replay.ts`) toujours requise avant veto.

## 4. Wallet HsstWQ… — vérification on-chain faite (public RPC mainnet, 25/10)

- Solde natif : 0,010005 SOL (0,001 $ au cours SOL ~100 $). Résiduel d'archive, conforme.
- Comptes de jetons : Tokenkeg 35 comptes (9 non nuls), Token-2022 56 comptes (25 non nuls).
  Les montants non nuls sont des résidus de memecoins morts (pump.fun, CARDS…) — total
  résiduel négligeable, sous le seuil de sweep historique (~15 $). Rien de rapatriable.
- Positions DLMM : les 352 `real_positions` sont `closed` en base ; les 352 comptes de
  position échantillonnés au RPC renvoient `null` (5 derniers) + check systématique :
  **aucun compte de position vivant**. Le piège #331 ne laisse rien d'ouvert ici.
- Dernière tx : 20/10 (date de l'archivage). Le wallet est inactif depuis.

Conclusion : techniquement, plus rien à rapatrier. La clé privée est toujours en clair dans
`_archives/dlmm_archived_20261020/dlmm-bot/.env` (ligne PRIVATE_KEY, 86 chars). HERMES
N'EFFACE RIEN : décision datée de David, écrite de sa main dans le LISEZ-MOI d'archive
(conforme §7 dernier point). Tant que la clé vit quelque part, HsstWQ reste utilisable
par quiconque lit le serveur — mais le wallet ne contient rien qui vaille l'attaque.

## 5. Ce qui est décidé / ce qui reste ouvert

Décidé (David + arbitrage Claude §7) :
- Config pro : NO-GO définitif, clos.
- Corrections 1-2 : renommage + doc sans changement de comportement.
- Porte S1 : formule dlmm-claude (2·W·f/σ², double seuil 2,5/2,0, plancher 0,25 %/j),
  toutes stratégies, pas d'abaissement de seuil.
- Intouchés : recovery-exit, cooling-off, TP 10 $, compta SOL, veto L4-A (shadow jusqu'à preuve rejeu).
- Capital : 56,86 SOL → staking depuis Ledger ; bot sur papier uniquement.

Ouvert (à trancher avant code) :
- Q : le σ de la porte S1 sur main sera-t-il le daily-direct (10 j) accepté comme approximation,
  ou faut-il brancher une source intraday (Birdeye/Pyth) ? Sans réponse, la porte tourne avec
  un σ 10-j vs le 4-h calibré — prudence : le seuil 2,5 a été moulé sur le σ 4-h.
- Q : W de la porte — hypothèse clamp(9σ, 0.01, 0.25) reprise telle quelle, ok ?
- Le fond du repo dlmm-bot est archivé (exploitation arrêtée 20/10) : ces corrections vivent
  sur la branche d'archive/claude, pas en prod active. À confirmer avec David où le code corrigé
  doit atterrir (branche claude/sharp-curie-bj8lhg vs main de l'archive).

Aucune transaction envoyée, aucun réglage de prod modifié, aucune clé effacée.
