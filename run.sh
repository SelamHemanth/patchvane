#!/bin/bash
# Start the dashboard.
#
# Reads its settings from .env, so nothing sensitive and nobody's address
# lives here.  Start from .env.example; MAINLINE_SECRET signs the session
# cookie and wants to stay stable, or every sign-in is forgotten on restart.
set -e
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "No .env yet. Start from the template:" >&2
  echo "  cp .env.example .env && chmod 600 .env" >&2
  echo "Then put a MAINLINE_SECRET in it and run this again." >&2
  exit 1
fi
. ./.env

exec python3 serve.py \
  --host "${MAINLINE_HOST:-127.0.0.1}" \
  --port "${MAINLINE_PORT:-8899}" \
  --interval "${MAINLINE_INTERVAL:-30}"
