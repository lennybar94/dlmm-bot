# Revue de l'adapter réel DLMM — 21/08/2026

Objet : évaluation de `src/real.ts` avant tout déploiement de capital réel.
Contexte : David envisage 5 000 $ sur le DLMM bot. SAFETY.md exige une revue
avant fonds. VERDICT initial : le mode réel était un squelette déconnecté.

## État après implémentation (21/08, commit local en attente)

Construit et vérifié (tsc 0 erreur, smoke test lecture seule mainnet OK) :
- **real.ts réécrit** : montants via la MÊME math que le paper (buildLiquidity +
  presets + depositForPool), convertis en lamports avec les decimals réels des
  deux tokens (Data API puis fallback RPC getParsedAccountInfo) ; oneSided
  respecté (topblast) ; StrategyType depuis preset.sdkStrategy ; range on-chain
  par structure (bidask-dip SOUS le prix, bidask-flip AU-DESSUS, autres
  symétriques) ; priority fee + retry (3 essais) ; garde montants nuls/négatifs.
- **Fermeture/claim** : `realClosePosition` (removeLiquidity bps + claim dans la
  même tx) et `realClaimRewards` — le kill-switch manuel existe.
- **Table `real_positions`** (db.ts) : persistance ouverture (pubkey, sig, dep,
  amounts, range) + statut closed.
- **Branchement** : scripts/open-paper.ts — si REAL_MODE=true → realOpenPosition
  + enregistrement real_positions ; sinon paper (inchangé). npm run real:open /
  real:close.
- Smoke test : math sur pool réel KIRK-SOL (500 $ → 2,68 SOL + 239k KIRK),
  decimals RPC (SOL 9 / KIRK 6), lecture positions SDK (0 position wallet
  jetable) — tout OK. Aucune transaction envoyée.

RESTE À FAIRE avant tout $ réel (SAFETY.md, décision humaine à chaque étape) :
1. Wallet Solana dédié + financement (SOL gas + USDC/SOL)
2. Test devnet (RPC devnet + faucet) — le cluster est en dur
   "mainnet-beta" dans real.ts (paramétrer via config pour devnet)
3. Shadow : 1 position réelle minuscule (50-100 $) en parallèle du paper
4. Pilote : cap 500-1 000 $, surveillance 7 j, kill-switch = npm run real:close
5. Scale 5 000 $ selon sizing par classe
6. V2 : auto-exits réels (recovery/bollinger/hard-stop) branchés sur le monitor

## Findings d'origine (résolus par l'implémentation ci-dessus)

### BLOQUANT 1 — L'adapter n'est JAMAIS appelé
`realOpenPosition`/`realGetPositions` n'ont aucun appelant (grep : 0 import de
real.ts dans src/ et scripts/). Le flux complet (open-paper.ts → paper.ts,
monitor, exits, claim) est 100 % paper : même avec REAL_MODE=true dans .env,
le bot continuerait de trader en paper. Le mode réel est du code mort.

### BLOQUANT 2 — Pas de fermeture, pas de claim, pas de retrait
real.ts ne contient QUE `realOpenPosition` + `realGetPositions`. Rien pour
`removeLiquidity` / `claimAllRewardsByPosition` / fermer une position.
Conséquence : en réel, les positions s'ouvriraient sans JAMAIS pouvoir être
fermées par le bot (recovery-exit, bollinger, hard-stop, flip = inexistants
en réel). Capital bloqué dans les LP.

### BLOQUANT 3 — Bug de montants (token X supposé à 1 $)
```js
amountY = floor((yUsd * 10**tokenYDecimals) / pricePerToken)
amountX = floor(yUsd * 10**tokenXDecimals)   // ← suppose price(X) = 1 $
```
`amountX` ignore le prix réel du token X. Pour un token à 0,01 $, on dépose
1 % de la valeur voulue en X → position déséquilibrée de 100×. Seul cas OK :
token X = stablecoin à ~1 $ (USDC). La plupart des pools suivis (SOLPUMP-SOL,
BULLSHIT-SOL…) ont un token X ≠ 1 $.

### BLOQUANT 4 — One-sided ignoré (topblast notamment)
`yUsd = depositUsd / 2` : 50/50 en dur. La stratégie topblast (single-sided
SOL) et les shapes one-sided du paper ne sont pas répliquées → shape réelle
≠ shape paper validée.

### BLOQUANT 5 — Mauvais StrategyType
`StrategyType[args.strategyName] ?? StrategyType.Spot` : on passe le NOM du
preset (« bidask-dip », « topblast ») comme clé de StrategyType → undefined →
fallback **Spot**. Une bidask-dip réelle s'ouvrirait en shape Spot, pas BidAsk.

### IMPORTANT 6 — Aucune persistance des positions réelles
`positionPubKey = Keypair.generate()` (clé aléatoire), signature renvoyée,
RIEN stocké. Le monitor/dashboard ne peuvent pas suivre la position réelle
(mark-to-market, PnL, exits). `realGetPositions` ne remonte que adresses +
bin ids (pas de montants, pas de valeur).

### Mineurs
- Pas de gestion slippage ni priority fee ni retry (sendAndConfirmTransaction
  brut) — congestion Solana = tx perdue sans reprise.
- Decimals passés par l'appelant sans validation (dépend de la Data API).
- Pool créé avec cluster "mainnet-beta" en dur — devnet impossible sans
  modifier le code (pourtant requis par SAFETY.md étape 1).

## Ce qu'il faut construire (ordre)
1. `realClosePosition` (removeLiquidity + claim), `realClaimRewards`,
   `realGetPositionValue` (Data API positions) — avec retry + priority fee.
2. Corriger la math des montants : prix réel des deux tokens
   (`/pools/{addr}` current_price), respect du one-sided (hint.oneSided),
   dépôt total = depositUsd (pas 50/50 en dur).
3. Mapper preset → StrategyType correct (bidask-dip→BidAsk, topblast→Spot
   oneSided, curve→Curve…).
4. Table `real_positions` (pubkey, pool, strategy, deposit, opened_at) +
   branchement REAL_MODE dans open-paper.ts / monitor.ts / exits.
5. Test devnet (RPC + faucet) → shadow (1 position réelle minuscule) →
   pilote (cap) → scale. Décision humaine à chaque étape (SAFETY.md).

## Estimation
~1-2 jours de dev + validations devnet/shadow avant le premier $ réel.
Le paper continue de tourner pendant ce temps (échantillon qui s'allonge).
