#!/usr/bin/env python3
"""Patchvane: serve the dashboard.

Local, the way it has always worked:

    python3 serve.py                    http://127.0.0.1:8787

Deployed, reachable from the internet, behind a TLS terminating proxy:

    python3 serve.py --hash-passphrase  once, to make a passphrase hash
    PATCHVANE_MODE=cloud \
    PATCHVANE_SECRET=... \
    PATCHVANE_PASSPHRASE_HASH=... \
    python3 serve.py

Cloud mode refuses to start without a session secret and a passphrase hash,
insists on HTTPS, masks every reviewer address on the way out and leaves the
private notes behind.  It is meant for one person: the one who sent the
patches.  There is no user model and no sharing, by design.

Every setting is an environment variable, so nothing secret is ever written
next to the code.  `--check` validates the configuration and exits, which is
what a container healthcheck and a deploy pipeline should call.
"""

from __future__ import annotations

import argparse
import base64
import getpass
import hashlib
import hmac
import http.cookies
import imaplib
import json
import mimetypes
import os
import re
import shutil
import secrets
import signal
import socketserver
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler

import providers
import redact
import vault

HERE = os.path.dirname(os.path.abspath(__file__))


def env(name: str, default: str = "") -> str:
    """A setting from the environment.

    The app was called Mainline before it was called Patchvane, so the old
    MAINLINE_ prefix is still honoured; a deployment that predates the rename
    keeps working without anyone editing their .env."""
    val = os.environ.get(name)
    if val is None and name.startswith("PATCHVANE_"):
        val = os.environ.get("MAINLINE_" + name[len("PATCHVANE_"):])
    return (val if val is not None else default).strip()


def env_flag(name: str, default: bool = False) -> bool:
    raw = env(name).lower()
    if not raw:
        return default
    return raw in ("1", "true", "yes", "on")


MODE = (env("PATCHVANE_MODE", "local") or "local").lower()
CLOUD = MODE == "cloud"

DATA_DIR = env("PATCHVANE_DATA_DIR") or HERE
CONFIG_PATH = env("PATCHVANE_CONFIG") or os.path.join(HERE, "config.json")
CONFIG = json.load(open(CONFIG_PATH))
providers.configure((CONFIG.get("ai") or {}).get("endpoints"))

SECRETS = os.path.join(DATA_DIR, "secrets.json")

# One directory per person, because one server collects for everybody who
# signs in.  The directory is named after a hash of the address rather than
# the address itself, so a listing of the disk does not read as a list of
# who uses this.
PEOPLE = os.path.join(DATA_DIR, "people")

APP = CONFIG.get("app_name", "Patchvane")

# The session cookie, and the header a same-origin request must carry.
COOKIE = "patchvane"

# The address in config.json, if there is one.  It is only a default now:
# whoever signs in gets their own patches, and this is what the passphrase
# route falls back to when nobody has said whose dashboard to show.
OWNER = (env("PATCHVANE_OWNER") or CONFIG.get("email")
         or "").strip().lower()


def home_of(email: str) -> str:
    """Where one person's collected patches live."""
    who = (email or "").strip().lower()
    return os.path.join(PEOPLE, hashlib.sha256(who.encode()).hexdigest()[:20])


def data_path(email: str) -> str:
    return os.path.join(home_of(email), "data.json")


def known_people() -> list:
    """Everyone this server has collected for, newest first.

    Read off the disk rather than kept in memory, so a restart does not
    forget who to keep up to date."""
    out = []
    for name in os.listdir(PEOPLE) if os.path.isdir(PEOPLE) else []:
        card = os.path.join(PEOPLE, name, "who.json")
        try:
            with open(card, encoding="utf-8") as fh:
                blob = json.load(fh)
            if blob.get("email"):
                out.append(blob)
        except Exception:
            continue
    out.sort(key=lambda b: b.get("seen") or "", reverse=True)
    return out


def remember_person(email: str) -> None:
    """Note that somebody signed in, so the timer knows to collect for them."""
    home = home_of(email)
    try:
        os.makedirs(home, exist_ok=True)
        card = os.path.join(home, "who.json")
        blob = {}
        if os.path.exists(card):
            try:
                with open(card, encoding="utf-8") as fh:
                    blob = json.load(fh)
            except Exception:
                blob = {}
        blob["email"] = email
        blob["seen"] = now_iso()
        blob.setdefault("first", blob["seen"])
        tmp = card + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(blob, fh)
        os.replace(tmp, card)
    except OSError as exc:
        log("could not record the sign-in: %s" % exc)

# Cloud filesystems are ephemeral and often read only, so a deployment keeps
# its keys in the environment and never writes them down.
ALLOW_SECRET_FILE = not CLOUD

SESSION_HOURS = int(env("PATCHVANE_SESSION_HOURS", "12") or 12)
MAX_BODY = 64 * 1024
STATIC = {"style.css", "ui.js", "app.js", "login.js", "index.html", "login.html"}

# Every inline handler was removed from the markup, so script-src needs no
# 'unsafe-inline' and no 'unsafe-eval'.  That is the half that matters: if a
# subject line ever slips past esc(), CSP is what stops it running as script.
#
# style-src does allow inline, because a bar chart is a stack of elements whose
# width is a number worked out at render time, and there is no way to express
# that in a stylesheet.  Nonces do not help here: CSP applies them to <style>
# elements and never to style attributes.  Nothing from the collected data
# reaches a style attribute anyway; every one is built from a palette constant
# or an arithmetic result.
CSP = ("default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
       "img-src 'self' data:; connect-src 'self'; font-src 'self'; "
       "form-action 'self'; frame-ancestors 'none'; base-uri 'none'")

COLLECT_LOCK = threading.Lock()
WAKE = threading.Event()
STOP = threading.Event()

# How often to collect, and whether to at all.  One setting for the server,
# because it is the server that does the fetching and it is one host's
# politeness budget being spent.
STATE = {
    "auto": True,
    "interval": 15,
    "next_run": None,
}

# What happened on the last collection, per person.
RUNS = {}
RUNS_LOCK = threading.Lock()


def state_of(email: str) -> dict:
    """The last run for one person, created empty the first time."""
    who = (email or "").strip().lower()
    with RUNS_LOCK:
        return RUNS.setdefault(who, {
            "running": False,
            "last_run": None,
            "last_ok": None,
            "last_summary": "",
            "last_error": "",
        })

# Keys given through the page live here until the process ends.  Writing
# them down is a separate, explicit choice.
# Keys typed into the page, kept per person and only until the process ends.
# Writing one down is a separate, explicit choice.
RUNTIME_KEY = {}
_CACHE = {}                     # email -> its collected file


# ------------------------------------------------------------------ logging


SECRET_HINT = ("passphrase", "password", "api_key", "apikey", "token",
               "secret", "authorization", "cookie")


def log(msg: str) -> None:
    low = str(msg).lower()
    if any(h in low for h in SECRET_HINT) and "=" in str(msg):
        msg = "[redacted]"
    sys.stderr.write("%s %s %s\n" % (
        datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        MODE, msg))
    sys.stderr.flush()


def quiet_addr(addr: str) -> str:
    """Even our own address does not belong in a log a host operator can read."""
    return redact.mask_addr(addr)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


# -------------------------------------------------------------- passphrase


SCRYPT = dict(n=2 ** 15, r=8, p=1, dklen=32)

# OpenSSL caps scrypt at 32 MB unless asked otherwise, and these parameters
# want exactly that much, so it refuses by a single byte.  Ask for headroom.
SCRYPT_MAXMEM = 128 * SCRYPT["n"] * SCRYPT["r"] * 2


def hash_passphrase(passphrase: str, salt: bytes = b"") -> str:
    """scrypt, because a passphrase on the open internet gets guessed at."""
    salt = salt or os.urandom(16)
    digest = hashlib.scrypt(passphrase.encode("utf-8"), salt=salt,
                            maxmem=SCRYPT_MAXMEM, **SCRYPT)
    return "scrypt$%s$%s" % (base64.b64encode(salt).decode(),
                             base64.b64encode(digest).decode())


