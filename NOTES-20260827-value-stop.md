# Garde-fou value stop-loss −30 % (leçons CYBERLEEK & GTA6)

Statut : RÉSOLU (implémenté + validé David 27/08/2026). RESSERRÉ 0.30 → 0.15
le 27/08 soir (doctrine David : « gagner plus petit et souvent, pas de
grosses pertes ») — cf. section « Resserrement » en bas.

## Resserrement 27/08 soir (0.30 → 0.15)

Pertes réelles 26/08 18:00 → 27/08 12:59 : CVXV666 −333 $, GTA6 −246 $,
CYBERLEEK −182 $ (PnL net −680 $ sur 11 closes). Le value-stop −30 % (déjà en
place) aurait borné GTA6/CYBERLEEK à ~−122/−62 $, mais David veut plus petit.

Rejeu des ~13 000 marks réels (37 positions, min/max de lossRatio par
position) : AUCUNE position saine n'est passée sous −2,6 % — les pertes sont
binaires (la position reste ~flat pendant des heures puis le dump final
traverse la range en quelques marks). Conséquence : un seuil à 0.15 a ZÉRO
faux positif sur tout l'historique, et les 3 pertes auraient été coupées à
~−15 % (50-75 $) au lieu de −50/-66 %.

- .env + config.ts : VALUE_STOP_LOSS=0.15 (commit 27/08 soir).
- Aucune position ouverte coupée au moment du changement (toutes à ~0 %).
- Marge vs bruit de mark : ×5,7 (bruit max observé −2,6 %).
- Trade-off documenté : sur un marché BAISSIER non observé, une échelle qui
  descend légitimement de 15 % avant un rebond serait coupée (perte réalisée
  ~75 $ au lieu d'un retour à +1 %) — c'est le prix du filet ; seuil ajustable
  (0.10 = très agressif, 0.20 = plus de place au rebond).
- Le hard-stop prix (dip 0.85) reste le dernier filet, JAMAIS touché.

## Le problème (pertes réelles, fermées manuellement 27/08 10:59 UTC)

| Position | Ouverte | Dépôt | Valeur au close | Perte réalisée |
|---|---|---|---|---|
| CYBERLEEK (#17) | 25/08 18:20 | 335 $ | ~152 $ + fees 37 $ | ≈ −146 $ |
| GTA6 (#20) | 25/08 18:25 | 500 $ | ~251 $ + fees 21 $ | ≈ −228 $ |

Cause racine : **aucune coupe de perte intermédiaire n'existait**. Une échelle
bidask-dip qui subit un dump :

1. reste IN RANGE pendant la descente (elle accumule des tokens qui se
   déprécient) → pas d'OOR, pas d'oor-force ;
2. PnL < 0 → pas de recovery-exit (qui ne sort qu'à PnL ≥ 0) ;
3. le hard-stop prix (dip 0.85 vs entry_price) ne coupe que la mort du token —
   jamais atteint pour des dumps de −50/−60 %.

Résultat : une position pouvait perdre −50 % de sa valeur sans qu'aucune règle
ne tire. L'oor-force (24 h OOR) fermait ensuite à perte verrouillée.

## Le garde-fou (commit à venir)

`VALUE_STOP_LOSS=0.30` (config.ts + .env) : close AUTO si la VALEUR de la
position tombe sous 70 % du SOL réellement déployé à l'ouverture (refSol —
PAS deposit_usd, écart ~6 % du sizing satsmonkes).

- real-monitor.ts section 1.5 (après le hard-stop prix, avant recovery-exit) :
  `lossRatio = (refSol − valueSol) / refSol` ; close_reason `value-stop`,
  même kill-switch REAL_EXIT_AUTO, cooldown d'échec 1 h (autoClose), gardes
  de valeurs plausibles. Sans REAL_EXIT_AUTO : alerte mandataire 🚨.
- paper.ts : miroir (lossRatio vs deposit_usd — paper dormant en régime réel,
  parité de comportement).
- Le hard-stop prix (dip 0.85) reste le dernier filet (rug total). PAS de
  trailing stop en v1 (décision David — observer les faux positifs d'abord).

## Validation data-driven (rejeu des marks réels)

- GTA6 : aurait fermé le 26/08 20:04 (ratio 30,6 %, value 328 $) → perte
  réelle ~122 $ au lieu de ~250 $. Sauvé ~128 $.
- CYBERLEEK : aurait fermé le 27/08 07:34 (ratio 30,9 %, value 219 $) → perte
  réelle ~62 $ au lieu de ~180 $. Sauvé ~118 $.
- Aucun faux positif : les deux positions sont restées < 30 % de perte pendant
  26-37 h avant le dump final ; pire dump sur 1 mark observé = 16 % (marge ×2).

## Contraintes respectées

- Hard-stop JAMAIS touché (protection de perte) — le value-stop s'y ajoute.
- Exits auto uniquement via le kill-switch éprouvé (REAL_EXIT_AUTO, validé
  David 22-24/08), cooldown d'échec, gardes de plausibilité.
- Suites : sweep des résidus fait (CYBERLEEK +1,44 SOL, GTA6 +2,47 SOL le
  27/08 11:00 UTC) ; cooldown ré-ouverture 6 h et blacklist post-close
  appliqués automatiquement au close.
