#!/bin/bash
# Start the dashboard.
#
# Reads its settings from .env, so nothing sensitive and nobody's address
# lives here.  Start from .env.example; PATCHVANE_SECRET signs the session
# cookie and wants to stay stable, or every sign-in is forgotten on restart.
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "No .env yet. Start from the template:" >&2
  echo "  cp .env.example .env && chmod 600 .env" >&2
  echo "Then put a PATCHVANE_SECRET in it and run this again." >&2
  exit 1
fi
. ./.env

# MAINLINE_ is the name these had before the rename; a .env written against
# the old template still works.
HOST="${PATCHVANE_HOST:-${MAINLINE_HOST:-127.0.0.1}}"
PORT="${PATCHVANE_PORT:-${MAINLINE_PORT:-8899}}"
INTERVAL="${PATCHVANE_INTERVAL:-${MAINLINE_INTERVAL:-30}}"

if [ -z "${PATCHVANE_SECRET:-${MAINLINE_SECRET:-}}" ]; then
  echo "PATCHVANE_SECRET is empty; sign-ins will not survive a restart." >&2
  echo "  openssl rand -hex 32" >&2
fi

exec python3 serve.py --host "$HOST" --port "$PORT" --interval "$INTERVAL"