def check_passphrase(passphrase: str, stored: str) -> bool:
    try:
        kind, salt_b64, want_b64 = stored.split("$")
        if kind != "scrypt":
            return False
        salt = base64.b64decode(salt_b64)
        got = hashlib.scrypt(passphrase.encode("utf-8"), salt=salt,
                             maxmem=SCRYPT_MAXMEM, **SCRYPT)
        return hmac.compare_digest(got, base64.b64decode(want_b64))
    except Exception:
        return False


# Two ways in, and whoever is signing in picks one.
#
#   Gmail   your address and a Google app password, checked against Gmail
#           itself over IMAP.  Nothing is stored: the password is used for a
#           single login and discarded.  Only the address in config.json is
#           accepted, so owning some other Gmail account gets you nowhere.
#   Phrase  a passphrase you chose, kept as an scrypt hash.  Useful where the
#           host blocks outbound IMAP, which several providers do.
#
# Either is enough on its own.  PATCHVANE_REQUIRE_BOTH turns that into an
# and, for anyone who wants the second factor.
PASS_HASH = env("PATCHVANE_PASSPHRASE_HASH")
ALLOW_GMAIL = env_flag("PATCHVANE_ALLOW_GMAIL",
                       env_flag("PATCHVANE_REQUIRE_GMAIL", True))
REQUIRE_BOTH = env_flag("PATCHVANE_REQUIRE_BOTH", False)


def signin_emails() -> list:
    """Which addresses may sign in, or an empty list meaning anyone may.

    Signing in means logging into your own mailbox, so an address nobody
    holds the password to is no use to anybody.  That makes an allow list
    unnecessary for the common case, and this is empty by default: whoever
    proves an address is theirs gets a dashboard of that address's patches
    and nothing else.

    A shared or public deployment can still narrow it, with
    PATCHVANE_ALLOW_EMAILS or signin.emails in config.json."""
    named = env("PATCHVANE_ALLOW_EMAILS") or ""
    if not named:
        named = ",".join((CONFIG.get("signin") or {}).get("emails") or [])
    out = []
    for addr in named.replace(";", ",").split(","):
        addr = addr.strip().lower()
        if addr and addr not in out:
            out.append(addr)
    return out


SIGNIN_EMAILS = signin_emails()


def may_sign_in(email: str) -> bool:
    return not SIGNIN_EMAILS or email.strip().lower() in SIGNIN_EMAILS


def who_may() -> str:
    """For the startup line: who this server will let in."""
    if not SIGNIN_EMAILS:
        return "anyone who can log into their own mailbox"
    return "only %s" % ", ".join(quiet_addr(a) for a in SIGNIN_EMAILS)


# ----------------------------------------------------------------- sessions

# A signed cookie rather than a table in memory: a restart or a second worker
# must not sign everybody out, and there is nothing to leak if the process is
# dumped.  Bumping PATCHVANE_SESSION_EPOCH invalidates every issued session.
SECRET = env("PATCHVANE_SECRET")
EPOCH = env("PATCHVANE_SESSION_EPOCH", "1")


def sign(payload: dict) -> str:
    raw = base64.urlsafe_b64encode(
        json.dumps(payload, separators=(",", ":")).encode()).rstrip(b"=")
    mac = hmac.new(SECRET.encode(), raw, hashlib.sha256).digest()
    return "%s.%s" % (raw.decode(),
                      base64.urlsafe_b64encode(mac).rstrip(b"=").decode())


def unsign(token: str):
    try:
        raw_s, mac_s = token.split(".", 1)
        raw = raw_s.encode()
        want = hmac.new(SECRET.encode(), raw, hashlib.sha256).digest()
        got = base64.urlsafe_b64decode(mac_s + "=" * (-len(mac_s) % 4))
        if not hmac.compare_digest(want, got):
            return None
        payload = json.loads(
            base64.urlsafe_b64decode(raw + b"=" * (-len(raw) % 4)))
    except Exception:
        return None
    if payload.get("e") != EPOCH:
        return None
    if payload.get("exp", 0) < time.time():
        return None
    return payload


def new_session(email: str) -> str:
    return sign({"u": email, "e": EPOCH,
                 "exp": int(time.time() + SESSION_HOURS * 3600)})


def check_gmail(email: str, password: str) -> str:
    """Empty string when the credentials work, otherwise why they did not."""
    if not may_sign_in(email):
        # Only reachable on a deployment that narrowed the list.  Saying
        # which addresses are on it would tell an attacker who to go after,
        # so the reply names none of them.
        return ("This dashboard is limited to particular addresses, and that "
                "is not one of them. The operator can add it to "
                "PATCHVANE_ALLOW_EMAILS, or to signin.emails in config.json.")
    try:
        M = imaplib.IMAP4_SSL(CONFIG.get("imap_host", "imap.gmail.com"),
                              timeout=25)
    except Exception as exc:
        return ("Cannot reach Gmail from this host: %s. Some providers block "
                "outbound IMAP, in which case set a passphrase with "
                "--hash-passphrase and sign in with that instead." % exc)
    try:
        M.login(email, password)
        M.logout()
        return ""
    except imaplib.IMAP4.error as exc:
        detail = str(exc)
        if "Invalid credentials" in detail or "AUTHENTICATIONFAILED" in detail:
            return ("Gmail rejected that. Use a 16 character app password from "
                    "myaccount.google.com/apppasswords, not your account "
                    "password.")
        return "Gmail refused the sign-in."
    except Exception:
        return "Sign-in failed."


# ------------------------------------------------------------ rate limiting


class Limiter:
    def __init__(self, allowance: int, per_seconds: int):
        self.allowance = allowance
        self.per = per_seconds
        self.hits = {}
        self.lock = threading.Lock()

    def allow(self, who: str) -> bool:
        now = time.time()
        with self.lock:
            q = self.hits.setdefault(who, deque())
            while q and now - q[0] > self.per:
                q.popleft()
            if len(self.hits) > 2048:            # a flood must not eat memory
                for k in [k for k, v in self.hits.items() if not v][:1024]:
                    self.hits.pop(k, None)
            if len(q) >= self.allowance:
                return False
            q.append(now)
            return True


# Counted per client address.  Behind a proxy that does not set
# X-Forwarded-For, or a NAT everyone shares, the whole office looks like one
# address and five tries runs out fast, so both are adjustable.
LOGIN_LIMIT = Limiter(int(env("PATCHVANE_LOGIN_TRIES", "5") or 5),
                      int(env("PATCHVANE_LOGIN_WINDOW", "300") or 300))
API_LIMIT = Limiter(int(env("PATCHVANE_API_RATE", "120") or 120), 60)


# ------------------------------------------------------------------- policy


def policy(email: str = "") -> redact.Policy:
    """Local keeps everything on screen.  A deployment masks other people's
    addresses and leaves the private notes at home unless told otherwise.

    "Other people" is relative to whoever is looking, so the address of the
    person signed in is the one left alone."""
    own = (email or OWNER or "").strip().lower()
    if not CLOUD:
        return redact.Policy.wide_open(own_email=own)
    return redact.Policy(
        mask_addresses=not env_flag("PATCHVANE_SHOW_ADDRESSES", False),
        include_notes=env_flag("PATCHVANE_INCLUDE_NOTES", False),
        scrub_excerpts=env_flag("PATCHVANE_HIDE_EXCERPTS", False),
        own_email=own)


def load_data(email: str, public: bool = False):
    """One person's collected patches, and a redacted copy of them.

    Kept per address and rebuilt only when that person's file changes, so
    two people signed in at once do not keep throwing away each other's."""
    path = data_path(email)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {}
    slot = _CACHE.get(email)
    if not slot or slot["mtime"] != mtime:
        try:
            with open(path, encoding="utf-8") as fh:
                raw = json.load(fh)
        except Exception as exc:
            log("collected data for %s is unreadable: %s"
                % (quiet_addr(email), exc))
            return {}
        slot = {"mtime": mtime, "raw": raw,
                "public": policy(email).apply(raw)}
        # A server with many users must not hold every one of their files in
        # memory for ever; the ones in use stay, the rest are re-read.
        if len(_CACHE) > 8:
            oldest = min(_CACHE, key=lambda k: _CACHE[k]["mtime"])
            _CACHE.pop(oldest, None)
        _CACHE[email] = slot
    return (slot["public"] if public else slot["raw"]) or {}


