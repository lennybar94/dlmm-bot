# Probe 08/09 — distribution de liquidité des bins (inspiration vidéo LP manuel)

## Question
Le LP de la vidéo lit en direct la répartition des bins (les siens vs ceux des autres,
« j'ai un avantage en haut de ma range »). On affirmait « pas de flux de distribution des
bins dans notre pipeline ». VRAI pour la Data API ; FAUX on-chain → probe.

## Résultat (HYPE-SOL #105, pool 81GpCm…n8sA, mainnet, lecture seule)

- SDK @meteora-ag/dlmm expose : getBinArrays, getBinsAroundActiveBin, getBinsBetweenMinAndMaxPrice,
  getBinsBetweenLowerAndUpperBound, getBins, getBinArrayForSwap.
- `getBinsAroundActiveBin(6,6)` : ~150 ms, 1 appel RPC → X/Y par bin autour de l'actif.
- `getBinArrays()` complet : 32 arrays, ~7 s → inutile pour ce besoin.
- Carte obtenue (unités brutes) : bins ≤ -105 = quote pure (~25,5 T lamports Y/bin),
  active -104 charnière (X apparaît : 36,7 T), bins ≥ -103 = token pur. C'est LA distribution
  live de tous les LPs du pool.

## Piège de décodage (re-fait à ne pas repayer)
`xAmount`/`yAmount` arrivent en **chaînes hexadécimales** (BN anchor), pas décimal :
`BigInt('0x'+s)`. Un `.replace` ou `Number(v)` directs cassent ou sortent 0. Montants BRUTS
→ diviser par 10^decimals (Data API token_x/y.decimals).

## Verdict d'implémentation
À faire, mais en DEUX temps et après la phase 2 ws :
1. Signal INFO d'abord (dashboard + notif earlywatch) : masse X au-dessus de notre max_bin
   (« mur en face ») / masse sous le prix (« support »). Zéro exit branché — discipline omo :
   valider la corrélation mur→dump sur quelques semaines avant de piloter une sortie.
2. Gate d'entrée éventuel ensuite (ouvrir une bidask-dip sous un mur massif = vendre dans le
   mur ; préférence range sans barrière).
Crédits RPC négligeables (top 5 pools chaudes × 1 lecture/scan 5 min ≈ 60 req/h).

Ce qu'on NE duplicable PAS et n'a pas d'intérêt ici : le front-running market-cap GMGN
(« une seconde devant Meteora ») — scraping tierce partie, et le retard ne sert que le
spike chasing, stratégie gelée (MAX_TOPBLAST_POSITIONS=0).
