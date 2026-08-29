# L4 — Pivot actifs : specs pilote token (L4-B) — 2026-08-29

Décision David 29/08 : « specs L4-A (code) + L4-B (specs pilote) en parallèle »,
avec contrainte : **« les specs ne doivent pas être au détriment de la collecte
des fees »**. Ce doc est la spec du pilote L4-B ; L4-A (filtre de tendance) est
codé en shadow dans le scanner (voir NOTES-20260829-l4a.md ou les commentaires
config.ts / scanner.ts / strategies.ts).

---

## 1. Pourquoi (le constat chiffré)

Un LP Y-only SOL sur memes mourants a IL ≤ 0 TOUJOURS → pur plafonné à 0,
jamais positif (0/60 gagnants purs, pur total −1 594 $ vs fees +1 087 $).
Aucune règle d'exit (L1/L2/L3) ne rend le pur positif : elles ne font que
réduire la perte. Le pur +++ exige de détenir un actif qui APPRÉCIE au-dessus
de l'entrée. Référence paper (20/08, ROI net) : curve +11,1 %, topblast
+10,1 %, spot-spread +5,1 %, bidask-dip +0,33 % (ce qu'on fait à 100 % en
réel : 58/60 positions).

## 2. Objectif du pilote

Prouver en réel, sur 1 semaine et petit capital, que du pur positif est
atteignable en détenant des tokens établis en tendance (spot/curve balancés),
SANS réduire le run-rate fees du bot existant.

Critères de succès (verdict hebdo, même format que value-stop) :
- pur total du pilote > 0 (strictement), ET
- run-rate fees du book principal (hors pilote) ≥ run-rate des 7 j précédents
  (~1,25 %/j déployé), ET
- aucun drawdown pilote > 25 % de l'allocation pilote.

## 3. Contrainte n°1 : ne pas cannibaliser la collecte des fees

- Capital pilote DÉDIÉ et plafonné : **500–1 000 $** (2-3 positions × ~330 $,
  sizing classe exploratoire). Jamais prélevé sur le capital qui collecte :
  il est versé en plus du capital book existant (le book actuel reste
  inchangé, garde 80 % appliquée au total book + pilote).
- Le cron open:paper RESTE Y-only (bidask-dip/topblast seuls) : il ne peut
  PAS ouvrir les positions balancées du pilote (le wallet n'a pas l'inventaire
  token au moment du cron). Ouverture pilote = manuelle (via l'outil dédié,
  section 6) — le pilote ne change RIEN au pipeline auto existant.
- Les positions pilote collectent AUSSI des fees (spot-spread/curve en range).
  Elles seront suivies SÉPARÉMENT (section 8) : on mesure pur ET fees du
  pilote, pour vérifier qu'aucun transfert caché de collecte n'a lieu.
- Si le pilote consomme des slots MAX_POSITIONS ou du temps de surveillance :
  plafonner à 3 positions pilote max, toujours en dessous de
  MAX_POSITIONS (10) − positions book.

## 4. Sélection des tokens (3-4, établis, en tendance)

Critères d'entrée (tous requis, croisés — la sélection est HUMAINE au départ,
pas un filtre auto) :
1. Token ÉTABLI : pool ≥ 7 j (hors fenêtre pump.fun récente), TVL ≥ 100 k$,
   vol 24h ≥ 1 M$ (les « majors » du sizing satsmonkes : TVL ≥ 500 k ET
   vol 24h ≥ 5 M$ → classe 1 000 $ ; sinon conviction).
2. Tendance : analyse L4-A positive — drift 24h > 0, RSI(7) qui remonte,
   prix > SMA(7) (fonction `analyzeTrend` de strategies.ts, dispo au scan
   via le badge 📈 tendance).
3. Non corrélés entre eux (max 1 pool par token, diversifier les thèmes).
4. Pool SOL-quoté (token_y = SOL) pour rester dans la mécanique connue ;
   le SOL est l'actif de référence de mesure.
   Candidats naturels à l'écran le jour J : BONK, WIF, JUP, POPCAT, etc.
   (majors avec vol réel) — liste validée par David avant tout achat.

## 5. Stratégies (balancées uniquement)

- **spot-spread** (Spot, balancé, 20-30 bins) : le choix principal — ROI paper
  +5,1 %, symétrique, collecte des deux côtés, IL borné par la largeur.
- **curve** (Curve, balancé, concentré centre) : uniquement sur paires stables
  ou tokens à faible σ — ROI paper +11,1 % mais IL sensible à la volatilité ;
  sur un token meme établi, n'ouvrir curve que si σ journalière < 10 %.
- PAS de bidask-dip/topblast dans le pilote (déjà couverts par le book).
- Range on-chain : recentrée sur activeBin.binId ± span (règle du SDK —
  jamais de binId dérivés des prix Data API).

## 6. Mécanique : l'inventaire token (le nouveau muscle)

Aujourd'hui le wallet est SOL-only et TOUT est sweepé. Le pilote inverse :
1. **Achat du token X** : swap SOL → X avant l'ouverture (même pattern que
   sell-omo.ts en miroir : swapQuote(swapForY=false) + pool.swap sur le pool
   cible, slippage 500 bps, vérif solde token après). Montant = moitié de la
   valeur de la position (position balancée 50/50 au prix du pool).
