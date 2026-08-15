# DLMM Bot — Opportunités & Gestion de liquidité Meteora/Jupiter DLMM (Solana)

Bot de détection d'opportunités DLMM (Dynamic Liquidity Market Maker, les pools
à bins de Meteora/Jupiter) : scan des pools, scoring, stratégies, positions
paper, frais, suivi du portefeuille et dashboard. **Paper trading par défaut —
aucune transaction réelle sans décision humaine explicite.**

## Fonctionnalités

- **Scan d'opportunités** : top pools par volume (Data API officielle
  `dlmm.datapi.meteora.ag`), filtres de sécurité (TVL, volume, âge, blacklist,
  fees/TVL), volatilité réalisée (OHLCV 1h → σ journalière), score composite
  0-100 (APR des frais, stabilité du volume, TVL) + signaux.
- **Stratégies** : presets officiels `spot-concentrated`, `spot-spread`,
  `spot-wide`, `curve`, `bidask` — l'écart de bins s'adapte à la volatilité.
- **Positions paper** : ouverture simulée (dépôt 50/50 en valeur), évaluation
  à la Uniswap v3 (IL concentré), frais simulés à partir du ratio fees/TVL,
  rebalance auto quand le prix dérive (friction 0,3 %), hard stop −40 %/jour,
  claims de frais au seuil.
- **Suivi portefeuille** : valeur, PnL net, frais cumulés, IL, snapshots,
  journal d'événements, rapport quotidien.
- **Dashboard** : serveur HTTP zéro-dépendance (port 4001), thème Chantier,
  auto-refresh 60 s, données live depuis la DB ou JSON exporté.
- **Mode réel (verrouillé)** : adapter SDK `@meteora-ag/dlmm` v1.9 pour
  ouvrir/consulter de vraies positions — exécution refusée sauf
  `REAL_MODE=true` + `REAL_CONFIRM=CONFIRMED-REAL-MODE`.

## Démarrage rapide

```bash
cd /home/polybot/dlmm-bot
export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm use 24   # node v24 requis
cp .env.example .env
npm install

npm run scan:pools     # scan + scoring des opportunités
npm run open:paper     # ouvre les positions paper sur les meilleures opportunités
npm run update:pnl     # mark-to-market des positions
npm run monitor        # une passe scan + mark ; --loop pour le démon
npm run report:daily   # rapport quotidien
npm run dashboard      # http://192.168.1.87:4001 (ouvrir le port dans ufw si besoin)
```

## Scripts / crontab suggérés

```cron
*/15 * * * * cd /home/polybot/dlmm-bot && /home/polybot/.nvm/versions/node/v24*/bin/node /home/polybot/dlmm-bot/node_modules/tsx/dist/cli.mjs scripts/monitor.ts >> logs/monitor.log 2>&1
0 6 * * * cd /home/polybot/dlmm-bot && /home/polybot/.nvm/versions/node/v24*/bin/node /home/polybot/dlmm-bot/node_modules/tsx/dist/cli.mjs scripts/report-daily.ts >> logs/report.log 2>&1
@reboot cd /home/polybot/dlmm-bot && /home/polybot/.nvm/versions/node/v24*/bin/node /home/polybot/dlmm-bot/node_modules/tsx/dist/cli.mjs scripts/start-dashboard.ts >> logs/dashboard.log 2>&1
```

## Hypothèses de la simulation paper (honnêtes)

- Valeur des positions : approximation continue Uniswap v3 d'un range discret
  de bins (math exacte au bin près = plus lourde, écart faible pour des
  ranges > 5 bins).
- Prix du quote token en USD : dérivé du TVL du pool (`tvl / (x·p + y)`) —
  fallback 1 $ pour les pools USDC.
- Frais : part de la position = `fees/TVL 1h × valeur × heures × en-range`.
  Ne capte ni la distribution exacte par bin ni la dynamique des frais
  (fees dynamiques) — ordre de grandeur fiable, pas une promesse.
- Rebalance : friction forfaitaire 0,3 % (gas + spread estimés).

## Sources

Voir `RESEARCH.md` (tutos, repos GitHub analysés, doc officielle) et
`SAFETY.md` (gardes d'exécution). Le mode réel n'a PAS été testé avec des
fonds : à valider sur devnet d'abord, puis en shadow, puis en pilote —
jamais automatiquement.