# ------------------------------------------------------------- the collector


def run_collect(email: str, full: bool = False, why: str = "manual") -> tuple:
    """Collect one person's patches.

    One at a time across the whole server: each run is mostly waiting on
    lore and git.kernel.org, and running several at once would only get this
    host rate limited by both."""
    email = (email or "").strip().lower()
    if not email or "@" not in email:
        return False, "There is no address to collect for."
    if not COLLECT_LOCK.acquire(blocking=False):
        return False, "A collection is already running."
    state = state_of(email)
    state["running"] = True
    try:
        log("collecting for %s (%s)%s"
            % (quiet_addr(email), why, ", full rescan" if full else ""))
        home = home_of(email)
        os.makedirs(home, exist_ok=True)
        cmd = [sys.executable, os.path.join(HERE, "collect.py"),
               "--for", email, "--out", home]
        if full:
            cmd += ["--fresh", "--all-trees"]
        p = subprocess.run(cmd, cwd=HERE, capture_output=True, text=True,
                           timeout=3600, env=dict(os.environ))
        lines = [l for l in (p.stderr or "").strip().splitlines() if l.strip()]
        summary = lines[-1].replace("[collect] ", "") if lines else "done"
        state["last_run"] = now_iso()
        state["last_ok"] = p.returncode == 0
        if p.returncode != 0:
            state["last_error"] = summary
            log("collection for %s failed: %s" % (quiet_addr(email), summary))
            return False, summary or "collect.py exited %d" % p.returncode
        state["last_error"] = ""
        state["last_summary"] = summary
        log("collected for %s: %s" % (quiet_addr(email), summary))
        return True, summary
    except subprocess.TimeoutExpired:
        state["last_error"] = "timed out"
        return False, "The collector ran for an hour and was stopped."
    except Exception as exc:
        state["last_error"] = str(exc)
        return False, "The collector could not be started."
    finally:
        state["running"] = False
        COLLECT_LOCK.release()


def start_first_collection(email: str) -> None:
    """Collect for somebody who has just signed in for the first time.

    In the background: a first collection reads a few hundred threads and
    takes minutes, and nobody should watch a blank page for that long."""
    if state_of(email).get("running"):
        return

    def go():
        ok, summary = run_collect(email, why="first sign-in")
        if not ok:
            log("first collection for %s did not finish: %s"
                % (quiet_addr(email), summary))

    threading.Thread(target=go, daemon=True).start()


def due_for_collection() -> list:
    """Who to collect for next, most overdue first.

    Everyone who has signed in, but only while they keep signing in: a
    dashboard nobody has opened in a fortnight is not worth fetching for,
    and the archives being polite about is a shared resource."""
    keep = float(env("PATCHVANE_KEEP_DAYS", "14") or 14)
    cutoff = time.time() - keep * 86400
    out = []
    for card in known_people():
        try:
            seen = datetime.fromisoformat(card["seen"]).timestamp()
        except Exception:
            seen = 0
        if seen < cutoff:
            continue
        run = state_of(card["email"])
        last = run.get("last_run") or ""
        try:
            when = datetime.fromisoformat(last).timestamp() if last else 0
        except Exception:
            when = 0
        out.append((when, card["email"]))
    out.sort()
    return [addr for _, addr in out]


def migrate_single_user() -> None:
    """Move an old single-address data.json into that address's directory.

    Before this server collected for whoever signed in, there was one
    data.json beside it, for the address in config.json.  Rather than throw
    away a collection that took minutes, put it where its owner will find
    it."""
    old = os.path.join(DATA_DIR, "data.json")
    if not OWNER or not os.path.exists(old):
        return
    home = home_of(OWNER)
    if os.path.exists(os.path.join(home, "data.json")):
        return
    try:
        os.makedirs(home, exist_ok=True)
        os.replace(old, os.path.join(home, "data.json"))
        old_notes = os.path.join(DATA_DIR, "notes.json")
        if os.path.exists(old_notes):
            shutil.copy(old_notes, os.path.join(home, "notes.json"))
        remember_person(OWNER)
        log("moved the existing collection into %s's own directory"
            % quiet_addr(OWNER))
    except OSError as exc:
        log("could not move the existing collection: %s" % exc)


def migrate_secrets() -> None:
    """Move a server-wide secrets.json into the owner's own vault.

    Keys used to belong to the deployment, because there was only ever one
    person using it.  Now they belong to people, and leaving the old file in
    place would quietly hand one person's key to everybody who signs in."""
    if not OWNER or not os.path.exists(SECRETS):
        return
    try:
        with open(SECRETS, encoding="utf-8") as fh:
            blob = json.load(fh)
    except Exception:
        return
    keys = dict(blob.get("keys") or {})
    if blob.get("gemini_api_key"):
        keys.setdefault("gemini", blob["gemini_api_key"])
    keys = {k: v for k, v in keys.items()
            if v and k in providers.PROVIDERS}
    if not keys:
        return
    mine = vault_of(OWNER)
    have = dict(mine.get("keys") or {})
    for pid, key in keys.items():
        have.setdefault(pid, key)
    mine["keys"] = have
    # Carry the model choices from config.json across with them.
    picked = dict((CONFIG.get("ai") or {}).get("models") or {})
    if picked:
        mine.setdefault("models", {})
        for pid, model in picked.items():
            mine["models"].setdefault(pid, model)
    if not vault_save(OWNER, mine):
        log("could not move the old keys into a vault; leaving them alone")
        return
    os.replace(SECRETS, SECRETS + ".migrated")
    log("moved %d assistant key(s) from secrets.json into %s's own vault"
        % (len(keys), quiet_addr(OWNER)))


def scheduler() -> None:
    """Collect on a timer so the page stays current without anyone clicking.

    One person per tick, longest since their last run first.  Collecting for
    everybody at once would hammer lore and git.kernel.org from one host;
    round robin keeps every dashboard current without doing that.

    WAKE cuts the wait short when the interval changes."""
    while not STOP.is_set():
        if not STATE["auto"]:
            STATE["next_run"] = None
            WAKE.wait(30)
            WAKE.clear()
            continue
        waiting = due_for_collection()
        # With several people the round has to come round often enough that
        # each of them is still refreshed about every interval.
        wait = max(30.0, STATE["interval"] * 60.0 / max(1, len(waiting)))
        STATE["next_run"] = datetime.fromtimestamp(
            time.time() + wait, timezone.utc).astimezone().isoformat()
        if WAKE.wait(wait):
            WAKE.clear()
            continue
        if STATE["auto"] and not STOP.is_set() and waiting:
            run_collect(waiting[0], why="scheduled")


# ------------------------------------------------------------------- the AI


# An operator can hand the whole deployment one set of keys, but that is a
# deliberate choice and not the default: normally your keys are yours, and
# somebody else signing in gets asked for their own.
SHARED_KEYS = env_flag("PATCHVANE_SHARED_KEYS", False)


def vault_path(email: str) -> str:
    return os.path.join(home_of(email), "vault.json")


def vault_of(email: str) -> dict:
    """One person's own settings: their API keys and their model choices,
    decrypted with the server secret."""
    if not email:
        return {}
    return vault.read(vault_path(email), SECRET)


def vault_save(email: str, blob: dict) -> bool:
    home = home_of(email)
    try:
        os.makedirs(home, exist_ok=True)
    except OSError:
        return False
    return vault.write(vault_path(email), SECRET, blob)


