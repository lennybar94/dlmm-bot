# Incident 2026-08-27 14:35 — blocage real-monitor (ws Helius 429)

Statut : RÉSOLU (fix polling HTTP commité).

## Chronologie

- 14:35 CEST : run real-monitor démarre ; après le mark de Zoe (4e position),
  l'autoClose de Morty (oor-redeploy : OOR, PnL ≥ 0) envoie une tx →
  `sendAndConfirmTransaction` → confirmation via signatureSubscribe (ws
  interne web3.js) → handshake ws Helius **429** → la souscription ne
  s'établit jamais → la confirmation pend → **le run se bloque** (flock pris).
- 14:37 : claim AUTO Zoe "échoué" (TransactionExpiredBlockheightExceeded) et
  sweep Zoe "échoué" (TransactionExpiredTimeout) — **faux échecs** : les deux
  txs sont PASSÉES on-chain (finalized, vérifié 15:04).
- 14:35→15:04 : 1455 erreurs "ws error: Unexpected server response: 429"
  (~1/s, boucle de reconnexion web3.js), plus aucun mark, plus de runs
  suivants (flock -n échoue silencieusement).
- 15:00 : watchdog alerte (marks stale 1357s > 15 min).

## Cause racine

1. **Saturation du tier ws Helius** : DEUX process ws-pool-monitor en double
   depuis le 25/08 (2553018 inactif + 2553342 actif) → handshake ws 429.
2. **web3.js 1.98 confirme les txs par signatureSubscribe (ws)** :
   `confirmTransaction` attend la souscription AVANT de poller
   getSignatureStatus → quand le ws 429, la confirmation pend indéfiniment
   et **un auto-close peut geler toute la surveillance** (le pire scénario
   pour un filet de sécurité).

## Correctifs

1. **Immédiat (14:35-15:05)** : kill du run bloqué (2 process : wrapper flock
   + node réel — tuer les DEUX, le lock est hérité par le child) ; kill du
   doublon ws-pool-monitor (2553018) → tier ws libéré → surveillance rétablie
   (runs 1 min, zéro nouvelle erreur ws).
2. **Durable (commit…)** : `sendWithRetry` (src/real.ts) n'utilise plus
   sendAndConfirmTransaction — envoi via `conn.sendTransaction` (HTTP pur,
   identique à sendAndConfirmTransaction ligne 2273) + confirmation par
   **POLLING getSignatureStatus** (HTTP pur, 1,5 s, timeout 60 s, retry 3×).
   Plus AUCUNE dépendance au ws pour open/close/claim (le sweep utilisait
   déjà sendRawTransaction). Le run ne peut plus se bloquer sur le ws.
   Validation : sig complète du close CYBERLEEK → finalized OK via
   getSignatureStatus.

## Leçons (règles générales)

- **Ne jamais confirmer une tx par souscription ws** dans un process
  cronné/flocké : un échec ws pend la confirmation et gèle le run. Polling
  getSignatureStatus uniquement.
- **Un doublon de process ws = saturation du tier ws** : vérifier
  `ps aux | grep` avant de conclure à un problème Helius.
- **TransactionExpired… ≠ tx perdue** : vérifier le statut on-chain de la sig
  (getSignatureStatus avec searchTransactionHistory) avant de retenter/écrire
  un échec (le cooldown d'échec évite le spam, mais le sweep re-swapperait
  des tokens déjà vendus).
- **kill d'un run flocké** : tuer le process node réel (le lock est tenu par
  le child, pas par le wrapper flock).
