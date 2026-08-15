# Sécurité — DLMM Bot

## Principe

**PAPER ONLY.** Le bot ne signe et n'envoie aucune transaction tant que deux
conditions ne sont pas réunies à la main dans `.env` :

```
REAL_MODE=true
REAL_CONFIRM=CONFIRMED-REAL-MODE
```

La garde (`assertPaperOnly()` dans `src/config.ts`) couvre toutes les
fonctions de `src/real.ts` : sans ces deux variables, tout appel de mode réel
lève une exception. Le code de production (scan, paper, dashboard, rapports)
n'importe jamais `src/real.ts` — le SDK Solana n'est chargé qu'en mode réel
(import dynamique CJS via `createRequire`).

## Règles

1. Ne jamais mettre de clé privée dans `package.json`, README ou un fichier
   versionné — uniquement `.env` (gitignoré) ou variable d'environnement.
2. `WALLET_PRIVATE_KEY` est en base64 (32 octets) — à générer hors-ligne.
3. Mode réel : valider d'abord sur **devnet**, puis **shadow** (positions
   réelles minuscules avec suivi paper parallèle), puis **pilote** (cap de
   capital), puis scale. Décision humaine à chaque étape — jamais automatique.
4. Le mode réel actuel est un adapter minimal, PAS revu par un auditeur :
   les montants bruts (decimals), les frais dynamiques et les cas limites
   (out-of-range, one-sided) doivent être validés avant tout fonds.
5. Redaction des logs : aucune clé ni secret n'est loggé ; les événements ne
   contiennent que des montants et des adresses de pools.
6. Pas de conseil financier : DLMM = risque de perte en capital (IL, sortie
   de range, rug, frais dynamiques).

## Dépendances à risque

- `@meteora-ag/dlmm` v1.9.x : import ESM cassé (bug @coral-xyz/anchor) →
  on utilise `createRequire`. Le .d.ts du paquet est mal formé → types
  assouplis (`any`) dans `src/real.ts` uniquement.
- `better-sqlite3` : binaire natif, ABI node v24 (137). Si
  `NODE_MODULE_VERSION` mismatch : `npm rebuild better-sqlite3` avec node v24.