def ai_keys(email: str = "") -> dict:
    """Every provider this person has a key for, and the key.

    Theirs, out of their own encrypted vault, plus whatever they typed into
    the page this session.  Another account's keys are never consulted: one
    person paying for a model does not mean everybody gets to spend it.

    An operator who does want to supply keys for everyone sets
    PATCHVANE_SHARED_KEYS, and then the environment fills in what a person
    has not set for themselves."""
    found = {}
    if SHARED_KEYS:
        found.update(providers.load_keys(None))
    for pid, key in (vault_of(email).get("keys") or {}).items():
        if key and pid in providers.PROVIDERS:
            found[pid] = key
    # A key typed into the page this session beats what is written down.
    for pid, key in (RUNTIME_KEY.get(email) or {}).items():
        if key and pid in providers.PROVIDERS:
            found[pid] = key
        elif not key:
            found.pop(pid, None)
    return found


def ai_models(email: str = "") -> dict:
    """Which model to use per provider, when it is not the provider's own
    default.  Each person picks their own."""
    picked = dict((CONFIG.get("ai") or {}).get("models") or {})
    picked.update(vault_of(email).get("models") or {})
    return {k: v for k, v in picked.items() if v}


def save_ai_key(email: str, pid: str, key: str) -> bool:
    """Write a key into that person's vault, and nobody else's."""
    if not ALLOW_SECRET_FILE or not email:
        return False
    blob = vault_of(email)
    keys = dict(blob.get("keys") or {})
    if key:
        keys[pid] = key
    else:
        keys.pop(pid, None)
    blob["keys"] = {k: v for k, v in keys.items() if v}
    return vault_save(email, blob)


def ai_ready(email: str = "") -> list:
    """Provider ids that could answer a question for this person right now."""
    keys = ai_keys(email)
    return [pid for pid in providers.ORDER if keys.get(pid)]


def ai_catalogue(email: str = "", keys=None) -> list:
    """What to show one person on the settings page: every provider, and
    whether they have set it up.  Never includes a key, only whether there
    is one and where it came from."""
    keys = ai_keys(email) if keys is None else keys
    mine = vault_of(email)
    stored = set((mine.get("keys") or {}).keys())
    session = RUNTIME_KEY.get(email) or {}
    picked = ai_models(email)
    out = []
    for pid in providers.ORDER:
        p = providers.PROVIDERS[pid]
        out.append({
            "id": pid, "label": p.label, "where": p.where,
            "env": p.key_env, "endpoint": p.base,
            "model": picked.get(pid) or p.default,
            "default": p.default,
            "good_at": sorted(p.good_at),
            "ready": bool(keys.get(pid)),
            "source": ("this session" if session.get(pid)
                       else "saved for you" if pid in stored
                       else "this deployment" if SHARED_KEYS and env(p.key_env)
                       else ""),
        })
    return out


def build_digest(d: dict) -> str:
    """A compact picture of the whole contribution, small enough to send with
    every question.  Built from the redacted copy, so a model provider never
    receives a reviewer's address."""
    if not d:
        return "No data has been collected yet."
    k = d.get("kpis", {})
    out = ["# Upstream contribution status for %s" % d["profile"]["name"],
           "Collected %s." % d.get("generated", "")[:19], "", "## Totals"]
    for label, key in [
            ("patches posted", "patches"), ("series", "series"),
            ("merged in mainline", "merged"), ("in linux-next", "in_next"),
            ("in a maintainer tree", "in_tree"), ("accepted", "accepted"),
            ("carrying a review tag", "reviewed"),
            ("under discussion", "under_review"),
            ("no reply yet", "awaiting"),
            ("changes requested", "changes_requested"),
            ("superseded", "superseded"), ("rejected", "rejected"),
            ("not applicable", "not_applicable"),
            ("review tags received", "review_tags"),
            ("people who replied", "reviewers"),
            ("threads needing a reply from me", "waiting_on_us"),
            ("net-next patches outstanding", "netdev_open"),
            ("net-next cap", "netdev_cap")]:
        out.append("- %s: %s" % (label, k.get(key, 0)))

    out += ["", "## By tree"]
    for t in d.get("trees", [])[:22]:
        out.append("- %s: %d patches, %d merged, %d in linux-next, %d open, "
                   "%d with problems, %d tags"
                   % (t["tree"], t["patches"], t["merged"], t["in_next"],
                      t["open"], t["problems"], t["tags"]))

    out += ["", "## Commits that landed"]
    for c in d.get("merged", [])[:40]:
        out.append("- %s %s [%s] %s" % (
            c["short"], "MAINLINE" if c["mainline"] else "queued",
            ", ".join(c["trees"]), c["subject"]))

    out += ["", "## Threads waiting on a reply from me"]
    for t in [t for t in d.get("threads", []) if t.get("waiting_on_us")][:30]:
        out.append("- [%s] %s -- %s wrote on %s: %s"
                   % (t.get("tree") or "?", t["series"], t["last_from"],
                      t["last_date"][:10], (t.get("excerpt") or "")[:220]))

    out += ["", "## Recent discussion"]
    for t in d.get("threads", [])[:30]:
        if t.get("waiting_on_us"):
            continue
        out.append("- [%s] %s -- last from %s on %s: %s"
                   % (t.get("state"), t["series"], t["last_from"],
                      t["last_date"][:10], (t.get("excerpt") or "")[:160]))

    out += ["", "## Review tags received"]
    for r in d.get("tagrows", [])[:50]:
        out.append("- %s from %s on: %s" % (r["tag"], r["who"], r["subject"]))

    if d.get("notes"):
        out += ["", "## Open items I wrote down"]
        for n in d["notes"]:
            out.append("- [%s] %s: %s Next: %s"
                       % (n.get("state"), n.get("title"), n.get("detail"),
                          n.get("next", "")))

    out += ["", "## Every patch (subject | tree | status | version | posted "
            "| replies)"]
    for p in d.get("patches", []):
        # The version matters for the commonest question there is: someone
        # asks what to change in the next spin, and the answer depends on
        # which spin they are on.
        v = p.get("version") or 1
        top = p.get("latest_version") or v
        ver = "v%s%s" % (v, " (latest is v%s)" % top if top != v else "")
        out.append("- %s | %s | %s | %s | %s | %d"
                   % (p["subject"], p.get("tree_hint") or p.get("list") or "?",
                      p["state"], ver, (p.get("date") or "")[:10],
                      p.get("reply_count", 0)))
    return "\n".join(out)


STOPWORDS = set("""a an and are as at be but by can could did do does for from
had has have how i if in into is it its me my of on or should so than that the
their them then there these they this to was were what when where which who
why will with would you your about give tell say said need want next reply
patch patches series thread threads version fix""".split())


def keywords(text: str) -> set:
    return {w for w in re.findall(r"[a-z0-9_]{3,}", (text or "").lower())
            if w not in STOPWORDS}


def focus(d: dict, query: str, limit: int = 3) -> str:
    """The full thread for whatever the question is about.

    The digest is a summary: one line per patch and one excerpt per thread.
    That is enough to answer "how many" and "what state", and never enough to
    answer "what did the reviewer ask me to change", because the asking
    happened in a message the digest only had room to mention.  So find the
    threads the question is about and quote them properly."""
    want = keywords(query)
    if not want or not d:
        return ""

    scored = []
    for t in d.get("threads", []):
        hay = keywords(t.get("series", "")) | keywords(t.get("tree") or "")
        hits = len(want & hay)
        if not hits:
            continue
        # A question naming most of a subject line is about that thread, not
        # about every thread sharing the word "typo".
        scored.append((hits / max(1, len(hay)), hits, t))
    if not scored:
        return ""
    scored.sort(key=lambda r: (r[1], r[0]), reverse=True)

    by_series = {}
    for p in d.get("patches", []):
        by_series.setdefault(p.get("series_name") or p.get("series"),
                             []).append(p)

    out = ["", "## In full: the threads this question is about"]
    for _, _, t in scored[:limit]:
        out.append("")
        out.append("### %s" % t.get("series"))
        out.append("- list or tree: %s, state: %s, replies: %d, review tags: %d"
                   % (t.get("tree") or "?", t.get("state"),
                      t.get("count", 0), t.get("tags", 0)))
        if t.get("waiting_on_us"):
            out.append("- this one is waiting on a reply from me")
        if t.get("lore"):
            out.append("- %s" % t["lore"])

        for p in sorted(by_series.get(t.get("series")) or [],
                        key=lambda p: (p.get("version") or 1,
                                       p.get("seq") or 0))[:30]:
            out.append("  - v%s patch %s: %s -- %s%s"
                       % (p.get("version") or 1, p.get("seq") or "?",
                          p["subject"], p["state"],
                          ", %s" % p["state_detail"] if p.get("state_detail")
                          else ""))

        said = t.get("replies") or []
        if said:
            out.append("- what people said, oldest first:")
            for r in said:
                out.append("  - %s on %s: %s"
                           % (r.get("who"), (r.get("date") or "")[:10],
                              " ".join((r.get("text") or "").split())))
        elif t.get("excerpt"):
            out.append("- %s wrote on %s: %s"
                       % (t.get("last_from"), (t.get("last_date") or "")[:10],
                          " ".join(t["excerpt"].split())))
    return "\n".join(out)


