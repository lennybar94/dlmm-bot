#!/usr/bin/env bash
# LANCEUR DU LAB DLMM (paper uniquement, par construction).
# Le lab est un clone du bot qui tourne sur sa PROPRE base SQLite et avec son
# PROPRE .env : zéro contact avec data/dlmm-bot.db ni le wallet réel.
# Usage :
#   lab/run.sh <script-npm> [args...]     ex: lab/run.sh monitor
#   lab/run.sh shell '<cmd>'              exec une commande avec l'env du lab
set -u
LAB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOT_DIR="$(dirname "$LAB_DIR")"

export NVM_DIR="$HOME/.nvm"
# shellcheck disable=SC1091
. "$NVM_DIR/nvm.sh" >/dev/null 2>&1
nvm use 24 >/dev/null 2>&1

# SÉCURITÉ LAB — ces exports priment sur tout .env et verrouillent le mode paper :
export LAB_MODE=true
export DLMM_DB_PATH="$LAB_DIR/data/lab.db"
export REAL_MODE=false
unset REAL_CONFIRM WALLET_PRIVATE_KEY || true
export NODE_OPTIONS="--dns-result-order=ipv4first"

cd "$BOT_DIR" || exit 1
if [ "${1:-}" = "shell" ]; then
  shift
  exec bash -c "$*"
fi
script="${1//:/-}"
shift || true
exec node node_modules/tsx/dist/cli.mjs "scripts/${script}.ts" "$@"