2. **Ouverture balancée** : realOpenPosition avec rawX = montant token acheté,
   rawY = montant SOL correspondant (l'adapter réel gère déjà oneSided ;
   ajouter un mode balanced qui passe les DEUX montants — le projeté sur la
   courbe existe déjà dans la math paper, buildLiquidity).
3. **À la fermeture** : removeLiquidity + claim (existant), puis SWEEP du
   résidu token → SOL (sweep-residues existant, seuil 15 $).
4. **Pendant la tenue** : PAS de sweep des tokens du wallet appartenant aux
   positions pilote ouvertes (garde : le mintMap du sweep exclut déjà les
   positions ouvertes — vérifier que c'est le cas pour les tokens du pilote
   avant de les ouvrir ; la liquidité vit dans le pool, le solde wallet ne
   doit contenir que les fees claimées).

Le pur du pilote = (SOL rendu au close après sweep) − (SOL dépensé à
l'ouverture, achats inclus) − (fees du pilote). C'est la mesure directe de
l'appréciation.

## 7. Exits et gardes du pilote

- **value-stop −15 %** appliqué (même règle que le book : lossRatio vs refSol
  à l'ouverture — mais refSol inclut le token acheté, valorisé au prix du pool).
- **hard-stop prix** 0,85 (mort du token) identique au book.
- **OOR** : pas d'oor-redeploy AUTO sur le pilote (une position balancée hors
  range n'est pas un capital mort au même sens — elle détient le token) ;
  alerte seule + décision humaine (la tendance peut justifier de tenir).
  Une position pilote OOR depuis > 48 h = revue humaine obligatoire.
- **Claim AUTO** ≥ 25 $ conservé (les fees du pilote se claiment comme le book).
- Kill-switch : `npm run real:close -- --id <id>` par position (existant) ;
  en cas de panique : tout fermer + sweeper (les scripts existent).

## 8. Mesures et reporting

Table `real_positions` réutilisée avec close_reason = `l4b-pilot` et une
colonne/flag `pilot=1` (ajout schéma) pour isoler le pilote des stats du book.
Chaque jour (récap 6:30) :
- ligne pilote : positions, SOL déployés, pur pilote, fees pilote, ROI ;
- ligne book : run-rate fees/jour (delta marks) — le comparatif qui garantit
  la contrainte n°1.

## 9. Phases (shadow → pilote → scale, doctrine)

- **Phase 0 (J1, ~1 h)** : mini-pilote 1 position ~100–150 $ sur 1 token
  établi — valide le chemin complet : achat SOL→X, ouverture balancée,
  close, sweep, compta pur. Sans phase 0 verte, PAS de phase 1.
- **Phase 1 (J1→J7)** : 2-3 positions balancées sur 3 tokens établis en
  tendance, 500–1 000 $ au total, exits/gardes section 7, mesures section 8.
- **Verdict hebdo (J7)** : critères section 2. Vert → scale 5 000 $ (avec
  revue des tokens, pas d'auto-scale) ; rouge → close + sweep + retour au
  book, leçon documentée.

## 10. Ce qu'il FAUT CODER (backlog, par ordre)

1. `scripts/buy-token.ts` (ou extension sell-omo.ts en mode inverse) : swap
   SOL→X sur le pool cible, gardes identiques à sell-omo (cluster mainnet,
   pubkey == wallet pilote, vérif solde, 2 lectures).
2. Mode balanced dans real.ts (realOpenPosition rawX+rawY) + ouverture via
   l'outil pilote (dry-run puis --confirm, comme _pilot-open.ts).
3. Flag `pilot` sur real_positions + filtres dashboard/reporting.
4. Garde sweep : exclure les tokens des positions pilote OUVERTES (vérifier
   mintMap existant — probablement déjà OK car il exclut les positions
   ouvertes, à confirmer en phase 0).
5. Rapport : ligne pilote au récap 6:30 + verdict hebdo (job 59c3fe3329f0).

## 11. Non-objectifs (ce que le pilote ne fait PAS)

- PAS de changement du pipeline auto du book (cron, filtres, exits Y-only).
- PAS de sweep du SOL de collecte vers des tokens (le capital book reste SOL).
- PAS de levier, PAS de tokens à découvert, PAS de pools < 7 j.
- PAS de take-profit % : l'exit reste structurel (OOR/cooling/value-stop) —
  le pur vient de l'appréciation pendant la tenue, pas d'un TP.

## 12. Risques et atténuations

- Le token achète pendant une micro-pompe → achat au pic : atténué par la
  sélection (tendance confirmée, pas blow-off : RSI < 70 requis — le veto
  RSI_MAX_ENTRY_BIDASK sert de garde d'entrée).
- IL sur position balancée (le prix traverse le range) : c'est LE risque
  assumé du pilote — il est le prix de l'appréciation ; borné par value-stop
  −15 % et la diversification 3 tokens.
- Friction 2 tx par cycle (achat + ouverture) : ~0,3-0,5 % du capital pilote,
  absorbé si le pur + cible est atteint.
- Le pilote détourne du temps de surveillance : la phase 0 le mesure (un
  cycle complet) avant d'engager la phase 1.