SYSTEM_PROMPT = """You are the assistant inside Patchvane, a dashboard that
tracks the Linux kernel upstream contributions of whoever is signed in.

You are given a status digest gathered from lore.kernel.org, patchwork and
git.kernel.org. Answer from that digest and from what the person has told you
earlier in this conversation. If neither contains the answer, say so plainly
rather than guessing.

This is a conversation, not a series of unrelated questions. Earlier turns are
above; use them.
- A follow-up usually leaves its subject out ("what should the reply say",
  "give me the fix", "regarding the previous question"). Carry the subject
  over from the turn before rather than asking which patch is meant.
- When the person has told you something the digest does not have, such as a
  reviewer's request or a version they have already sent, take their word for
  it and answer. Do not tell them the digest lacks what they just said.
- If a question really is ambiguous, make your best reading of it, answer
  that, and say which one you took it to mean.

The digest ends with the threads your question is about, quoted in full: every
version, and every reply with who wrote it. Look there before saying you do
not know.

How to answer:
- Lead with the direct answer in one or two sentences, then the supporting
  detail.
- When asked what to write, write it, as text ready to send rather than a
  description of what to write.
- Be specific: name the series, the tree, the maintainer, the commit.
- Prose and short lists. No headers unless the answer really has sections.
- You know kernel workflow: a patch goes posted -> reviewed -> applied to a
  maintainer tree -> linux-next -> mainline. maintainer-netdev.rst caps
  outstanding patches per tree. Superseded means a later version replaced it.
- Reviewer addresses reach you masked, as a***@domain. Never try to
  reconstruct one, and never print one.
- Never invent a commit hash, a maintainer name or a review tag.
"""


# A conversation is kept short on purpose: every turn is sent again with the
# next question, and the digest is large enough already.
CHAT_TURNS = 12
CHAT_CHARS = 6000


def clean_history(raw) -> list:
    """The conversation so far, as the model should see it.

    Comes from the browser, so none of it is trusted: roles are forced to the
    two the wire formats accept, turns must alternate, and the whole thing is
    trimmed to the most recent few."""
    if not isinstance(raw, list):
        return []
    turns = []
    for item in raw[-CHAT_TURNS * 2:]:
        if not isinstance(item, dict):
            continue
        role = "assistant" if item.get("role") in ("assistant", "bot") \
            else "user"
        text = str(item.get("text") or "").strip()[:CHAT_CHARS]
        if not text:
            continue
        # Two turns from the same side running together confuses Anthropic
        # and Gemini both; keep the later one.
        if turns and turns[-1]["role"] == role:
            turns[-1] = {"role": role, "text": text}
        else:
            turns.append({"role": role, "text": text})
    # Every format wants the conversation to start from the person asking.
    while turns and turns[0]["role"] != "user":
        turns.pop(0)
    return turns[-CHAT_TURNS:]


def ai_ask(question: str, digest: str, pinned: str = "",
           history=(), email: str = "") -> dict:
    """Put the question to whichever model is best placed to take it, and
    keep going down the list when one falls over.

    The reply says which model actually answered and what happened to the
    ones before it, because an answer in a different voice with no
    explanation is unsettling."""
    keys = ai_keys(email)
    if not any(keys.values()):
        return {"ok": False, "needs_key": True,
                "error": "You have not added an API key for any model yet."}

    # The digest rides with the current question rather than with the older
    # turns, so the model always reasons over today's numbers even when the
    # conversation started before the last collection.
    prompt = ("Here is the current status digest.\n\n<digest>\n%s\n</digest>"
              "\n\nQuestion: %s" % (digest, question))
    answer, trail = providers.ask(
        SYSTEM_PROMPT, prompt, keys, models=ai_models(email),
        pinned=pinned or None, topic=question, history=history,
        timeout=int(env("PATCHVANE_AI_TIMEOUT", "180") or 180), log=log)

    out = {"ok": answer.ok, "trail": trail,
           "zone": getattr(answer, "zone", "")}
    if answer.ok:
        out["text"] = answer.text
        out["provider"] = answer.provider
        out["model"] = answer.model
        out["label"] = providers.PROVIDERS[answer.provider].label
        # Who got asked and could not answer, one line each.  A provider that
        # was retried appears once, and the one that eventually answered does
        # not appear at all.
        seen, fell = set(), []
        for t in trail:
            if t["ok"] or t["provider"] == answer.provider:
                continue
            if t["provider"] in seen:
                continue
            seen.add(t["provider"])
            fell.append(t)
        out["fellback"] = fell
    else:
        out["error"] = answer.detail
    return out


def ai_model_list(pid: str, email: str = "") -> tuple:
    """Every model this person's key can reach, and why it might not."""
    p = providers.PROVIDERS.get(pid)
    if not p:
        return False, [], "No such model service."
    keys = ai_keys(email)
    if pid not in keys:
        return False, [], "Add your own key for %s first." % p.label
    try:
        names = p.models(keys.get(pid, ""))
    except Exception as exc:                # a bad key, or the service down
        return False, [], "%s would not list its models (%s)." % (
            p.label, str(exc)[:90])
    if not names:
        return False, [], "%s returned no models for this key." % p.label
    return True, names, ""


def save_ai_model(email: str, pid: str, model: str) -> bool:
    """Remember which model this person wants from a provider.

    Into their own vault, next to their key: the choice only makes sense
    against the key that reaches it, and one person preferring a big model
    should not spend somebody else's allowance on it."""
    p = providers.PROVIDERS.get(pid)
    if not p or not model or len(model) > 120 or not email:
        return False
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:@-]*(?:/[A-Za-z0-9][A-Za-z0-9._:@-]*)*",
                        model) or ".." in model:
        return False
    blob = vault_of(email)
    picked = dict(blob.get("models") or {})
    if model == p.default:
        picked.pop(pid, None)       # back to the default, so stop overriding
    else:
        picked[pid] = model
    blob["models"] = picked
    return vault_save(email, blob)


def ai_test(pid: str, key: str = "", email: str = "") -> dict:
    """One cheap round trip, to say whether a key works before it matters."""
    p = providers.PROVIDERS.get(pid)
    if not p:
        return {"ok": False, "error": "No such provider."}
    key = key or ai_keys(email).get(pid, "")
    if not key:
        return {"ok": False, "error": "No key for %s yet." % p.label}
    model = ai_models(email).get(pid) or p.default
    answer = p.ask(key, model,
                   "Reply with the single word: ready.",
                   "Are you there?", timeout=45)
    if answer.ok:
        return {"ok": True, "model": model,
                "reply": answer.text[:80], "label": p.label}

    # The named model is gone or was never on this key: providers retire a
    # model the moment the next one ships, and the name in a settings page
    # outlives it.  Rather than leaving somebody with a dead setting and an
    # error, find one on their key that does answer and move them onto it.
    if gone(answer):
        working, tried = find_working(p, key, model)
        if working:
            save_ai_model(email, pid, working)
            return {"ok": True, "model": working, "label": p.label,
                    "switched_from": model, "tried": tried,
                    "reply": "%s is not there any more, so this is set to %s, "
                             "which answered." % (model, working)}
    return {"ok": False, "error": answer.detail, "model": model,
            "status": answer.status}


