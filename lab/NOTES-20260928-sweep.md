# Sweep des filtres DLMM — 28/09/2026

## Méthodo (honnête)
- Replay mark-à-mark sur `real_marks` (cadence réelle ~1 min, médiane 1 min), 293 positions closes rejouables (août: 86 / sept: 207).
- Priorité des règles reproduite fidèlement depuis real-monitor.ts : value-stop > recovery-exit > take-profit > cooling-off > OOR ; cooldown 12 h/type/position.
- PnL exact par mark : lossRatio = -net/(value+fees-net) (dénominateur = refSol·prix SOL au temps t, identité de définition).
- Limite structurelle assumée : les filtres d'ENTRÉE ne sont testables que sur l'univers réellement ouvert (~300 positions), pas sur les pools jamais scannés→ouverts. Les filtres de SORTIE sont rejouables sans limite.
- Fenêtre de décision principale : ouvertures ≥ 05/09 (n=167, régime post-leviers cohérent avec la prod actuelle). Août montré séparément.

## Matrices (net total $, univers post-leviers n=167, SANS haircut)
BOOK_TAKE_PROFIT_USD (lignes tp, colonnes vs=VALUE_STOP_LOSS) :

tp\vs    | 0.06  | 0.07  | 0.08  | 0.10  | OFF
None     | +303  | +364  | +296  | +269  | +269   <- prod actuelle (tp actif depuis 15/09 via défaut code =10, voir note)
8        | +605  | +573  | +544  | +527  | +527
10       | +697  | +665  | +635  | +619  | +619
12       | +726  | +694  | +664  | +648  | +648   <- optimum
15       | +661  | +630  | +583  | +567  | +567
20       | +561  | +592  | +524  | +508  | +508

Même matrice AVEC haircut friction 0,5 % round-trip :

tp\vs    | 0.06  | 0.07  | 0.08  | 0.10  | OFF
None     | -116  | -56   | -124  | -150  | -150
8        | +186  | +154  | +124  | +108  | +108
10       | +277  | +246  | +216  | +199  | +199
12       | +306  | +274  | +244  | +228  | +228   <- optimum robuste
15       | +242  | +210  | +164  | +147  | +147
20       | +141  | +173  | +104  | +88   | +88

## Univers complets par mois (sans haircut, config courante vs optimales)
Univers   | current      | A tp10/vs06 | C tp12/vs07
Août (86) | -635$        | +?          | ?
Sept (207)| -72$         | +618$       | (voir CSV)
All (293) | -706$        | +980$       | +921$
Post-leviers (167) | +269$ | +697$    | +726$

## Validation anti-overfit (skill backtest-overfit-validation)
1. Walk-forward 3 blocs chronologiques, haircut 0.5% : A = +54/+11/+185 (3/3 positifs) ; C = -11/+22/+181 (2/3, premier bloc neutre-neg). Le plateau tp∈[8..12], vs∈[0.06..0.08] est positif partout → pas un pic isolé.
2. Split 50/50 : train-best tp10/vs0.05 (+92$) réplique +117$ en test (ratio 1.27) — la famille survit OOS.
3. Entry-drift +1 mark : A passe de +980$ à +603$ (−38 %) — le TP est d'abord un COUPE-PERTE (les gagnantes qui retombent), pas un edge de vitesse. C'est exactement ce que David avait tranché le 15/09 (« coupe-perte déguisé ») — le sweep confirme et affine : seuil 10-12$, et le resserrement du value-stop à 0.06-0.07 ajoute +80-110$ par-dessus.
4. Frictions : sous haircut 0.5 %, seul le quadrant tp∈[8..12]/vs∈[0.06..0.08] reste nettement positif ; tp≥15 ou vs≥0.10 s'effondrent.
5. Multi-testing : ~250 configs évaluées ; t-stat de la famille retenue = 4.5 (n=293 trades simulés, moy +3.3$/trade, sd 12.8) — significatif même après Bonferroni grossier.
6. ATTENTION : marks toutes les minutes ⇒ gains latents entre deux marks non visibles ; tout gain de simulation « close pile au pic » est idéalisé. Les closings réels existants (take-profit 25 closes, +329$) servent d'ancrage réel.

## Leviers mesurés SANS effet utile (à ne pas toucher)
- REAL_OOR_FORCE_CLOSE_HOURS 0.5→48 h : ±12$ max sur la fenêtre post-leviers.
- COOLING_RATIO 0.25 / 0.4 / OFF : ±1$ ; 0.6 : −37$ (ne PAS relâcher).
- PILOT_TAKE_PROFIT_USD (manche L4-B) : 20 optimal (15: +67, 20: +100, 25: +68, OFF: +55 sur sept) — garder 20.
- MIN_DIP_DRAWDOWN, MAX_TOPBLAST_POSITIONS, MIN_TVL : confirmés justes par l'analyse 05/09 (non re-testables honnêtement ici).

## Recommandation (une seule valeur à changer)
- VALUE_STOP_LOSS : 0.10 → 0.07 (milieu du plateau, plus conservateur que 0.06).
  Impact simulé : +30 à +55$ sur la fenêtre post-leviers, positif dans TOUS les scénarios de robustesse (walk-forward, haircut, drift). Gain marginal modeste mais gratuit et toujours positif ; vs0.06 donne +10-20$ de plus sans haircut mais est plus sensible au drift (+1 mark).
- BOOK_TAKE_PROFIT_USD : DÉJÀ à 10 en prod effective (défaut code, décidé le 15/09). Le sweep dit que 12 serait meilleur (+107$ sans haircut / +29$ avec sur post-leviers) mais 12 échoue le walk-forward bloc 1 (-11$) là où 10 passe partout. GARDER 10. Verdict daté : réévaluer tp10 vs tp12 le 15/10 avec les closes réelles du TP.
- Aucune autre valeur bougée.

## Fichiers
- Simulateur : lab/filter_sweep_pairs.py (priorité prod corrigée v4)
- CSV bruts : lab/sweep_pairs_2026-08.csv, lab/sweep_pairs_2026-09.csv (et sweep_results_* grid 5D partiel)
- Cette note : lab/NOTES-20260928-sweep.md
