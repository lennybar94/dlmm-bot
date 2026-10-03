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
# ⚠️ PATH des shells Hermes injecte ~/.hermes/tools/node-26 EN TÊTE → nvm ne fait
# que le déplacer plus bas, `node` reste résolu en v26 (ABI ≠ better-sqlite3,
# crash ERR_DLOPEN/AMBIGUOUS). Forcer le binaire exact du défaut nvm (fix 03/10).
NODE_BIN="$(ls -d "$HOME/.nvm/versions/node/v24."*/bin/node 2>/dev/null | sort -V | tail -1)"
[ -x "$NODE_BIN" ] && export PATH="$(dirname "$NODE_BIN"):$PATH"

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
# Script TS : soit un nom npm connu (scan:only → scripts/scan-only.ts), soit un
# CHEMIN direct relatif au repo (ex. lab/run.sh scripts/lab-init.ts) — requis
# par les scripts hors mapping cron (lab-init.ts, fix 03/10).
arg="${1:-}"
shift || true
if [[ "$arg" == *.ts ]]; then
  exec node node_modules/tsx/dist/cli.mjs "$arg" "$@"
fi
script="${arg//:/-}"
exec node node_modules/tsx/dist/cli.mjs "scripts/${script}.ts" "$@"