def gone(answer) -> bool:
    """Whether a failure means "no such model" rather than "busy just now".

    Only the first is worth switching over: a model that is merely
    overloaded will be back, and quietly moving somebody off it would lose
    them the model they chose."""
    if answer.status in (404, 400):
        return True
    detail = (answer.detail or "").lower()
    return any(x in detail for x in (
        "not found", "does not exist", "no such model", "unknown model",
        "deprecated", "decommissioned", "unsupported model",
        "invalid model", "model_not_found", "has been retired"))


def find_working(p, key: str, avoid: str = "") -> tuple:
    """The best model on this key that actually answers.

    The provider's own default first, then the spares it ships with: those
    are curated and current, which a name sorted out of a catalogue is not.
    After that, models from the same family as the one that died, so a key
    pinned to gpt-5.1 lands on another gpt-5 rather than something unrelated.

    A model that is merely busy is skipped rather than settled on, and the
    search does not stop for it: being rate limited says nothing about
    whether the next model works.  Capped, because each attempt is a real
    request against somebody's key."""
    family = re.split(r"[-.]", avoid)[0].lower() if avoid else ""
    try:
        catalogue = [m for m in p.models(key) if m != avoid]
    except Exception:
        catalogue = []

    order = []
    for m in [p.default] + list(getattr(p, "spares", ())):
        if m and m != avoid and m not in order:
            order.append(m)
    for m in sorted(catalogue, reverse=True):
        if family and m.lower().startswith(family) and m not in order:
            order.append(m)

    tried = []
    for model in order[:6]:
        tried.append(model)
        answer = p.ask(key, model, "Reply with the single word: ready.",
                       "Are you there?", timeout=30)
        if answer.ok:
            return model, tried
    return "", tried


# ------------------------------------------------------------------ handler


