# NOTES — Manche tendance L4-B « étendue » v2 (14/09/2026)

## Pourquoi : le pilote était FLAT, pas positif

Audit du 14/09 sur les **11 closes `pilot=1`** depuis le 29/08 :

- net réel **+1,9 $**, fees 124,4 $
- 6 gagnantes (+1,3 / +18,4 / +20,7 / +20,1 / +13,8 / +22,0) = +96,3 $
- 5 perdantes (−6,8 / −18,8 / −13,4 / −4,6 / −50,9) = −94,5 $

La « strate positive » supposée (+90 $) était une lecture erronée — chiffre corrigé
dans le reporting du 14/09.

## Les deux fuites trouvées par contre-factuel mark à mark

### 1. Take-profit absent

Les 6 gagnantes se refermaient à +13/+22 $ via `cooling-off`, mais **2 avaient
dépassé +20 $ avant de rendre la mise** :

| Position | max atteint | close réelle |
|---|---|---|
| HYPE-SOL (2e) | +22,9 $ | **−18,8 $** |
| CATE-SOL | +32,2 $ | +13,8 $ |

Simulation (close au 1er mark ≥ seuil, ordre chronologique respecté) :

| Seuil TP | Résultat simulé |
|---|---|
| +10 $ | +96,4 $ |
| +15 $ | +116,3 $ |
| +18 $ | +122,9 $ |
| **+20 $ (retenu)** | **+130,9 $** |
| +25 $ | +137,9 $ |
| +30 $ | +142,3 $ |
| +40 $ | +125,1 $ |

Seuil retenu : **+20 $ (+4 % pour une mise de 500 $)** — conservateur, aligné sur les
closes réellement observées (+13/+22 $) ; l'écart avec le plateau +25/+30 $ est dans
le bruit d'un échantillon de 11 trades.

### 2. Ré-entrées sur les mêmes tokens

4 tokens rejoués : HYPE (2), cbBTC (2), ANTHROPIC (2), ANSEM (2).

| Règle | Entrées supprimées | Net simulé |
|---|---|---|
| réelle | — | +1,9 $ |
| anti-ré-entrée ≤ 1 j | +171,2 $ |
| anti-ré-entrée ≤ 3 j | +151,2 $ |
| anti-ré-entrée ≤ 7 j | +130,9 $ |
| **anti-ré-entrée ≤ 14 j (retenu)** | **+144,4 $** |
| anti-ré-entrée ≤ 30 j | +144,4 $ |

14 j attrape le cbBTC rejoué à 9 jours (−13,4 $), que la fenêtre 7 j laissait passer ;
1 j / 3 j sont du surajustement sur 11 trades.

## Ce qui est implémenté

| Fichier | Changement |
|---|---|
| `src/config.ts` | `PILOT_TAKE_PROFIT_USD=20`, `PILOT_REENTRY_COOLDOWN_DAYS=14`, `PILOT_USD_MAJOR=1000`, `PILOT_MAJOR_MIN_TVL=500000`, `PILOT_MAJOR_MIN_VOLUME_24H=5000000` |
| `scripts/real-monitor.ts` | bloc 6.5 : take-profit, condition `pos.pilot && netPnlUsd >= PILOT_TAKE_PROFIT_USD`, `close_reason='take-profit'`, même kill-switch `REAL_EXIT_AUTO` ; fallback alerte `real-take-profit` |
| `scripts/l4b-open.ts` | critère dur « aucune tentative pilote sur ce token depuis 14 j » (refus motivé) + palier de mise automatique major/standard |
| `scripts/l4b-watch.cjs` | les tokens déjà joués dans la fenêtre ne sont plus présentés au décideur ; affichage du palier (⭐ MAJOR) |
| cron `d45380a1705e` | prompt aligné : pas de `--usd`, palier auto, refus si garde > 90 %, TP et anti-ré-entrée non contournables |

## Sizing réel (piège de lecture)

Le paramètre `--usd` est une **valeur cible**, pas le SOL sorti :

- `--usd=500` → **5,096 SOL** (achat 2,523 + dépôt 2,473 + 0,1 de frais)
- `--usd=1000` → **10,093 SOL**

Garde de manche le 14/09 : budget 21,91 SOL (= 40 % de 54,77 SOL), plafond 17,53 SOL
(80 %), déployé tendance 2,46 SOL → 2 standards + 1 major tiennent.

## Pistes testées et REJETÉES par les données (14/09)

1. **Filtre « anti-couteau » à l'entrée** (prix ≥ 95 % du min des 30 min) : **0 des 8
   value-stops** auraient été bloqués — tous étaient entrés sur un plateau stable, le
   krach survenait APRÈS l'entrée. Gain simulé : 0 $.
2. **Value-stop plus rapide** : sur les 8 stops, **7 étaient déjà clos au premier mark**
   franchissant le seuil (le prix passe de +2 % à −11 % entre deux marks d'une minute) —
   aucun levier de vitesse ne peut rattraper un trou de 13 % en 60 s.
3. **Sizing par `fee_tvl_ratio_24h`** : contre-factuel **négatif** (−51 $ sur 10 j) ; les
   5 pires pertes étaient toutes des pools à ftr ≥ 5 % ; aucune pouvoir prédictif du signe
   du PnL par tranche de ftr (moyennes −0,7 à −10,2 $/trade, value-stops plus fréquents
   dans les ftr élevés).

## Validations faites

- `npx tsc --noEmit` = 0 erreur.
- Garde anti-ré-entrée vérifiée en dry-run réel : cbBTC-SOL bloqué avec le motif
  « #216 ouverte le 2026-09-13 22:06:58 (encore ouverte) ».
- Palier automatique vérifié : 500 $ par défaut ; 1 000 $ avec seuils major abaissés par env.
- Branche take-profit exercée en mode alerte seule (`REAL_EXIT_AUTO=false`,
  `PILOT_TAKE_PROFIT_USD` forcé) → événement `real-take-profit` écrit, **aucun ordre
  envoyé** ; l'événement de test a été supprimé après vérification.

## Projection honnête (échantillon n=11)

11 closes / 16 j ≈ 20,6 closes/mois × +13,1 $/close simulé ≈ **+270 $/mois** à mise
constante de 500 $ ; ≈ **+350 $/mois** avec ~30 % de candidats en classe major (mise
1 000 $). À confirmer sur le prochain cycle circuit-breaker — l'échantillon est petit et
le régime de marché (meme atone) reste le premier facteur.
