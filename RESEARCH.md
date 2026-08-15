# Recherche — ce qui a été retenu et d'où ça vient

Recherche effectuée le 15/08/2026. Objectif : construire un bot DLMM
(Meteora/Jupiter DLMM, Solana) en regroupant le meilleur des tutoriels,
repos GitHub et de la doc officielle.

## Sources officielles (validées en live)

- **DLMM Data API** — `https://dlmm.datapi.meteora.ag` (swagger :
  `/swagger-ui/`). Rate limit 30 RPS. Endpoints clés utilisés :
  - `GET /pools?sort_by=volume_24h:desc&filter_by=...` (pag. max 1000)
  - `GET /pools/{address}` (état courant : prix, fees/TVL par fenêtre, TVL)
  - `GET /pools/{address}/ohlcv?interval=1h` (volatilité)
  - `GET /portfolio`, `/portfolio/open`, `/portfolio/total` (PnL réel — pour
    la phase pilote)
  - `GET /positions/{address}/historical` (événements add/remove/claim)
  - Détail des champs : `apr`, `apy`, `fee_tvl_ratio.{30m,1h,2h,4h,12h,24h}`,
    `fees`, `volume`, `pool_config.{bin_step,base_fee_pct,protocol_fee_pct}`,
    `tvl`, `launchpad`, `is_blacklisted`, `token_x/y`, `created_at`.
  - ⚠️ `fee_tvl_ratio` est en **pourcentage** (2,5 = 2,5 %) → APR =
    ratio/100 × 365 × (1 − protocol_fee).
- **SDK `@meteora-ag/dlmm`** (307 ⭐, `MeteoraAg/dlmm-sdk`) — v1.9.x :
  - ⚠️ l'API a changé : plus de classe statique `DLMM`, c'est `create(conn,
    addr, {cluster})` à la racine. `StrategyType` = {Spot:0, Curve:1, BidAsk:2}.
  - ⚠️ l'import ESM casse (`ERR_UNSUPPORTED_DIR_IMPORT` via
    @coral-xyz/anchor) → `createRequire` en CJS.
  - Méthodes : `getActiveBin`, `initializePositionAndAddLiquidityByStrategy`,
    `addLiquidityByStrategy`, `removeLiquidity({shouldClaimAndClose})`,
    `claimAllRewardsByPosition`, `getPositionsByUserAndLbPair`, `swapQuote`,
    `placeLimitOrder`. Exemple officiel testé en lecture seule sur mainnet
    (pool ANSEM-SOL, bin actif 554).
  - Docs : docs.meteora.ag/llms.txt → `typescript-sdk/{getting-started,
    reference,examples}.md`, `core-products/dlmm/strategies-and-use-cases.md`.
- **Shapes de liquidité** (doc officielle) : Spot (uniforme), Curve
  (concentré au centre — stables), BidAsk (bords — volatils/DCA), presets
  produit Spot-Concentrated (1-3 bins), Spot-Spread (20-30), Spot-Wide (~50).
  Bin step petit = marché serré, grand = volatile. Le bin step pilote la base
  fee. Formule de prix d'un bin : `(1 + bin_step/10000)^binId`.

## Repos GitHub analysés (ce qu'on en retient)

| Repo | Apport retenu |
|---|---|
| `DitherAI/MeteorShower` (recentrage) | Recentrage auto quand `\|bin actif − centre\| > seuil × demi-range` (0,45) ; buffer SOL ; slippage/price impact ; intervalle de monitor. → implémenté (rebalance paper, `REBALANCE_THRESHOLD`). |
| `createMonster/meteora_meme` (fee harvest) | Screening (mcap, vol/mcap ≥ 15 %, âge ≥ 60 j) ; vol réalisée → tier de frais (σ<5 % → 0,05 %, 5-15 % → 0,30 %, ≥15 % → 1 %) ; double range core ±15 %/outer ±40 % ; hard stops (−40 %/j, −70 % vs ATH) ; liquidité drainée < 30 % de la moyenne 14 j. → screening + stops + vol→span adaptés. |
| `mrthomasbigproblem/meteora-dlmm-bot` | Pool scanner + estimation d'APR + SQLite comme store ; wrappers Jupiter/Meteora. → architecture scanner → store SQLite reprise. |
| `machenxi/meteora-dlmm-copytrading-bot` | Copie de stratégies LP + suivi PnL par follower (frais + mouvement de prix + liquidité). → idée de suivi fees/IL par position reprise. |
| `fciaf420/meteora-dlmm-mcp` | MCP combinant REST API + SDK + zap-sdk (18 outils). → confirme le choix REST pour le data et SDK pour l'exécution. |
| Hummingbot (gateway Meteora) | 6 strategy types (Spot/Curve/BidAsk × Imbalanced/Balanced). → confirme la famille de stratégies. |

## Tutoriels / analyses

- madeonsol.com : comparatif DLMM vs Orca vs Raydium CLMM, gestion de range
  et d'IL. → base du choix d'approximation IL Uniswap v3.
- BitFashioned : avantage de cibler des bins précis (standard UI insuffisant).
- OpenLiquid : stratégies de volume, anti-MEV.
- Medium (Meteora) : guide LP JUP launch — distribution Spot/Curve/BidAsk.

## Non retenus / écartés

- Bots "bundler/pump.fun" (mrthomasbigproblem vend aussi des bundlers) :
  hors périmètre, risque éthique/technique.
- DEX Screener/Birdeye comme source primaire : l'API officielle DLMM suffit.
- zap-sdk : utile pour unifier swaps + position en 1 tx en mode réel — à
  ajouter en phase pilote si besoin.

## Décisions d'architecture

1. **Paper-first** (même philosophie que le Polymarket copy bot) : prouver
   l'edge en simulation, rollout humain-approuvé (shadow → pilot → scale).
2. **TS + SQLite (better-sqlite3) + CLI scripts + dashboard HTTP** : pattern
   éprouvé du copy bot, zéro build pour le dashboard.
3. **Data API pour le data, SDK pour l'exécution** : le scan ne charge jamais
   le SDK (léger, rapide, rate limit 30 RPS géré).
4. **Garde d'exécution** : mode réel impossible sans 2 variables explicites
   dans `.env` (cf. SAFETY.md).