class Handler(BaseHTTPRequestHandler):
    server_version = "mainline"
    sys_version = ""
    protocol_version = "HTTP/1.1"
    timeout = 30

    def log_message(self, fmt, *args):
        if VERBOSE:
            log("%s %s" % (self.client_ip(), fmt % args))

    def log_error(self, fmt, *args):
        pass

    # ---------------------------------------------------------- utilities

    def client_ip(self) -> str:
        if TRUST_PROXY:
            fwd = self.headers.get("X-Forwarded-For", "")
            if fwd:
                return fwd.split(",")[0].strip()
        return self.client_address[0]

    def scheme(self) -> str:
        if TRUST_PROXY:
            return (self.headers.get("X-Forwarded-Proto", "http")
                    .split(",")[0].strip().lower())
        return "http"

    def secure(self) -> bool:
        return self.scheme() == "https"

    def cookie(self) -> str:
        raw = self.headers.get("Cookie")
        if not raw:
            return ""
        try:
            jar = http.cookies.SimpleCookie(raw)
            return jar[COOKIE].value if COOKIE in jar else ""
        except Exception:
            return ""

    def session(self):
        return unsign(self.cookie())

    def set_cookie(self, token: str, clear: bool = False) -> tuple:
        bits = ["%s=%s" % (COOKIE, "" if clear else token), "Path=/", "HttpOnly",
                "SameSite=Lax"]
        if clear:
            bits.append("Max-Age=0")
        else:
            bits.append("Max-Age=%d" % (SESSION_HOURS * 3600))
        if self.secure() or REQUIRE_HTTPS:
            bits.append("Secure")
        return ("Set-Cookie", "; ".join(bits))

    def send(self, code: int, body: bytes, ctype: str, headers=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Permissions-Policy",
                         "geolocation=(), microphone=(), camera=(), "
                         "interest-cohort=()")
        self.send_header("Content-Security-Policy", CSP)
        if REQUIRE_HTTPS:
            self.send_header("Strict-Transport-Security",
                             "max-age=31536000; includeSubDomains")
        for k, v in (headers or []):
            self.send_header(k, v)
        self.end_headers()
        if self.command != "HEAD":
            try:
                self.wfile.write(body)
            except (BrokenPipeError, ConnectionResetError):
                pass

    def redirect(self, where: str, headers=None):
        self.send(303, b"", "text/plain", [("Location", where)] + (headers or []))

    def json_out(self, code: int, obj):
        self.send(code, json.dumps(obj).encode(), "application/json")

    def file_out(self, name: str):
        path = os.path.join(HERE, os.path.basename(name))
        if not os.path.isfile(path):
            self.send(404, b"not found", "text/plain; charset=utf-8")
            return
        ctype = mimetypes.guess_type(path)[0] or "application/octet-stream"
        if ctype.startswith("text/") or ctype.endswith("javascript"):
            ctype += "; charset=utf-8"
        with open(path, "rb") as fh:
            self.send(200, fh.read(), ctype)

    def body(self) -> dict:
        raw = getattr(self, "raw_body", b"")
        if self.headers.get("Content-Type", "").startswith("application/json"):
            try:
                return json.loads(raw.decode("utf-8"))
            except Exception:
                return {}
        return {k: v[0] for k, v in
                urllib.parse.parse_qs(raw.decode("utf-8", "replace")).items()}

    def force_https(self) -> bool:
        """True when the request was answered with a redirect to https."""
        if not REQUIRE_HTTPS or self.secure():
            return False
        host = self.headers.get("Host", "")
        if not host:
            self.send(400, b"https required", "text/plain; charset=utf-8")
            return True
        self.send(308, b"", "text/plain; charset=utf-8",
                  [("Location", "https://%s%s" % (host, self.path))])
        return True

    # -------------------------------------------------------------- routes

    def do_GET(self):
        if self.force_https():
            return
        path = urllib.parse.urlparse(self.path).path
        sess = self.session()
        authed = sess is not None
        # Whose dashboard this is.  Everything below serves the person
        # holding the cookie, not a name in a config file.
        me = (sess or {}).get("u", "") if authed else ""
        run = state_of(me) if authed else {}

        if path == "/healthz":
            self.json_out(200, {"ok": True, "app": APP, "mode": MODE,
                                "people": len(known_people())})
            return

        if path == "/logout":
            self.redirect("/login", [self.set_cookie("", clear=True)])
            return

        if path == "/login":
            if authed:
                self.redirect("/")
            else:
                self.file_out("login.html")
            return

        if path == "/api/signin":
            # What the sign-in form should ask for.  Says nothing a stranger
            # could not learn by trying.
            self.json_out(200, {"passphrase": bool(PASS_HASH),
                                "gmail": ALLOW_GMAIL, "both": REQUIRE_BOTH,
                                "app": APP})
            return

        if path in ("/style.css", "/login.js"):
            self.file_out(path.lstrip("/"))
            return

        if not authed:
            if path == "/data.json" or path.startswith("/api/"):
                self.json_out(401, {"ok": False, "error": "not signed in"})
            else:
                self.redirect("/login")
            return

        if not API_LIMIT.allow(self.client_ip()):
            self.json_out(429, {"ok": False, "error": "slow down"})
            return

        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

        if path in ("/", "/index.html"):
            self.file_out("index.html")
        elif path == "/data.json":
            d = load_data(me, public=True)
            if not d:
                # Nothing collected for this person yet: say so plainly, and
                # say whether it is being worked on, so the page can wait
                # rather than showing an error.
                self.json_out(404, {"ok": False, "error": "no data yet",
                                    "collecting": run.get("running", False),
                                    "who": me})
            else:
                self.send(200, json.dumps(d).encode(), "application/json")
        elif path == "/api/status":
            d = load_data(me, public=True)
            ready = ai_ready(me)
            self.json_out(200, {
                "ok": True,
                "mode": MODE,
                "running": run["running"],
                "auto": STATE["auto"],
                "interval": STATE["interval"],
                "next_run": STATE["next_run"],
                "last_run": run["last_run"],
                "last_error": run["last_error"],
                "generated": d.get("generated"),
                "privacy": policy(me).describe(),
                "who": me,
                "has_data": os.path.exists(data_path(me)),
                "notes_withheld": d.get("notes_withheld", 0),
                "can_store_key": ALLOW_SECRET_FILE,
                "ai": bool(ready),
                "ai_ready": ready,
                "ai_count": len(ready),
            })
        elif path == "/api/ai/providers":
            self.json_out(200, {"ok": True, "providers": ai_catalogue(me),
                                "ready": ai_ready(me),
                                "zones": providers.ZONES,
                                "can_store_key": ALLOW_SECRET_FILE})
        elif path == "/api/ai/models":
            pid = (q.get("provider") or [""])[0]
            ok, names, why = ai_model_list(pid, me)
            p = providers.PROVIDERS.get(pid)
            self.json_out(200, {"ok": ok, "models": names, "provider": pid,
                                "error": why,
                                "spares": list(p.spares) if p else [],
                                "current": (ai_models(me).get(pid) or
                                            (p.default if p else ""))})
        elif path.lstrip("/") in STATIC:
            self.file_out(path.lstrip("/"))
        else:
            self.send(404, b"not found", "text/plain; charset=utf-8")

    do_HEAD = do_GET

    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            # Refusing to read it is the whole point of the cap, so the
            # connection has to end here: whatever is still in the socket
            # would otherwise be read as the start of the next request.
            self.close_connection = True
            self.json_out(413, {"ok": False, "error": "too large"})
            return

        # Read the body once, up front, before any branch below can return
        # early.  On a keep-alive connection an unread body becomes the first
        # bytes of the next request line, which the client then sees as a
        # nonsense 501 for a request it never made.
        try:
            self.raw_body = self.rfile.read(length) if length else b""
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
            return

        if self.force_https():
            return
        path = urllib.parse.urlparse(self.path).path

        if path == "/login":
            if not LOGIN_LIMIT.allow(self.client_ip()):
                self.redirect("/login?error=" + urllib.parse.quote(
                    "Too many attempts. Wait five minutes."))
                return
            form = self.body()
            problem = self.check_login(form)
            if problem:
                log("failed sign-in from %s" % self.client_ip())
                self.redirect("/login?error=" + urllib.parse.quote(problem))
                return
            # Whoever signed in.  This is their dashboard from here on:
            # their patches get collected, and their patches are what they
            # see.
            # Gmail says who you are; a passphrase does not, so that route
            # asks which address to track.
            who = ((form.get("email") or "").strip().lower()
                   or (form.get("track") or "").strip().lower()
                   or OWNER)
            if not who or "@" not in who:
                self.redirect("/login?error=" + urllib.parse.quote(
                    "Say which address to track, so the dashboard knows "
                    "whose patches to collect."))
                return
            log("signed in from %s as %s" % (self.client_ip(), quiet_addr(who)))
            remember_person(who)
            if not os.path.exists(data_path(who)):
                # Nothing collected for them yet.  Start now, in the
                # background, so the page can open and say what is happening
                # instead of hanging on a first collection.
                start_first_collection(who)
            self.redirect("/", [self.set_cookie(new_session(who))])
            return

        sess = self.session()
        if not sess:
            self.json_out(401, {"ok": False, "error": "not signed in"})
            return
        me = sess.get("u", "")

        # A cross-site form post cannot set a custom header, so requiring one
        # is enough to stop another page driving this one.
        if self.headers.get("X-Requested-With") != COOKIE:
            self.json_out(403, {"ok": False, "error": "bad request origin"})
            return

        if not API_LIMIT.allow(self.client_ip()):
            self.json_out(429, {"ok": False, "error": "slow down"})
            return

        q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)

        if path == "/api/refresh":
            ok, summary = run_collect(me, full=bool(q.get("full")),
                                      why="manual")
            self.json_out(200 if ok else 500,
                          {"ok": ok, "summary": summary,
                           "error": None if ok else summary})
        elif path == "/api/auto":
            form = self.body()
            STATE["auto"] = bool(form.get("on"))
            if form.get("interval") is not None:
                try:
                    STATE["interval"] = clamp_interval(float(form["interval"]))
                except (TypeError, ValueError):
                    pass
            WAKE.set()
            log("auto refresh %s, every %s min"
                % ("on" if STATE["auto"] else "off", STATE["interval"]))
            self.json_out(200, {"ok": True, "auto": STATE["auto"],
                                "interval": STATE["interval"]})
        elif path == "/api/ai":
            form = self.body()
            question = (form.get("prompt") or "").strip()[:4000]
            if not question:
                self.json_out(400, {"ok": False, "error": "empty question"})
                return
            pinned = (form.get("provider") or "").strip()
            if pinned and pinned not in providers.PROVIDERS:
                pinned = ""
            past = clean_history(form.get("history"))
            d = load_data(me, public=True)
            # A follow-up names its subject in the turn before it ("that
            # series", "the second one"), so the search for what to quote in
            # full reads the recent conversation too, not just this question.
            recent = " ".join([t["text"] for t in past[-3:]] + [question])
            out = ai_ask(question,
                         build_digest(d) + focus(d, recent),
                         pinned, history=past, email=me)
            # Always 200: "every model was busy" is an answer about the
            # models, not a failure of this server, and the page shows it in
            # the conversation where the question was asked.
            self.json_out(200, out)
        elif path == "/api/ai/key":
            form = self.body()
            pid = (form.get("provider") or "").strip()
            if pid not in providers.PROVIDERS:
                self.json_out(400, {"ok": False, "error": "no such provider"})
                return
            key = (form.get("key") or "").strip()
            RUNTIME_KEY.setdefault(me, {})[pid] = key
            stored = False
            if form.get("remember"):
                stored = save_ai_key(me, pid, key)
            if not key and not stored:
                RUNTIME_KEY.get(me, {}).pop(pid, None)
            log("assistant key for %s %s, for %s"
                % (pid, "set" if key else "removed", quiet_addr(me)))
            self.json_out(200, {"ok": True, "provider": pid,
                                "ready": ai_ready(me),
                                "providers": ai_catalogue(me),
                                "stored": stored,
                                "can_store_key": ALLOW_SECRET_FILE})
        elif path == "/api/ai/model":
            form = self.body()
            pid = (form.get("provider") or "").strip()
            model = (form.get("model") or "").strip()
            if pid not in providers.PROVIDERS:
                self.json_out(400, {"ok": False, "error": "no such provider"})
                return
            if not save_ai_model(me, pid, model):
                self.json_out(400, {"ok": False,
                                    "error": "that is not a usable model name"})
                return
            log("assistant model for %s set to %s, for %s"
                % (pid, model, quiet_addr(me)))
            self.json_out(200, {"ok": True, "provider": pid, "model": model,
                                "providers": ai_catalogue(me)})
        elif path == "/api/ai/test":
            form = self.body()
            pid = (form.get("provider") or "").strip()
            if pid not in providers.PROVIDERS:
                self.json_out(400, {"ok": False, "error": "no such provider"})
                return
            self.json_out(200, ai_test(pid, (form.get("key") or "").strip(),
                                       me))
        else:
            self.send(404, b"not found", "text/plain; charset=utf-8")

    def check_login(self, form: dict) -> str:
        """Empty string when the sign-in is good, otherwise why it is not.

        The form says which way it is signing in.  That choice only ever
        narrows what is checked; it can never reach a method this deployment
        did not enable."""
        phrase = lambda: (
            "" if PASS_HASH and check_passphrase(form.get("passphrase", ""),
                                                 PASS_HASH)
            else "That passphrase is not right.")
        gmail = lambda: check_gmail(form.get("email", ""),
                                    form.get("password", ""))

        if REQUIRE_BOTH:
            if not (PASS_HASH and ALLOW_GMAIL):
                return "This server is misconfigured and cannot sign anyone in."
            return phrase() or gmail()

        method = (form.get("method") or "").strip().lower()
        if method == "passphrase":
            if not PASS_HASH:
                return "This server does not take a passphrase."
            return phrase()
        if method == "gmail":
            if not ALLOW_GMAIL:
                return "This server does not take an app password."
            return gmail()
        return "Choose how you want to sign in."


def clamp_interval(minutes: float) -> float:
    """Any interval the user likes, within reason.  Below a minute we would be
    hammering lore for nothing; above a week the timer is pointless."""
    return round(max(1.0, min(10080.0, minutes)), 2)


