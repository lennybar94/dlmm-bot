# DLMM LAB — bac à sable « paper money » du bot DLMM

Clone du bot (`/home/polybot/dlmm-bot`) qui tourne sur sa PROPRE base SQLite et
avec ses PROPRES réglages, pour jouer librement avec les filtres sans jamais
toucher au wallet réel ni polluer la base de production.

## Isolation (par construction)

- `DLMM_DB_PATH` → `lab/data/lab.db` (jamais `data/dlmm-bot.db`).
- `REAL_MODE=false` + `WALLET_PRIVATE_KEY` retiré de l'environnement par
  `run.sh` ET par `src/config.ts` quand `LAB_MODE=true` : le mode réel est
  structurellement impossible ici, pas seulement déconseillé.
- `lab/.env` ne contient AUCUN secret (clé privée refusée au chargement).
- Telegram coupé en lab (les notifications du monitor restent en base/logs).
- Le lab ne lit JAMAIS le `.env` de production ; il a son propre fichier.

## Lancer

```bash
cd /home/polybot/dlmm-bot
lab/run.sh init            # seed: règles actuelles de prod + snapshot des filtres
lab/run.sh monitor         # 1 passe = scan live API + mark positions ouvertes
lab/run.sh open-paper      # ouvre des positions paper sur le dernier scan
lab/run.sh report-daily    # état du portefeuille paper du lab
lab/run.sh shell 'sqlite3 lab/data/lab.db ".tables"'
```

## Jouer avec les filtres

Modifier `lab/.env` (ex. `MIN_TVL=50000`, `MAX_TOPBLAST_POSITIONS=2`,
`VALUE_STOP_LOSS=0.15`…) puis relancer `monitor`. Les clés lues sont les mêmes
que la prod (src/config.ts) ; tout ce qui n'est PAS dans lab/.env prend le
défaut du code. Pour comparer proprement : un run par réglage, même fenêtre.

## Ce que le lab partage avec la prod (lecture seule ou copié au init)

- Le CODE (mêmes src/, scripts/) — donc toute règle implémentée dans le bot est
  testable ici immédiatement.
- Les RÈGLES versionnées (rule_sets) copiées au `init` dans lab.db (le tuner
  du lab itère sur la copie, jamais l'originale).
- La DATA API Meteora (live, mêmes endpoints que la prod).

## Limites connues (honnêtes)

- Pas de replay historique : le lab marque les positions AU PRÉSENT (comme le
  bot paper). Tester un filtre sur une fenêtre passée = re-run pendant que la
  fenêtre se déroule, ou script de simulation dédié.
- `open:paper` en lab ouvre du PAPER (table paper_positions), jamais réel.
- Les événements du lab (blacklists, cooldowns) vivent dans lab.db : ils ne
  migrent pas vers la prod et inversement.
