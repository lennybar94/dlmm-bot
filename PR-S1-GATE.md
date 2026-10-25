# Porte S1 frais/LVR + correction du σ (√24) — 4 commits, à relire séparément

Base : `dd30ade` (branche `claude/sharp-curie-bj8lhg`). **Aucun merge dans main** —
main reste l'état de l'archive (décision David).

## ⚠️ Avant la première exécution sur une base réelle

L'étape 2 (migration d'unité) est **IRRÉVERSIBLE** sur la base qu'elle touche, et le code
de main relit mal une base migrée (double division). Procédure :

```bash
# 1) arrêter tout scan en cours, puis SAUVEGARDER
cp data/dlmm-bot.db data/dlmm-bot.db.pre-s1-$(date +%Y%m%d-%H%M)
sqlite3 data/dlmm-bot.db "SELECT COUNT(*) FROM pool_scans"   # noter le compte

# 2) une seule exécution, qui pose le marqueur meta sigma_unit_fix_at
npm run scan:only

# 3) vérifier : max vol_24h ≈ 0,41 (= 2,0/√24) et marqueur présent
sqlite3 data/dlmm-bot.db "SELECT MAX(vol_24h) FROM pool_scans WHERE vol_24h>0"
sqlite3 data/dlmm-bot.db "SELECT * FROM meta WHERE key='sigma_unit_fix_at'"
```

Retour arrière = restaurer le fichier sauvegardé. Jamais de migration sur l'archive
d'origine sans copie : les tests de cette PR ont tous tourné sur des copies.

### Conversion des `.env` existants (bloquant 2 de la relecture)

Les `.env` du serveur et `lab/.env` peuvent encore contenir `MAX_VOL_24H=0.6`, l'ancienne
valeur calibrée sur le σ gonflé. Depuis le fix, σ est plafonné à 2/√24 ≈ 0,408 : un 0,6 ne
rejetterait plus **aucune** pool. `config.ts` refuse désormais de démarrer dans ce cas
(message « ancienne échelle, diviser par √24 »), donc le problème ne peut pas passer en
silence — mais il faut convertir les fichiers :

```bash
# dans chaque .env (serveur ET lab)
sed -i 's/^MAX_VOL_24H=0\.6$/MAX_VOL_24H=0.12/' .env lab/.env
grep -n MAX_VOL_24H .env lab/.env     # doit afficher 0.12 partout
```

### La migration n'est plus automatique

`db.ts` ne convertit plus rien à l'import : lancer un dashboard, un rapport ou le
real-monitor sur la mauvaise base suffisait à déclencher la conversion irréversible.
Commande explicite, qui refuse sans sauvegarde confirmée et ne fait rien si le marqueur
`sigma_unit_fix_at` existe déjà :

```bash
cp data/dlmm-bot.db data/dlmm-bot.db.pre-s1-$(date +%Y%m%d-%H%M)
npm run migrate:sigma-unit -- --confirm-backup
```

## Les 4 commits, dans l'ordre de relecture

**1. `fix(sigma)` — σ journalier direct.** `realizedVolatility` ne multiplie plus par √24
(bougies DAILY traitées en horaires, ×4,9). Tous les réglages calibrés sur cette échelle
sont divisés par √24 **exactement**, pas arrondis : `0,02 × √24 = 0,098 ≠ 0,1` ferait
basculer une bande. Concerne `MAX_VOL_24H` (0,6 → 0,12), `strategyForVolatility`,
`binsPerSideForVolatility` (×√24), `volPenalty`, le signal « profil réflexif », et les
bandes tuner/export. **Le repli `return 0.1` de `realizedVolatility` était lui aussi sur
l'ancienne échelle** — trouvé par le test d'équivalence : sans conversion, un pool sans
OHLCV passait de « mid » à « high ». `volPenalty` garde son périmètre `sigmaTolerant`
d'origine : c'est S1 qui ferme le trou, pas elle.

**2. `fix(db)` — migration d'unité.** `pool_scans.vol_24h` et `outcome_reviews.vol_24h`
divisés une seule fois par √24 (marqueur `sigma_unit_fix_at`, transaction). Sans ça le
tuner apprendrait sur des bandes fausses.

**3. `feat(scanner)` — porte S1.** Formule DLMM-Claude en bloc : `R = 2·W·f/σ²`,
`W = clamp(9σ, 0,01, 0,25)`, double seuil 2,5 / 2,0, plancher 0,25 %/j (S7), sur toutes
les stratégies. Fenêtre 4 h ancrée sur `scannedAt` ; **moins de 12 rendements → refus dur,
sans exception** (conséquence assumée : ~1 h de scans avant la première entrée possible
sur une base neuve). Snapshot live du scan courant en point terminal — inclus dans ce
commit et non séparé, parce que sans lui S1 ne peut mesurer aucune pool au premier tour.
Normalisation d'unité X-SOL → $/token (piège wNEAR). **Vérification de bouclage** en fin
de `runScan` : chaque pool retenue finit en opportunité, rejet motivé ou échec OHLCV.

**4. `feat(review)`** — `sigma_intraday` et `s1_r24` remontés dans les buckets d'évidence.

## Preuves mesurées

**Équivalence d'unité (étape 1), main vs branche, copie de l'archive, même horloge :**
44/45 pools identiques en liste **et** en stratégie ; σ main ≡ σ branche × √24 (écart
médian 1,4e-4 = dérive de fetch API). Seule divergence : `Dacity-SOL`, où le RSI(7)
franchit 70 entre les deux appels (données live, pas le code).
`scripts/test-sigma-equivalence.ts` : 407 points, **0 divergence**, bornes incluses.

**Migration (étape 2) :** max `vol_24h` 2,0000 → 0,4082 (= 2,0/√24) ; scan sur base
migrée = 44 opportunités, mêmes stratégies qu'avant migration, à l'identique.

**Porte S1 (étape 3)**, horloge figée au dernier scan de l'archive :
150 vues / 91 retenues / **1 opportunité**, bouclage **91/91**, rejets tous motivés
(13 σ insuffisant, 6 `R24 < 2,5`, planchers S7 à 0,02-0,18 %/j). La seule pool qui passe :
`DOGE-SOL`, σ 1,1 %/j, R24 13,7. **S1 ferme le book memes, comme la mesure live
l'annonçait** (fees/TVL médiane 0,28 %/j contre σ²/8 ≈ 0,5-1,1 %/j).

**Écart de granularité σ 5 min vs 1 min** (exigence « avant tout GO ») : mesuré sur
`real_marks` (~1 min) contre `pool_scans` (5 min réels, cadence vérifiée), mêmes pools,
mêmes fenêtres de 4 h — 236 fenêtres, 92 pools :
**médiane 1,022 · p10 0,865 · p90 1,177**. Au-dessus du seuil 0,9 → on garde 2,5.
À noter dans l'interprétation : **une fenêtre sur dix sous-estime σ de plus de 13 %**,
donc R est surestimé d'autant dans ces cas-là (R = 18·f/σ quand W est clampé).

## Ce qui n'est pas fait

- Aucune exécution sur l'archive d'origine : uniquement des copies.
- Aucun réglage de prod modifié, aucun cron réactivé, aucune clé touchée.
- La manche papier (100 closes) reste à faire après merge, avant tout SOL réel.

## Leviers intouchés

recovery-exit, cooling-off, TP 10 $, comptabilité SOL, veto L4-A (shadow jusqu'à preuve
par rejeu).