class Server(socketserver.ThreadingTCPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 64


VERBOSE = False
TRUST_PROXY = env_flag("PATCHVANE_TRUST_PROXY", CLOUD)
REQUIRE_HTTPS = env_flag("PATCHVANE_REQUIRE_HTTPS", CLOUD)


# -------------------------------------------------------------------- setup


def problems() -> list:
    """Everything that would make this deployment unsafe or unable to start."""
    bad = []
    if not SECRET:
        if CLOUD:
            bad.append("PATCHVANE_SECRET is not set. Sessions cannot be signed. "
                       "Generate one with: python3 -c \"import secrets; "
                       "print(secrets.token_urlsafe(48))\"")
    elif len(SECRET) < 32:
        bad.append("PATCHVANE_SECRET is shorter than 32 characters.")
    if not PASS_HASH and not ALLOW_GMAIL:
        bad.append("Nothing checks who is signing in. Leave "
                   "PATCHVANE_ALLOW_GMAIL on to sign in with your Gmail "
                   "address and an app password, or set a passphrase with: "
                   "python3 serve.py --hash-passphrase")
    if ALLOW_GMAIL and not OWNER:
        bad.append("Sign-in by Gmail address is on, but config.json has no "
                   "profile email to accept, so nobody could ever get in.")
    if REQUIRE_BOTH and not (PASS_HASH and ALLOW_GMAIL):
        bad.append("PATCHVANE_REQUIRE_BOTH is set but only one sign-in method "
                   "is configured, so nobody could ever get in.")
    if CLOUD and not REQUIRE_HTTPS:
        bad.append("PATCHVANE_REQUIRE_HTTPS is off in cloud mode. The session "
                   "cookie would travel in the clear.")
    if PASS_HASH and not PASS_HASH.startswith("scrypt$"):
        bad.append("PATCHVANE_PASSPHRASE_HASH is not a hash made by "
                   "--hash-passphrase.")
    if CLOUD and os.path.exists(os.path.join(DATA_DIR, "dashboard.html")):
        bad.append("dashboard.html is in the data directory. It carries a full "
                   "copy of everything and needs no sign-in. Delete it.")
    return bad


def sign_in_wants() -> str:
    ways = list(filter(None, ["Gmail app password" if ALLOW_GMAIL else "",
                              "passphrase" if PASS_HASH else ""]))
    return (" and ".join(ways) if REQUIRE_BOTH else " or ".join(ways)) or "NOTHING"


def cautions() -> list:
    """Things that will not stop the server but will surprise whoever runs it.

    Reaching Gmail is checked here rather than left for the first sign-in,
    because a host with outbound IMAP blocked locks everybody out and the only
    symptom is a timeout on the login page."""
    warn = []
    if ALLOW_GMAIL:
        host = CONFIG.get("imap_host", "imap.gmail.com")
        try:
            imaplib.IMAP4_SSL(host, timeout=8).logout()
        except Exception as exc:
            trouble = ("cannot reach %s from here (%s), so app passwords "
                       "cannot be checked" % (host, exc))
            warn.append(trouble + (
                ". The passphrase still works, so use that one."
                if PASS_HASH and not REQUIRE_BOTH else
                ". Nobody can sign in until this host is allowed outbound "
                "IMAP, or you set a passphrase with --hash-passphrase."))
    if REQUIRE_BOTH:
        warn.append("PATCHVANE_REQUIRE_BOTH is on, so sign-in needs the app "
                    "password and the passphrase together")
    return warn


def make_passphrase() -> int:
    print("Pick a passphrase for the deployed dashboard. Long beats clever.\n")
    a = getpass.getpass("Passphrase: ")
    if len(a) < 12:
        print("\nToo short. Use at least twelve characters.")
        return 1
    if a != getpass.getpass("Again: "):
        print("\nThose did not match.")
        return 1
    print("\nSet this in the environment where the server runs.")
    print("It is a hash: it cannot be turned back into the passphrase.\n")
    print("PATCHVANE_PASSPHRASE_HASH='%s'" % hash_passphrase(a))
    print("\nWhile you are there, you need a session secret too:\n")
    print("PATCHVANE_SECRET='%s'" % secrets.token_urlsafe(48))
    return 0


def main() -> int:
    global VERBOSE, SECRET
    ap = argparse.ArgumentParser(description="Serve the Patchvane dashboard.")
    ap.add_argument("--host", default=env("HOST") or
                    ("0.0.0.0" if CLOUD else "127.0.0.1"))
    ap.add_argument("--port", type=int,
                    default=int(env("PORT") or env("PATCHVANE_PORT") or 8787))
    ap.add_argument("--no-auto", action="store_true",
                    help="do not collect on a timer")
    ap.add_argument("--interval", type=float,
                    default=float(env("PATCHVANE_AUTO_REFRESH") or
                                  CONFIG.get("auto_refresh_minutes", 15)),
                    help="minutes between automatic collections")
    ap.add_argument("--hash-passphrase", action="store_true",
                    help="make a passphrase hash for a deployment, then exit")
    ap.add_argument("--check", action="store_true",
                    help="validate the configuration and exit")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    VERBOSE = args.verbose

    if args.hash_passphrase:
        return make_passphrase()

    bad = problems()
    if args.check:
        for b in bad:
            print("problem: %s" % b)
        for w in cautions():
            print("caution: %s" % w)
        print("mode: %s" % MODE)
        print("privacy: %s" % ", ".join(policy().describe()))
        print("sign-in: %s, %s" % (sign_in_wants(), who_may()))
        print("result: %s" % ("not deployable" if bad else "ok"))
        return 1 if bad else 0

    if bad:
        for b in bad:
            log("refusing to start: %s" % b)
        return 2

    if not SECRET:
        # Local runs should not need ceremony.  A per process key means a
        # restart signs you out, which is the right trade on a laptop.
        SECRET = secrets.token_urlsafe(48)
        log("no PATCHVANE_SECRET, using a temporary one for this process")

    STATE["auto"] = not args.no_auto
    STATE["interval"] = clamp_interval(args.interval)

    # Collecting happens per person, once they sign in.  The only thing to
    # do at startup is catch up anyone who has one already but is stale,
    # which the scheduler does on its own.
    os.makedirs(PEOPLE, exist_ok=True)
    migrate_single_user()
    migrate_secrets()

    threading.Thread(target=scheduler, daemon=True).start()

    srv = Server((args.host, args.port), Handler)

    def bye(*_):
        log("shutting down")
        STOP.set()
        WAKE.set()
        threading.Thread(target=srv.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, bye)
    signal.signal(signal.SIGINT, bye)

    shown = "127.0.0.1" if args.host in ("0.0.0.0", "") else args.host
    log("%s listening on %s:%d" % (APP, args.host, args.port))
    if not CLOUD:
        log("open http://%s:%d/" % (shown, args.port))
    log("sign-in: %s, %s" % (sign_in_wants(), who_may()))
    people = known_people()
    if people:
        log("collecting for %s" % ", ".join(quiet_addr(p["email"])
                                            for p in people[:6])
            + (" and %d more" % (len(people) - 6) if len(people) > 6 else ""))
    for w in cautions():
        log("caution: %s" % w)
    log("privacy: %s" % ", ".join(policy().describe()))
    log("auto refresh %s" % ("every %g min" % STATE["interval"]
                             if STATE["auto"] else "off"))
    # Keys belong to people now, so there is no server-wide list to print.
    if SHARED_KEYS:
        ready = [p for p in providers.ORDER if providers.load_keys(None).get(p)]
        log("assistant: %s, shared with everyone who signs in"
            % (", ".join(providers.PROVIDERS[p].label for p in ready)
               if ready else "no key in the environment"))
    else:
        with_keys = sum(1 for c in known_people()
                        if (vault_of(c["email"]).get("keys") or {}))
        log("assistant: each person uses their own key (%d of %d set up)"
            % (with_keys, len(known_people())))
    if CLOUD:
        log("expecting TLS to be terminated in front of this process")

    try:
        srv.serve_forever(poll_interval=0.4)
    finally:
        srv.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
