# Consigne verdict lundi 09/09 — test parallèle spot-spread (ouvert 08/09)

## Décision prise 08/09 (go David « va s'y »)

Question posée : basculer le sizing vers spot-spread immédiatement ?
Réponse retenue : NON pas de bascule sèche (échantillon n=4 closes, +46,92 $,
marge d'erreur ±12 $ sur la moyenne = indiscernable de zéro ; et strategyByVol
route les pools vol-haute vers bidask-dip par construction). À la place :
**test parallèle à taille fixe via le pilote L4-B existant**.

## État du test au 08/09 ~13:00

- Manche tendance (pilot=1, spot-spread balancé, sleeve TREND_SLEEVE_SHARE=40 %) :
  - #105 HYPE-SOL 500 $ — ouvert 01/09, net +14,00 $, in-range.
  - #164 MET-SOL 500 $ — ouvert 08/09 02:17, net -6,03 $, in-range.
  - #166 ANTHROPIC-SOL 500 $ — OUVERT AUJOURD'HUI (this file's subject) :
    achat 2,455 SOL → 0,267 ANTHROPIC (sig 5LoVHksj…), position 2,4069 SOL +
    token, range 265→289 (±9 %, bin_step 80), sig 5Vg9habB…, pubkey DXCV3tMq…
    Gardes L4-B passées : âge 238 j, TVL 163k$, vol24h 1,17M$, RSI 61, >MA7,
    pas de downTrend, garde manche tendance 61 % après ouverture.
- Manche memes (bidask-dip) : intacte, non touchée — le test est parallèle, pas
  soustractif.

## Critère de bascule PRÉ-ENREGISTRÉ (non négociable a posteriori)

Fenêtre : closes pilot=1 du 03/09 00:00 → verdict.
- **GO bascule sizing** si spot-spread moyenne > +5 $/position ET bidask-dip
  moyen < 0 sur la même fenêtre, avec n ≥ 6 closes spot-spread.
- **NO-GO / arrêt dip** si spot-spread ≤ 0 ou n < 6 (l'échantillon ne permet
  toujours pas de trancher → on garde le bidask-dip jugé sur ses propres
  chiffres au circuit-breaker).
- Valeurs d'entrée connues au 08/09 pour la fenêtre post-03/09 :
  spot-spread closes : JUP +18,39, ANTHROPIC +20,65, cbBTC -6,80 (n=3, moy +10,75) ;
  bidask-dip : -412,26 sur 46 (moy -8,96). ⚠️ n=3 sous le seuil n≥6 → tel quel,
  critère = NO-GO bascule, verdict binaire sur le dip seulement.

## Kill-switch #166

REAL_MODE=true REAL_CONFIRM=CONFIRMED-REAL-MODE npm run real:close -- --id 166 --bps 10000
(le close rend le token → sweep normal vers SOL ; surplus d'achat ~2 % reste au wallet)

## Ce que le circuit-breaker de lundi doit consolider

1. BILAN GLOBAL (convention e78500b : dernier mark des closes, net fees incluses).
2. Débit journalier pré (27/08→03/09 : -224 $/j) vs post (03/09→09/09).
3. Verdict calibrage L4b reporté (#108 clos 08/09, net -6,80 $) — intégrable ici.
4. Appliquer le critère ci-dessus CHIFFRÉ EN DUR, date de prochaine révision à
   l'appui (préférence David : décision + date, jamais « attendre voir »).
