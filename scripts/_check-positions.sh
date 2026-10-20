#!/usr/bin/env bash
# Vérifie les 2 positions omo rouvertes (solde x2 + comptes on-chain + DB).
set -euo pipefail
W=${WALLET_ADDRESS:?définir WALLET_ADDRESS}
echo "=== solde natif (x2) ==="
for i in 1 2; do
  curl -s --max-time 15 -X POST https://api.mainnet-beta.solana.com -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getBalance\",\"params\":[\"$W\"]}" \
    | python3 -c "import json,sys; print('  ', round(json.load(sys.stdin)['result']['value']/1e9,4),'SOL')"
  sleep 1
done
echo "=== comptes positions on-chain ==="
for P in EgCFXH3hhhaA2sacxzJUeo3xhf39HTLPjMpo4bcvss8P 5FPi611WeDF7kddD9PLaXUbUGL4PRbji6xqB1QEjKuV5; do
  curl -s --max-time 15 -X POST https://api.mainnet-beta.solana.com -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"getAccountInfo\",\"params\":[\"$P\",{\"encoding\":\"base64\"}]}" \
    | python3 -c "import json,sys; r=json.load(sys.stdin).get('result',{}).get('value'); print('  $P :', 'EXISTE' if r else 'ABSENT', '|', r['lamports'] if r else 0)"
done
echo "=== DB real_positions ==="
cd /home/polybot/dlmm-bot
python3 -c "
import sqlite3
c=sqlite3.connect('data/dlmm-bot.db')
for r in c.execute(\"SELECT id,name,status,deposit_usd,amount_y,min_bin_id,max_bin_id,substr(sig,1,14) FROM real_positions WHERE status='open' ORDER BY id\"):
    print('  #%s %s %s %s\$ %s SOL bins %s→%s sig=%s' % r)
"
