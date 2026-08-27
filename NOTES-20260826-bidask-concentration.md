# Tension à résoudre — concentration bidask-dip & PnL modeste vs fees

Statut : TRANCHÉ (27/08 soir, doctrine David) — « je préfère gagner plus petit
et souvent, pas de grosses pertes ». Résolution détaillée en bas. Rien à
exécuter d'autre : le value-stop resserré à 0.15 EST la réponse (cf. fin du doc).

## TRANCHÉ 27/08 soir (décision David, données à l'appui)

Doctrine : PAS de grosses pertes, gains petits et fréquents. Le mécanisme
« petit et souvent » existe déjà (recovery-exit : 15/17 closes à PnL ≈ 0-2 $) ;
le problème était les queues de distribution qui effaçaient les fees. Les
pertes réelles 26/08 18:00 → 27/08 12:59 : CVXV666 −333 $ (hard-stop), GTA6
−246 $ + CYBERLEEK −182 $ (closes manuels) = −761 $ sur 3 positions, PnL net
−680 $ sur 11 closes.

Verdict par piste :
- A (laisser courir les fee printers) : REJETÉE — garder une position qui se
  retourne = exactement le risque que David ne veut plus.
- B (flip auto) : REJETÉE pour l'instant — le flip est un mécanisme de
  « gros coups » (distribution), la doctrine est le petit gain fréquent.
  flip-candidat reste informatif (aucune exécution auto).
- C (diversification spot/curve) : REJETÉE en l'état — wallet SOL-only, les
  pools balancés exigent des tokens absents du wallet ; à reconsidérer si un
  jour un 2e wallet/tokens arrive.
- D (redéployer le capital libre) : FAIT en partie — book à 8/10 positions,
  ~80 % déployé (35,62/45,38 SOL) ; slots 9-10 figés par la garde de solde
  (il faudrait +5,0 SOL pour le slot 9, +10,9 pour le 10).
- RÉPONSE PRINCIPALE : VALUE_STOP_LOSS 0.30 → 0.15 (cf. NOTES-20260827-value-stop.md).
  Rejeu des ~13 000 marks réels (37 positions) : aucune position saine n'est
  passée sous −2,6 % → zéro faux positif à 0.15 ; les 3 pertes auraient été
  coupées à ~−15 % (≈ 50-75 $) au lieu de −50/-66 %. Les fees du book
  (~229 $/période) deviennent le PnL au lieu d'être effacées.

## Le constat (chiffres réels 26/08 13:05, cf. reporting)

- Book 100 % bidask-dip (25 positions réelles depuis 22/08, toutes bidask-dip).
- Fees totales générées : ~229 $ (184,73 $ réalisées + 44,49 $ marquées).
- PnL net total : ~+62 $ — soit ~27 % des fees converties en PnL.
- 17 closes : 15 recovery-exit (sortie dès PnL ≥ 0, value + fees ≥ dépôt),
  2 cooling-off à ~0, 1 oor-redeploy (+21,15 $, le MEILLEUR close), 1 manuel.
- Beaucoup de closes « poussière » : MANLET +0,53 $, CATE +0,44 $, Jimothy
  +0,45 $, Morty +0,21 $, TOAD +0,23 $ — le capital est recyclé très tôt.
- 2 gros gains sur des positions LAISSÉES COURIR : XST +21,15 $ (oor-redeploy,
  restée OOR 6 h puis réallouée) et cc-SOL +6,67 $.
- 27 real-flip-candidate émis en 7 j, 0 flip exécuté. Bag ≥ 20 % requis :
  atteint seulement 2× (XST 45 % le 26/08 01:30, LOOKSMAX 24 % le 03:33).
- Capital sous-utilisé : 32,51 SOL déployés / ~43 SOL gérés (10,49 SOL libres).

## Diagnostic

1. Le recovery-exit sécurise (17/17 closes sans perte) mais coupe les
   positions au moment où elles commencent à payer. Sur les pools à fees
   durables (feeDecay ≥ 1,2), sortir au breakeven = abandonner les fees.
2. Le flip (accumulation → distribution, setup 4 satsmonkes, validé en paper)
   n'est JAMAIS déclenché en réel — le mécanisme qui transforme les fees en
   gros PnL (ANSEM +1112 $ en paper) reste lettre morte.
3. La garde inFeeSurge (surgeHold, f8da26f) retient déjà pendant les surges
   (≤ 20 min) — preuve que « laisser courir pendant la fenêtre de fees » est
   accepté par le design ; il manque l'extension à plus long terme.

## Pistes (à trancher avec David — aucune exécutée)

A. Recovery-exit conditionnel : conserver le breakeven pour les pools
   quelconques, mais sur les fee printers (fees/TVL 24h ≥ 0,5 % ET feeDecay
   ≥ 1,2) ne sortir que sur signal de déclin (feeDecay < 0,6 / volume fade) —
   le filet (hard-stop 0,4, cooling-off, OOR) reste intact. Gain attendu :
   fees captées plus longtemps ; risque : garder une position qui se retourne
   (le hard-stop reste la ceinture).

B. Exécuter le flip automatiquement quand bag ≥ 20 % (le code existe,
   SATS_FLIP_EXECUTE, validé David 18/08 en paper). 2 occasions réelles déjà
   perdues en 7 j (XST bag 45 %, LOOKSMAX 24 %). Gardes existantes : cooldown
   6 h, bag ≥ 20 %, exit flip-failed si re-dump. Risque : distribution sur un
   marché qui retombe — mais flip-failed couvre.

C. Diversifier : spot/curve sur paires stables (IL faible, fees régulières)
   pour décoreller du meme. Le paper avait 8 positions spot/curve qui
   encaissaient des fees régulières (LAYOOO, SOLPUMP, Z500 — +904 $, +751 $,
   +359 $ en paper). Le book réel 100 % bidask-dip est exposé à un seul régime
   de marché (dump/rebond).

D. Redéployer le capital libre (10,49 SOL ≈ 1 000 $) : soit plus de positions
   (MAX_POSITIONS=10, actuellement 8), soit du sizing par classe déjà en place
   (majors 2 000 $, conviction 1 000 $, exploratoire 500 $ — les positions
   actuelles sont presque toutes au palier bas).

## Contraintes à respecter (design validé, ne pas casser)

- Hard-stop JAMAIS touché (protection de perte).
- Deadband 1 $ sur tout exit comparant à l'équilibre (leçon faux positifs).
- Source unique pour les deltas de volume (volumeSeriesScansOnly, leçon omo).
- Aucun exit piloté par accel_observations / ws tant que le harnais de
  corrélation ws n'est pas concluant (phase 2 en attente).
- Toute modif d'exit = paper d'abord, puis validation David (rollout
  shadow→pilot→scale HUMAIN-approuvé).
- Ne jamais mélanger deux sources API dans une série.

## Prochaine étape

Analyser avec David : A vs B vs C vs D, ou combinaison. Recommandation
préliminaire : B est le moins risqué (code existant, validé, 2 occasions
réelles déjà perdues) ; A est le plus rentable potentiellement mais touche
au cœur du filet de sécurité ; C décorelle le risque mais change le profil.
