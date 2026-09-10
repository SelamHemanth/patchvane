#!/bin/bash
# Start the dashboard.  From a fresh clone this is the only command needed:
#
#     ./run.sh
#
# It checks the interpreter, writes a .env from the template if there is
# none, generates the session secret the first time, installs anything
# requirements.txt asks for, and starts the server.  Settings are read from
# .env, so nothing sensitive and nobody's address lives in this file.
set -e
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"

if ! command -v "$PY" >/dev/null 2>&1; then
  echo "No $PY on PATH. Patchvane needs Python 3.10 or later." >&2
  exit 1
fi

# collect.py annotates with `float | None`, which parses only on 3.10 and up,
# and the failure without this check is a SyntaxError from an import.
if ! "$PY" -c 'import sys; raise SystemExit(sys.version_info < (3, 10))'; then
  echo "Patchvane needs Python 3.10 or later; $PY is $("$PY" -c \
    'import platform; print(platform.python_version())')." >&2
  exit 1
fi

# First run: start from the template instead of making it a manual step.
if [ ! -f .env ]; then
  if [ ! -f .env.example ]; then
    echo "Neither .env nor .env.example is here; is this the checkout?" >&2
    exit 1
  fi
  cp .env.example .env
  chmod 600 .env
  echo "Wrote .env from .env.example."
fi

. ./.env

# The secret signs the session cookie, so it has to outlive the process or
# every restart signs everybody out.  Generate it once into .env rather than
# per run.  Written by python to avoid quoting the value into sed.
if [ -z "${PATCHVANE_SECRET:-${MAINLINE_SECRET:-}}" ]; then
  "$PY" - <<'EOF'
import re
import secrets

key = secrets.token_urlsafe(48)
with open(".env", encoding="utf-8") as fh:
    text = fh.read()
line = "export PATCHVANE_SECRET=%s" % key
text, hits = re.subn(r"(?m)^[ \t]*#?[ \t]*export PATCHVANE_SECRET=.*$",
                     line, text, count=1)
if not hits:
    text = text.rstrip("\n") + "\n\n" + line + "\n"
with open(".env", "w", encoding="utf-8") as fh:
    fh.write(text)
EOF
  chmod 600 .env
  echo "Generated a PATCHVANE_SECRET in .env."
  . ./.env
fi

# requirements.txt is all comments on purpose: this runs on the standard
# library alone.  Install only if somebody has added a real line to it, so
# the usual run does not need pip at all.
if [ -f requirements.txt ] && grep -qE '^[[:space:]]*[^#[:space:]]' requirements.txt; then
  echo "Installing from requirements.txt..."
  "$PY" -m pip install --quiet --disable-pip-version-check -r requirements.txt
fi

# MAINLINE_ is the name these had before the rename; a .env written against
# the old template still works.
HOST="${PATCHVANE_HOST:-${MAINLINE_HOST:-127.0.0.1}}"
PORT="${PATCHVANE_PORT:-${MAINLINE_PORT:-8787}}"
INTERVAL="${PATCHVANE_INTERVAL:-${MAINLINE_INTERVAL:-30}}"

exec "$PY" serve.py --host "$HOST" --port "$PORT" --interval "$INTERVAL"
