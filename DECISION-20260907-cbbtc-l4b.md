# Dossier de décision — cbBTC-SOL (pilote L4-B) — verdict 07/09

Position #108 · spot-spread balancée · pilot=1 · ouverte 02/09 04:16
Données : marks réels (cadence 1 min, 6 263 points) + pool Data API, relevés
06/09 13:21 CEST.

## État à l'heure du dossier

| | |
|---|---|
| SOL déployé (refSol) | 5,094 SOL (~500 $ à l'ouverture) |
| Inventaire | 0,00327 cbBTC + 2,502 SOL (balancée ~50/50) |
| Valeur dernière marque | 518,8 $ · fees pending 10,6 $ |
| PnL net (valeur+fees−refSol) | **−13,3 $** (pire : −16,0 $ à 11:33) |
| Prix cbBTC/SOL | 750,6 vs entrée 777,8 → **−3,5 %** |
| Range | bins 44 790–44 810 ≈ prix 776,3–779,4 (largeur ±0,2 %) |
| Statut OOR | hors range bas depuis **19,8 h** (dernier in-range 06/09 ~06:45) |

⚠️ Le mark to-market est volatil et bruité : les marques oscillent entre
−16 $ et +5 $ d'une minute à l'autre (prix par-token vs échelle SDK). Toute
décision doit se prendre sur la structure (SOL déployé vs inventaire), pas sur
un mark instantané.

## Historique des 4 jours

| Jour (CEST) | cbBTC/SOL low–high | In-range cumulé | Fees cumulées |
|---|---|---|---|
| 02/09 | 769,6 – 785,2 | ~5,4 h | ~4,7 $ |
| 03/09 | 765,5 – 783,3 | ~1,7 h | ~2,2 $ |
| 04/09 | 776,0 – 790,5 | ~6,0 h | ~2,8 $ |
| 05/09 | 767,2 – 782,2 | ~5,4 h | ~1,1 $ |
| 06/09 | 746,9 – 768,9 | ~0,5 h | ~0,3 $ |

- 17,7 h in-range sur 97 h de tenue = **18 % du temps**.
- Fee run-rate réel : 10,6 $ / 4,05 j = **2,6 $/j = 0,52 %/j** sur le capital.
- 8 alertes real-fee-decline (ftr24 tombé de 0,59 % à 0,31 %, feeDecay < 0,6).
- Pool : TVL 204 k$, base_fee 0,03 %, bin_step 2, dynamic fee 0,2 %.

## Pourquoi cette position est un cas d'école raté

1. **Range mal calibrée pour la thèse.** 20 bins × step 2 = ±0,2 % de largeur.
   La vol journalière cbBTC/SOL est ~2 % → la probabilité d'être en range à un
   instant donné est ~10 %. Un LP ne collecte que s'il est EN range ; ici il ne
   collecte presque jamais. Ce n'est pas une « spot-spread » au sens de la spec
   (20-30 bins censés couvrir le mouvement), c'est une raquette de ping-pong
   posée sous le filet.
2. **La thèse L4-B est violée dans les deux sens.** Spec §2 : pur positif exige
   un actif qui APPRÉCIE. cbBTC/SOL a fait −3,5 % en 4 jours (le BTC baisse et
   le SOL monte) → pur négatif. Spec §7 : OOR pilote > 48 h = revue humaine
   obligatoire — on est à 19,8 h, la fenêtre se ferme demain matin.
3. **Le yield ne couvre rien.** 0,52 %/j de fees contre un drift de −0,9 %/j
   sur la paire. Même redevenue in-range, la pool ftr24 0,31-0,38 % ne paie pas
   l'IL+drift d'un actif en baisse relative.
4. **Contre-exemple utile quand même** : la position N'A PAS explosé le filet —
   value-stop/hard-stop jamais déclenchés, perte contenue à −16 $ max (−3 % du
   capital). Le pilote L4-B ne casse pas, il ne gagne pas.

## Les options chiffrées

**A. Close maintenant (kill-switch)** — `npm run real:close -- --id 108` puis
sweep du résidu cbBTC (~0,00327 ≈ 260 $). Réalise ≈ −13 $ net (bruit ±3 $).
Capital libéré pour redéploiement book (open:paper réalloue ≤ 1 h).

**B. Tenir jusqu'au verdict 07/09, puis close programmée.** Attendu : OOR
atteindra ~40 h demain matin (< seuil spec 48 h). Coût d'opportunité ~2,6 $/j
de fees quasi nulles + exposition au drift. Gain possible : un rebond
cbBTC/SOL > +3,5 % remettrait la position à l'équilibre — non chiffrable, et
même dans ce cas la range serait traversée sans re-collecter (trop étroite).

**C. Repositionner la range (close + ré-open recentrée sur le prix actuel,
span élargi).** Coûte 2 cycles de friction (~0,3-0,5 %) + gas. Garde la thèse
« actif établi » mais contredit le point 2 : cbBTC en tendance BAISSIÈRE vs
SOL. À réserver si David veut sauver le pilote avant le verdict hebdo.

**D. Redéfinir le critère de succès du pilote sur les données.** Verdict 07/09
honnête : L4-B phase 1 = échec sur le run-rate fees (0,52 %/j vs cible book
1,25 %/j) ET sur le pur (négatif), MAIS pas sur le risque (filets intacts).
Leçon transposable : bannir les spans < 1 % de largeur sur paires établies ;
exiger tendance positive de la PAIRE (pas du token seul) ; garde d'entrée
« span ≥ 2× vol réalisée ».

## Recommandation

**A + D** : close aujourd'hui (la range étroite ne se refait jamais seule,
chaque heure OOR est de l'argent qui ne travaille pas), et le verdict de
demain acte l'échec de calibrage de la phase 1 avec les 3 règles correctives
(span ≥ 2×vol, tendance de la paire, seuil fee run-rate) plutôt qu'un
acharnement sur cbBTC. Si David préfère B, fixer un plancher dur : close
automatique au premier mark net ≥ 0 ou à 48 h d'OOR (lundi ~06:45), sans
prolongation.

## Commandettes

- Close : `cd /home/polybot/dlmm-bot && npm run real:close -- --id 108`
- Puis sweep résidu : `npm run sweep:residues` (--dry-run d'abord)
- Vérif post-close : solde wallet 2 lectures + compte position absent
  (leçon 23/08 : nœud en retard possible)
