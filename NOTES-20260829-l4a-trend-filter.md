# L4-A — Filtre de tendance (shadow) — 2026-08-29

## Ce qui est codé (live, cron */5)

`analyzeTrend(candles)` dans src/strategies.ts : trois signaux sur les bougies
daily déjà fetchées (0 requête API) :
- drift24h = close d'aujourd'hui vs close de la veille (bougies DAILY — l'API
  ignore interval et renvoie 10 daily, le seul horizon dispo)
- RSI(7) qui remonte (rsiNow > rsiPrev)
- prix > SMA(7) des closes

`downTrend` = les TROIS négatifs ensemble (tendance baissière CONFIRMÉE,
profil de dump mortel −50/−68 %).

Au scan (scanner.ts) : badge « ⚠️ shadow L4-A (pas de tendance …) » quand
downTrend, badge « 📈 tendance (L4-A) » quand haussier confirmé.

## Mode SHADOW — décision structurée (contrainte David : ne pas sacrifier les fees)

`TREND_FILTER_SHADOW=true` par défaut (config.ts) : le filtre LOGGE ses
rejets, il ne bloque AUCUNE ouverture → 0 fee perdue. Veto possible via
`TREND_FILTER_SHADOW=false` (topblast/resurrect exclus par construction).

## Rejeu fees (scripts/trend-replay.ts, 53 closes réelles)

AURAIT REJETÉ 13 positions : net −14 $, fees +147 $, pur −161 $.
GARDÉES 40 positions : net −891 $, fees +475 $.

**VERDICT : NE PAS ACTIVER le veto.** Le veto sacrifierait 23,7 % de la
collecte (147 $) pour économiser 14 $ de perte nette. Les dumps mortels sont
AUSSI les gros collecteurs (volatilité = fees) — bloquer les downTrend
casserait le fee-harvesting qui est le moteur du bot. Le filtre reste un
badge informatif (dashboard + base), utile pour le choix de tokens du pilote
L4-B (specs dans NOTES-20260829-l4b-pilot-specs.md).

## Leçon générale

Un filtre d'entrée sur la TENDANCE n'est pas un filtre sur la COLLECTE : les
deux dimensions sont décorrélées. Tout veto d'entrée doit être validé par un
rejeu fees (perte nette évitée vs collecte sacrifiée) avant activation — la
doctrine « gagner petit et souvent » passe par les fees, pas par la sélection.
