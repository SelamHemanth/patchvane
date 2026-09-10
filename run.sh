#!/bin/bash
# Start and stop the dashboard.
#
#     ./run.sh              start it, in the background, and give the
#                           prompt back
#     ./run.sh --stop       stop it
#     ./run.sh --restart    stop it and start it again
#     ./run.sh --status     say whether it is running, and where
#     ./run.sh --log        follow the log
#     ./run.sh --fg         run in this terminal instead, Ctrl-C to stop
#
# A first start also writes .env from .env.example, generates the session
# secret, checks the interpreter and installs anything requirements.txt
# asks for, so a fresh clone needs nothing but ./run.sh.  Settings live in
# .env, so nothing sensitive and nobody's address is in this file.
set -e
cd "$(dirname "$0")"

PY="${PYTHON:-python3}"
PIDFILE=.patchvane.pid
LOGFILE=patchvane.log

# The pid of a live server, or nothing.  A pidfile left behind by a machine
# that lost power names a pid that is gone, or worse one that something else
# is now using, so check the process is really ours before believing it.
live_pid() {
  local pid
  [ -f "$PIDFILE" ] || return 1
  pid=$(cat "$PIDFILE" 2>/dev/null) || return 1
  case "$pid" in "" | *[!0-9]*) return 1 ;; esac
  kill -0 "$pid" 2>/dev/null || return 1
  case "$(ps -p "$pid" -o args= 2>/dev/null)" in
    *serve.py*) printf '%s\n' "$pid" ;;
    *) return 1 ;;
  esac
}

where() {
  . ./.env 2>/dev/null || true
  printf 'http://%s:%s/\n' "${PATCHVANE_HOST:-127.0.0.1}" \
                           "${PATCHVANE_PORT:-8787}"
}

stop_it() {
  local pid
  if ! pid=$(live_pid); then
    rm -f "$PIDFILE"
    echo "Patchvane is not running."
    return 0
  fi
  kill "$pid" 2>/dev/null || true
  # Give it a moment to close the socket, then insist.  Without the wait a
  # restart can find the port still held by the process it just asked to go.
  local i
  for i in $(seq 1 50); do
    kill -0 "$pid" 2>/dev/null || break
    sleep 0.1
  done
  if kill -0 "$pid" 2>/dev/null; then
    kill -9 "$pid" 2>/dev/null || true
    sleep 0.3
  fi
  rm -f "$PIDFILE"
  echo "Stopped Patchvane (pid $pid)."
}

case "${1:-}" in
  --stop | stop)
    stop_it
    exit 0
    ;;
  --status | status)
    if pid=$(live_pid); then
      echo "Patchvane is running (pid $pid) on $(where)"
    else
      echo "Patchvane is not running."
      exit 1
    fi
    exit 0
    ;;
  --log | log)
    [ -f "$LOGFILE" ] || { echo "No $LOGFILE yet."; exit 1; }
    exec tail -f "$LOGFILE"
    ;;
  --restart | restart)
    stop_it
    ;;
  --fg | -f | --stop-after) ;;
  "" ) ;;
  -h | --help | help)
    sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "Unknown option: $1" >&2
    echo "Try: ./run.sh --help" >&2
    exit 1
    ;;
esac

if pid=$(live_pid); then
  echo "Patchvane is already running (pid $pid) on $(where)"
  echo "  ./run.sh --restart   to pick up a change"
  echo "  ./run.sh --stop      to stop it"
  exit 0
fi

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

if [ "${1:-}" = "--fg" ] || [ "${1:-}" = "-f" ]; then
  exec "$PY" serve.py --host "$HOST" --port "$PORT" --interval "$INTERVAL"
fi

# Background by default: this is a dashboard somebody leaves running, and
# holding the terminal for it only means the terminal cannot be used.
: > "$LOGFILE"
nohup "$PY" serve.py --host "$HOST" --port "$PORT" --interval "$INTERVAL" \
      >> "$LOGFILE" 2>&1 &
pid=$!
printf '%s\n' "$pid" > "$PIDFILE"

# Confirm it is really up rather than reporting a pid that has already died
# on a port in use or a bad config.
for i in $(seq 1 40); do
  kill -0 "$pid" 2>/dev/null || break
  grep -q "listening on" "$LOGFILE" 2>/dev/null && break
  sleep 0.1
done

if ! kill -0 "$pid" 2>/dev/null; then
  rm -f "$PIDFILE"
  echo "Patchvane did not start:" >&2
  sed 's/^/  /' "$LOGFILE" >&2
  exit 1
fi

echo "Patchvane is running (pid $pid) on http://$HOST:$PORT/"
echo "  ./run.sh --log     follow the log ($LOGFILE)"
echo "  ./run.sh --stop    stop it"
