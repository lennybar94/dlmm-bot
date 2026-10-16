# Portage de la politique « Claude » (sol-ladder-spot) dans l'exécuteur réel dlmm-bot

Cahier des charges David 16/10 — **PR à relire avant fusion, rien n'est activé en production.**

## Ce que fait cette PR

Ajoute une manche `sol-ladder-spot` au bot réel, **sans réécrire la politique** : les portes
d'entrée (M4, S1, S7, S8, S5, S3, P3, P4) et les sorties (X1, X2, X3) sont importées du repo
dlmm-claude (`src/vendor/dlmm-claude`, submodule git épinglé sur le commit du run A/B du 13/10).
La décision réelle et la décision paper sont donc identiques sur les mêmes données ; tout écart
mesuré est un écart d'**exécution**, pas de stratégie.

## Garde d'activation (triple verrou, défaut = inactif)

1. `REAL_LADDER=true` dans `.env` — absent ⇒ `config.realLadder=false`, tout sort en « ⏹ inactif ».
2. La pause du book réel (`data/book-memes-PAUSE`) bloque **aussi** le ladder : lever la pause
   reste une décision explicite de David, pas un flag (demandé au cahier des charges).
3. `--confirm=LADDER-REAL-OPEN` / `--confirm=LADDER-REAL-CLOSE` sur la ligne de commande.
   Sans ces trois : dry-run intégral, aucune tx.

## Plafonds en dur (`src/ladder.ts`, non surchargeables par env)

- `LADDER_CAP_SOL = 5` SOL déployés cumulés max pour la manche.
- `LADDER_MAX_POSITIONS = 1` position ouverte simultanément.
- Plancher thésaurisation du wallet conservé (`WALLET_THESAR_FLOOR_SOL`).
- Fourchette taille `[0,1 ; min(5−déployé, libre−plancher)]` SOL.

## Coûts réels journalisés par position (`ladder_costs`)

À l'ouverture : solde natif avant/après, frais de tx (base + priority), glissement
prix signal ↔ prix effectif, note avec le plan complet. À la clôture : même relevé,
plus `bin_arrays_created` et `rent_sol`.

**Refus d'entrée si création de bin arrays requise** : la range demandée doit être
couverte par des bin arrays existants (lecture SDK `getBinArrayAround` sur les ids
couvrant `[lowerBin, upperBin]`) ; sinon refus motivé — la rent d'un compte bin array
(~0,02–0,07 SOL) n'est remboursable que si le compte préexistait ou est réutilisé.
Note : `realOpenPosition` clamp silencieusement à 69 bins ; le ladder refuse au lieu
de clumper (fidélité au plan Claude).

## Journal comparé réel ↔ paper (`ladder_compare`)

Chaque ouverture/clôture réelles consigne : pool, token, taille réelle vs taille du plan
au même tick, σ/R/f24 de l'entrée. Le rapprochement avec le livre claude du dashboard 4003
se fait par `(pool_address, event)` — script de lecture fourni (`scripts/ladder-report.ts`,
section « Écart d'exécution »).

## Clôture fiable

`ladder-close.ts` : removeLiquidity 100 % + claim (via `realClosePosition`, qui attend la
finalization), puis revente de l'inventaire token→SOL. Pas de chemin ad-hoc dupliqué : la
revente passe par le sweep existant (`sweep-residues.ts`, seuil 5 $) ou `sell-residues-jup.ts`
si sous seuil — le close écrit un event `ladder-inventory-pending` que le sweep prend en charge
(garde `pilot_inventory` non applicable ici : inventaire marqué via la table dédiée).

## Limites connues (à discuter en revue, ne sont pas cachées)

- **OHLCV** : l'API Data renvoie 10 bougies DAILY quel que soit l'interval demandé (vérifié
  25/08, documenté dans `src/api.ts`). La σ « intraday » (M1) du paper utilise des ticks
  minute ; en réel on ne dispose que du journalier → **σ estimée plus grossière, sensibilité
  aux gaps intra-jour**. Acceptable pour la phase 1 (plafond 5 SOL, 1 position) ; à corriger
  par un échantillonneur interne (tick 5 min depuis les pools chauds du ws-monitor) avant
  montée en taille. C'est le principal point de divergence paper↔réel résiduel.
- **Frais de pool** : `fee_tvl_ratio_1h` est extrapolé ×24 pour `f.feeTvl1h` (convention
  « par jour » du policy) ; le paper calcule sur fenêtre glissante exacte — léger biais.
- **Mark temps réel** : `markInfo` recalcule la composition depuis les montants on-chain de
  `getPositionAllLiquidity` + prix courant ; les compteurs `aboveTicks/belowTicks` sont tenus
  par tick de monitor (latence ~1 min entre deux passes, contre tick continu côté paper).
  X1/X3 peuvent donc se déclencher jusqu'à 1 tick plus tard qu'en paper — mesuré par
  `ladder_compare`, pas caché.
- **Rent du compte de position** : ~0,025 SOL non récupérables tant que le compte vit
  (fermeture = remboursement du rent deposit, vérifié sur les closes passées). Journalisé.

## Tests fournis

- `scripts/_ladder-selftest.ts` : passe sans réseau — compare sur 12 marchés synthétiques
  les verdicts `claudePolicy.entry/exit` chargés via le vendor vs les verdicts attendus
  (table de cas extraite des events paper du run A/B). `npm run typecheck` + ce test doivent
  passer avant revue.
- Test d'échelle réel à blanc : dry-run `ladder-open --pick=<pool>` sur un pool conforme,
  puis ouverture à **0,1 SOL** avec `--confirm` après GO David (étape prévue au planning,
  pas dans cette PR).

## Comment activer (après fusion ET levée explicite de la pause)

```bash
# .env : REAL_LADDER=true            # seul switch ; RIEN ne tourne sans lui
bash scripts/dlmm-run.sh ladder:open --pick=<pool>          # dry-run
bash scripts/dlmm-run.sh ladder:open --pick=<pool> --confirm=LADDER-REAL-OPEN
bash scripts/dlmm-run.sh ladder:monitor                     # décisions X1/X2/X3 (dry-run)
bash scripts/dlmm-run.sh ladder:close --id <N> --confirm=LADDER-REAL-CLOSE
```

Aucun cron branché dans cette PR : la cadence de surveillance sera décidée avec les
premiers chiffres d'écart d'exécution.
