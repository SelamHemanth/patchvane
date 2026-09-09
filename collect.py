#!/usr/bin/env python3
"""Build data.json for the upstream contribution dashboard.

Everything comes off the network.  Nothing is read from a local kernel tree
or a local submission directory, so this runs anywhere with internet access.

  lore.kernel.org       every message posted from the address, and every
                        reply in those threads: who is reviewing, what tags
                        were given, who said "applied"
  patchwork.kernel.org  the review state a maintainer set on each patch
  git.kernel.org        what actually landed, in mainline, in linux-next,
                        and in each maintainer's own tree

Usage:
  ./collect.py                    everything, using the cache where it is warm
  ./collect.py --fresh            ignore the cache
  ./collect.py lore patchwork     only those sources
  ./collect.py --quick            mainline and linux-next only
  ./collect.py --all-trees        search every maintainer tree, slow
  ./collect.py --standalone       also write a single-file dashboard.html
"""

from __future__ import annotations

import concurrent.futures as futures
import email
import email.policy
import gzip
import hashlib
import html as htmllib
import json
import os
import re
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from datetime import datetime, timedelta, timezone
from email.header import decode_header, make_header

import aiclass
import providers
from email.utils import parsedate_to_datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = json.load(open(os.path.join(HERE, "config.json")))
UA = CONFIG.get("user_agent", "patchvane/2.0")

# Whose patches this run is about, and where its answers go.  Both are
# arguments rather than settings, because one server collects for everybody
# who signs in and each of them gets their own directory.  The values in
# config.json are only the default, for running this by hand.
ME = (os.environ.get("PATCHVANE_OWNER") or os.environ.get("MAINLINE_OWNER") or CONFIG.get("email") or "").lower()
NAME = CONFIG.get("name") or ""
OUT_DIR = HERE
CACHE = os.path.join(HERE, "cache")


def working_for(email: str, name: str = "", out_dir: str = "") -> None:
    """Point this run at one person."""
    global ME, NAME, OUT_DIR, CACHE, UA
    ME = (email or "").strip().lower()
    NAME = name or ""
    OUT_DIR = out_dir or HERE
    # Archives like being able to tell who is fetching and reach them if it
    # is too much, so the address this run is for goes in the User-Agent
    # rather than a name baked into the config.
    UA = "%s (%s)" % (CONFIG.get("user_agent", "patchvane/2.0"), ME)
    # The fetch cache is shared: lore and patchwork answers are the same
    # whoever asked for them, and two people in the same subsystem would
    # otherwise fetch the same threads twice.
    CACHE = os.path.join(HERE, "cache")
    os.makedirs(OUT_DIR, exist_ok=True)
    os.makedirs(CACHE, exist_ok=True)

_print_lock = threading.Lock()


def log(msg: str) -> None:
    with _print_lock:
        sys.stderr.write("[collect] %s\n" % msg)
        sys.stderr.flush()


# --------------------------------------------------------------------------
# fetching, with a cache so a refresh only pays for what changed
# --------------------------------------------------------------------------


class Fetcher:
    def __init__(self, cache_hours: float, fresh: bool = False):
        self.ttl = cache_hours * 3600
        self.fresh = fresh
        self.hits = 0
        self.misses = 0
        self.errors = 0
        self.stale_hits = 0
        self.stale_urls = set()
        os.makedirs(CACHE, exist_ok=True)

    def _path(self, url: str) -> str:
        return os.path.join(CACHE, hashlib.sha1(url.encode()).hexdigest())

    def get(self, url: str, timeout: int = 180, ttl: float | None = None,
            binary: bool = False, retries: int = 4):
        """Return the body, or None.  404 and 400 are cached as misses too, so
        a probe for a commit that is not in a tree is not repeated."""
        path = self._path(url)
        ttl = self.ttl if ttl is None else ttl
        if not self.fresh and os.path.exists(path):
            age = time.time() - os.path.getmtime(path)
            if age < ttl:
                self.hits += 1
                blob = open(path, "rb").read()
                if blob == b"\x00MISSING":
                    return None
                return blob if binary else blob.decode("utf-8", "replace")

        def stale():
            """What was last fetched, however old.

            When git.kernel.org cannot be reached, answering "no commits" is
            worse than answering with yesterday's list: it silently moves
            every merged patch back to unmerged.  Better to say something
            slightly old, and say that it is old."""
            if self.fresh or not os.path.exists(path):
                return None
            blob = open(path, "rb").read()
            if blob == b"\x00MISSING":
                return None
            self.stale_hits += 1
            self.stale_urls.add(url)
            return blob if binary else blob.decode("utf-8", "replace")

        delay = 1.0
        for attempt in range(retries):
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            try:
                with urllib.request.urlopen(req, timeout=timeout) as r:
                    blob = r.read()
                self.misses += 1
                with open(path, "wb") as fh:
                    fh.write(blob)
                return blob if binary else blob.decode("utf-8", "replace")
            except urllib.error.HTTPError as exc:
                if exc.code in (404, 400, 403):
                    with open(path, "wb") as fh:
                        fh.write(b"\x00MISSING")
                    return None
                if exc.code in (429, 500, 502, 503, 504):
                    time.sleep(delay)
                    delay *= 2
                    continue
                self.errors += 1
                return stale()
            except Exception:
                time.sleep(delay)
                delay *= 2
        self.errors += 1
        return stale()

    def head_ok(self, url: str, ttl: float | None = None) -> bool:
        """Does this URL resolve?  Used to ask a tree whether it holds a sha.
        cgit answers 301 for a short sha it can expand, 400 when it cannot."""
        path = self._path("HEAD " + url)
        ttl = self.ttl if ttl is None else ttl
        if not self.fresh and os.path.exists(path):
            age = time.time() - os.path.getmtime(path)
            if age < ttl:
                self.hits += 1
                return open(path, "rb").read() == b"1"

        had = (open(path, "rb").read() == b"1"
               if not self.fresh and os.path.exists(path) else None)
        result = False
        reached = False
        delay = 1.0
        for _ in range(4):
            req = urllib.request.Request(url, headers={"User-Agent": UA},
                                         method="HEAD")
            try:
                with urllib.request.urlopen(req, timeout=60) as r:
                    result = r.status < 400
                reached = True
                break
            except urllib.error.HTTPError as exc:
                reached = True
                if exc.code in (301, 302):
                    result = True
                    break
                if exc.code in (429, 503, 502, 504):
                    reached = False
                    time.sleep(delay)
                    delay *= 2
                    continue
                result = False
                break
            except Exception:
                time.sleep(delay)
                delay *= 2

        if not reached:
            # The tree did not answer.  "It does not have this commit" would
            # be a lie, and one that quietly un-merges a patch.
            self.errors += 1
            if had is not None:
                self.stale_hits += 1
                self.stale_urls.add(url)
                return had
            return False

        self.misses += 1
        with open(path, "wb") as fh:
            fh.write(b"1" if result else b"0")
        return result


# --------------------------------------------------------------------------
# small helpers
# --------------------------------------------------------------------------

TAG_NAMES = ("Reviewed-by", "Acked-by", "Tested-by", "Nacked-by",
             "Signed-off-by", "Suggested-by", "Reported-by", "Co-developed-by")
TAG_RE = re.compile(r"^(%s):[ \t]*(.+?)\s*$" % "|".join(TAG_NAMES), re.M)

TREE_WORD = r"(?:my\s+|our\s+|the\s+)?[\w./-]*(?:-next|tree|\.git|for-[\w.]+|queue)"

APPLIED_RE = re.compile(
    r"(applied[,!.]?\s+thanks|applied\s+to\b|now applied|thanks,?\s+applied|"
    r"has been applied|series applied|pushed to |queued (?:up )?for|"
    r"i(?:'ve| have) applied|^[ \t]*applied[.!]*[ \t]*$|"
    r"added\s+[^.\n]{0,28}?to\s+" + TREE_WORD + r"|"
    r"merged\s+(?:this\s+|it\s+)?in?to\s+" + TREE_WORD + r"|"
    r"picked\s+(?:this|it|them|the series)?\s*up|"
    r"tak(?:e|en|ing)\s+(?:it|this|them|the series)?\s*in?to\s+" + TREE_WORD +
    r")", re.I | re.M)

# "this cannot be applied to net-next" is the opposite of good news
NOT_APPLIED_RE = re.compile(
    r"\b(not|n't|cannot|can not|won't|unable|fails?|failed|failing|"
    r"does not|doesn)\b[^.\n]{0,24}$", re.I)


def says_applied(text: str) -> bool:
    """True when someone is telling us a patch went in.  Maintainers phrase it
    a dozen ways: "Applied, thanks", a bare "Applied.", or Mark Brown's
    "Applied to" followed by a bare URL on the next line."""
    for m in APPLIED_RE.finditer(text):
        if NOT_APPLIED_RE.search(text[max(0, m.start() - 40):m.start()]):
            continue
        return True
    return False

BOT_ADDRS = ("patchwork-bot", "bot+bpf-ci", "lkp@intel.com", "syzbot",
             "kernel test robot", "noreply", "no-reply", "mailer-daemon",
             "bot@", "ci@")

MERGE_STATES = {"merged", "in-next", "in-tree", "accepted"}


def norm(s: str) -> str:
    """One canonical form for a subject, so the same patch matches whether it
    came from lore, from patchwork or from a cgit log."""
    s = htmllib.unescape(s or "")
    s = " ".join(s.split())
    while True:
        m = re.match(r"^\s*(re|aw|fwd|fw)\s*:\s*(.*)$", s, re.I)
        if not m:
            break
        s = m.group(2)
    while True:
        m = re.match(r"^\s*\[[^\]]*\]\s*(.*)$", s)
        if not m:
            break
        s = m.group(1)
    s = re.sub(r"[\u2018\u2019\u201c\u201d`]", '"', s)
    s = re.sub(r"\s+", " ", s).strip().strip(".").lower()
    return s


def dec(value) -> str:
    if not value:
        return ""
    try:
        return " ".join(str(make_header(decode_header(str(value)))).split())
    except Exception:
        return " ".join(str(value).split())


def addr_of(s: str) -> str:
    m = re.search(r"<([^>]+)>", s or "")
    if m:
        return m.group(1).lower()
    m = re.search(r"([\w.+-]+@[\w.-]+)", s or "")
    return m.group(1).lower() if m else ""


def name_of(s: str) -> str:
    n = re.sub(r"\s*<[^>]*>", "", s or "").strip().strip('"').strip()
    return n or addr_of(s)


def is_bot(frm: str) -> bool:
    low = (frm or "").lower()
    return any(b in low for b in BOT_ADDRS)


def iso(dt) -> str:
    try:
        return dt.astimezone().isoformat()
    except Exception:
        return ""


def parse_date(value) -> str:
    try:
        return iso(parsedate_to_datetime(value))
    except Exception:
        return ""


def parse_subject(subject: str) -> dict:
    """Pull the tree, version and position out of a [PATCH ...] subject."""
    out = {"version": 1, "seq": None, "of": None, "tree": "", "is_cover": False,
           "is_patch": False, "resend": False, "rfc": False}
    m = re.match(r"^\s*\[([^\]]*)\]", subject or "")
    if not m:
        return out
    inner = m.group(1)
    tokens = [t for t in re.split(r"[\s,]+", inner) if t]
    for t in tokens:
        tl = t.lower()
        if tl in ("patch", "patchv2"):
            out["is_patch"] = True
        elif tl == "rfc":
            out["rfc"] = True
            out["is_patch"] = True
        elif tl == "resend":
            out["resend"] = True
        elif re.fullmatch(r"v\d+", tl):
            out["version"] = int(tl[1:])
        elif re.fullmatch(r"\d+/\d+", tl):
            a, b = tl.split("/")
            out["seq"], out["of"] = int(a), int(b)
            out["is_cover"] = int(a) == 0
        elif re.fullmatch(r"\d+", tl):
            pass
        elif not out["tree"]:
            out["tree"] = t
    return out


def list_from_id(value: str) -> str:
    m = re.search(r"<([^>]+)>", value or "")
    if not m:
        return ""
    return m.group(1).split(".")[0]


# --------------------------------------------------------------------------
# source: lore.kernel.org
# --------------------------------------------------------------------------


def lore_search(f: Fetcher, out: dict) -> list:
    """Every message the address posted, newest first, via the search feed."""
    base = CONFIG["lore"]["base"]
    limit = CONFIG["lore"].get("max_messages", 3000)
    query = urllib.parse.quote("f:%s" % ME)
    entries, offset = [], 0

    while offset < limit:
        url = "%s/all/?q=%s&x=A&o=%d" % (base, query, offset)
        # the newest page goes stale fastest, so give it a short ttl
        body = f.get(url, ttl=600 if offset == 0 else None)
        if not body:
            break
        chunk = re.findall(r"<entry>(.*?)</entry>", body, re.S)
        if not chunk:
            break
        for raw in chunk:
            # every atom tag here can carry attributes, and public-inbox puts
            # a newline before them, so the name has to be matched loosely
            title = re.search(r"<title[^>]*>(.*?)</title>", raw, re.S)
            updated = re.search(r"<updated[^>]*>(.*?)</updated>", raw, re.S)
            link = re.search(r'<link[^>]*href="([^"]+)"', raw, re.S)
            if not (title and link):
                continue
            href = link.group(1)
            msgid = href.rstrip("/").rsplit("/", 1)[-1]
            entries.append({
                "subject": htmllib.unescape(
                    re.sub(r"\s+", " ", title.group(1)).strip()),
                "date": updated.group(1) if updated else "",
                "msgid": urllib.parse.unquote(msgid),
                "url": href,
            })
        offset += len(chunk)
        if len(chunk) < 200:
            break

    seen, uniq = set(), []
    for e in entries:
        if e["msgid"] in seen:
            continue
        seen.add(e["msgid"])
        uniq.append(e)
    log("lore: %d messages posted from %s" % (len(uniq), ME))
    return uniq


def split_mbox(blob: bytes):
    """public-inbox hands back mboxrd; split it and undo the >From escaping."""
    text = blob.decode("utf-8", "replace")
    parts = re.split(r"(?m)^From mboxrd@z[^\n]*\n", text)
    for part in parts:
        if not part.strip():
            continue
        part = re.sub(r"(?m)^>(>*From )", r"\1", part)
        try:
            yield email.message_from_string(part, policy=email.policy.default)
        except Exception:
            continue


def body_text(msg) -> str:
    try:
        part = msg.get_body(preferencelist=("plain",))
        if part is not None:
            return part.get_content()
    except Exception:
        pass
    try:
        payload = msg.get_payload(decode=True)
        if payload:
            return payload.decode("utf-8", "replace")
    except Exception:
        pass
    return ""


def unquoted(text: str) -> str:
    return "\n".join(l for l in text.splitlines() if not l.lstrip().startswith(">"))


def fetch_thread(f: Fetcher, msgid: str, depth: int = 1) -> list:
    """Every message in the thread that holds this message id.

    CI robots often post a report whose References do not point back at the
    cover letter, so lore files it as a thread of its own.  Our reply to the
    robot still names it as a parent, so any parent referenced from inside the
    thread but missing from it is pulled in as well."""
    msgs = _fetch_thread_once(f, msgid)
    if not msgs or depth <= 0:
        return msgs

    have = {m["msgid"] for m in msgs if m["msgid"]}
    missing = []
    for m in msgs:
        for parent in [m["in_reply_to"]] + m["refs"][-2:]:
            if parent and parent not in have and parent not in missing:
                missing.append(parent)
    for parent in missing[:3]:
        for extra in _fetch_thread_once(f, parent):
            if extra["msgid"] and extra["msgid"] not in have:
                have.add(extra["msgid"])
                msgs.append(extra)
    return msgs


def _fetch_thread_once(f: Fetcher, msgid: str) -> list:
    base = CONFIG["lore"]["base"]
    url = "%s/all/%s/t.mbox.gz" % (base, urllib.parse.quote(msgid))
    blob = f.get(url, binary=True)
    if not blob or blob[:2] != b"\x1f\x8b":
        return []
    try:
        raw = gzip.decompress(blob)
    except Exception:
        return []

    msgs = []
    for m in split_mbox(raw):
        frm = dec(m.get("From"))
        subject = dec(m.get("Subject"))
        text = body_text(m)
        clean = unquoted(text)
        mine = ME in frm.lower()

        tags = []
        if not mine:
            for tag, who in TAG_RE.findall(clean):
                who = dec(who)
                if ME in who.lower() or tag == "Signed-off-by":
                    continue
                tags.append({"tag": tag, "who": who, "addr": addr_of(who),
                             "name": name_of(who)})

        excerpt = ""
        for line in clean.splitlines():
            s = line.strip()
            if not s or s.startswith("--") or re.match(r"^On .*(wrote|writes):$", s):
                continue
            if re.match(r"^\w[\w .'-]*(wrote|writes):$", s):
                continue
            excerpt = s
            break

        commits = re.findall(r"\b([0-9a-f]{12,40})\b", clean[:6000])
        msgs.append({
            "msgid": (m.get("Message-ID") or "").strip().strip("<>"),
            "in_reply_to": (m.get("In-Reply-To") or "").strip().strip("<>"),
            "refs": [r.strip("<>") for r in
                     (m.get("References") or "").split()],
            "from": frm,
            "name": name_of(frm),
            "addr": addr_of(frm),
            "subject": subject,
            "date": parse_date(m.get("Date")),
            "list": list_from_id(m.get("List-Id") or ""),
            "mine": mine,
            "bot": is_bot(frm),
            "tags": tags,
            "applied": says_applied(clean[:5000]),
            "question": "?" in clean[:4000],
            "excerpt": excerpt[:400],
            "commit_hints": commits[:6],
            "body": clean[:20000],
        })
    return msgs


def to_dt(value: str):
    try:
        return datetime.fromisoformat((value or "").replace("Z", "+00:00"))
    except Exception:
        return None


def merge_stems(stems: dict) -> list:
    """One git send-email run gives every message it posts the same message id
    stem.  A series sent as several runs therefore arrives as several stems
    even though the subjects still read 3/14, so stems that continue the same
    numbering, for the same tree and version, close together in time, are
    folded back into one series."""
    buckets = defaultdict(list)
    clusters = []
    for k, msgs in stems.items():
        of = max([m["of"] or 0 for m in msgs] or [0])
        if of <= 1:
            clusters.append([k])
            continue
        version = max(m["version"] for m in msgs)
        tree = next((m["tree"] for m in msgs if m["tree"]), "")
        buckets[(of, version, tree)].append(k)

    for (of, _version, _tree), keys in buckets.items():
        keys.sort(key=lambda k: min(m["date"] for m in stems[k]))
        cur, cur_seqs, cur_end, cur_n = [], set(), None, 0
        for k in keys:
            seqs = {m["seq"] for m in stems[k] if m["seq"] is not None}
            start = to_dt(min(m["date"] for m in stems[k]))
            gap = ((start - cur_end).total_seconds() / 3600
                   if cur_end and start else 0)
            if cur and (seqs & cur_seqs or cur_n + len(stems[k]) > of + 1
                        or gap > 6):
                clusters.append(cur)
                cur, cur_seqs, cur_n = [], set(), 0
            cur.append(k)
            cur_seqs |= seqs
            cur_n += len(stems[k])
            cur_end = to_dt(max(m["date"] for m in stems[k]))
        if cur:
            clusters.append(cur)
    return clusters


def collect_lore(f: Fetcher, out: dict) -> None:
    posts = lore_search(f, out)
    if not posts:
        raise RuntimeError("lore returned nothing")

    def stem(msgid: str):
        m = re.match(r"^(\d{8,17}\.\d+)-\d+-", msgid)
        return m.group(1) if m else None

    stems = defaultdict(list)
    loose = []
    for p in posts:
        p.update(parse_subject(p["subject"]))
        if not p["is_patch"]:
            loose.append(p)
            continue
        stems[stem(p["msgid"]) or p["msgid"]].append(p)

    # one thread fetch per stem: a split series is several threads and every
    # one of them can carry replies
    roots = {}
    for k, msgs in stems.items():
        ordered = sorted(msgs, key=lambda m: m["msgid"])
        cover = next((m for m in ordered if m["is_cover"]), None)
        roots[k] = (cover or ordered[0])["msgid"]

    keys = list(stems)
    log("lore: %d posting runs to read" % len(keys))
    threads, done = {}, [0]

    def work(k):
        msgs = fetch_thread(f, roots[k])
        with _print_lock:
            done[0] += 1
            if done[0] % 25 == 0 or done[0] == len(keys):
                sys.stderr.write("\r[collect] lore threads %d/%d"
                                 % (done[0], len(keys)))
                sys.stderr.flush()
        return k, msgs

    with futures.ThreadPoolExecutor(
            CONFIG["lore"].get("thread_workers", 4)) as ex:
        for k, msgs in ex.map(work, keys):
            threads[k] = msgs
    sys.stderr.write("\n")

    series, series_threads = {}, {}
    for cluster in merge_stems(stems):
        msgs = [m for k in cluster for m in stems[k]]
        sid = sorted(cluster)[0]
        series[sid] = msgs
        seen, merged = set(), []
        for k in cluster:
            for m in threads.get(k, []):
                if m["msgid"] and m["msgid"] in seen:
                    continue
                seen.add(m["msgid"])
                merged.append(m)
        series_threads[sid] = merged

    log("lore: %d series, %d loose messages" % (len(series), len(loose)))
    out["lore_posts"] = posts
    out["lore_series"] = series
    out["lore_threads"] = series_threads
    out["lore_loose"] = loose
    out["sources"]["lore"] = {
        "ok": True,
        "messages": len(posts),
        "series": len(series),
        "runs": len(keys),
        "threads": sum(1 for v in series_threads.values() if v),
        "replies": sum(1 for v in series_threads.values()
                       for m in v if not m["mine"]),
    }


# --------------------------------------------------------------------------
# source: patchwork
# --------------------------------------------------------------------------


def collect_patchwork(f: Fetcher, out: dict) -> None:
    base = CONFIG["patchwork"]["base"]
    url = "%s/api/1.2/patches/?submitter=%s&per_page=100" % (
        base, urllib.parse.quote(ME))
    rows, page = [], 0
    while url and page < 30:
        body = f.get(url, ttl=900)
        if not body:
            break
        data = json.loads(body)
        if not data:
            break
        for p in data:
            s0 = (p.get("series") or [{}])[0] if p.get("series") else {}
            rows.append({
                "project": (p.get("project") or {}).get("link_name") or "?",
                "state": p["state"],
                "check": p.get("check"),
                "name": p["name"],
                "key": norm(p["name"]),
                "date": p["date"],
                "msgid": (p.get("msgid") or "").strip("<>"),
                "url": p.get("web_url"),
                "commit": p.get("commit_ref"),
                "delegate": (p.get("delegate") or {}).get("username"),
                "series_version": s0.get("version"),
            })
        page += 1
        # the API paginates by link header, which the cache does not keep, so
        # walk pages by number instead
        if len(data) < 100:
            break
        url = "%s/api/1.2/patches/?submitter=%s&per_page=100&page=%d" % (
            base, urllib.parse.quote(ME), page + 1)

    out["patchwork"] = rows
    out["sources"]["patchwork"] = {
        "ok": True, "records": len(rows),
        "unique": len({r["msgid"] for r in rows}),
        "projects": len({r["project"] for r in rows}),
    }
    log("patchwork: %d records across %d projects"
        % (len(rows), len({r["project"] for r in rows})))


# --------------------------------------------------------------------------
# source: git.kernel.org, for what landed where
# --------------------------------------------------------------------------

CGIT_ROW = re.compile(r"<tr>(.*?)</tr>", re.S)
CGIT_SHA = re.compile(r"commit/\?id=([0-9a-f]{7,40})'>(.*?)</a>", re.S)
CGIT_DATE = re.compile(r"title='(\d{4}-\d\d-\d\d[^']*)'")


def cgit_author_log(f: Fetcher, base: str, path: str) -> list:
    url = ("%s%s/log/?qt=author&q=%s&n=200"
           % (base, path, urllib.parse.quote(ME)))
    body = f.get(url, timeout=240)
    if not body:
        return []
    found = []
    for row in CGIT_ROW.findall(body):
        m = CGIT_SHA.search(row)
        if not m:
            continue
        d = CGIT_DATE.search(row)
        subject = htmllib.unescape(re.sub(r"<[^>]+>", "", m.group(2))).strip()
        if not subject:
            continue
        found.append({
            "commit": m.group(1),
            "subject": subject,
            "key": norm(subject),
            "date": (d.group(1) if d else "")[:19],
        })
    return found


# A mailing list name or a subject prefix, and the trees worth asking about
# when we see it.  Keeps the scan to the maintainers we actually posted to.
TREE_ALIASES = {
    "netdev": ["net-next", "net"], "net-next": ["net-next", "net"],
    "net": ["net-next", "net"],
    "bpf": ["bpf-next"], "bpf-next": ["bpf-next"],
    "netfilter": ["nf-next"], "nf-next": ["nf-next"], "nf": ["nf-next"],
    "gtp": ["gtp"],
    "wireless": ["wireless-next"], "ath": ["wireless-next"],
    "rtw": ["wireless-next"], "wcn36xx": ["wireless-next"],
    "intel-wired-lan": ["iwl-next"], "iwl-next": ["iwl-next"],
    "wpan": ["wpan-next"],
    "alsa-devel": ["asoc", "sound"], "sound": ["asoc", "sound"],
    "asoc": ["asoc", "sound"], "cirrus": ["asoc", "sound"],
    "spi": ["spi"], "regmap": ["regmap"], "regulator": ["regulator"],
    "linuxppc-dev": ["powerpc"], "powerpc": ["powerpc"],
    "linux-arm-kernel": ["arm64", "soc"], "arm64": ["arm64", "soc"],
    "soc": ["soc"], "tip": ["tip"], "x86": ["tip"],
    "linux-mm": ["mm"], "mm": ["mm"], "akpm": ["mm"],
    "linux-usb": ["usb"], "usb": ["usb"],
    "linux-serial": ["tty"], "tty": ["tty"],
    "driver-core": ["driver-core", "char-misc"],
    "linux-staging": ["staging"], "staging": ["staging"],
    "linux-scsi": ["scsi"], "scsi": ["scsi"],
    "linux-pm": ["linux-pm"], "linux-input": ["input"], "input": ["input"],
    "linux-leds": ["leds"], "leds": ["leds"], "mfd": ["mfd"],
    "platform-driver-x86": ["pdx86"], "pdx86": ["pdx86"],
    "chrome-platform": ["chrome-platform"],
    "linux-xfs": ["xfs"], "xfs": ["xfs"],
    "linux-rtc": ["rtc"], "rtc": ["rtc"],
    "linux-clk": ["clk"], "clk": ["clk"],
    "linux-gpio": ["gpio", "pinctrl"], "gpio": ["gpio"],
    "pinctrl": ["pinctrl"], "nomadik": ["nomadik"],
    "linux-i2c": ["i2c"], "i2c": ["i2c"],
    "linux-fpga": ["fpga"], "fpga": ["fpga"],
    "linux-hyperv": ["hyperv"], "hyperv": ["hyperv"],
    "loongarch": ["loongarch"], "linux-m68k": ["m68knommu"],
    "linux-parisc": ["parisc"], "linux-s390": ["s390"],
    "linux-hid": ["hid"], "linux-kselftest": ["kselftest"],
    "kselftest": ["kselftest"], "kvm": ["kvm"], "kvmarm": ["kvmarm"],
    "coresight": ["coresight"], "linux-nfs": ["nfsd"],
    "linux-media": ["media"], "linux-pci": ["pci"], "pci": ["pci"],
    "linux-mips": ["mips"], "linux-riscv": ["riscv"],
    "linux-trace-kernel": ["trace"], "linux-perf-users": ["perf"],
    "linux-fsdevel": ["vfs"], "linux-crypto": ["crypto"],
    "linux-mtd": ["mtd", "ubifs"], "iommu": ["iommu"],
    "dmaengine": ["dmaengine"], "linux-phy": ["phy"],
    "linux-hwmon": ["hwmon"], "cgroups": ["cgroup"],
    "linux-edac": ["edac"], "linux-efi": ["efi"],
    "linux-modules": ["modules"], "linux-hexagon": ["hexagon"],
    "linux-omap": ["omap"], "linux-arm-msm": ["msm"],
    "linux-stm32": ["stm32"], "linux-remoteproc": ["remoteproc"],
    "nvdimm": ["nvdimm"], "linux-thermal": ["thermal"],
    "live-patching": ["livepatching"], "linux-extcon": ["extcon"],
    "virtualization": ["vhost"], "linux-arch": ["asm-generic"],
    "asm-generic": ["asm-generic"], "linux-watchdog": [],
}


def trees_for(*hints: str) -> set:
    found = set()
    for h in hints:
        h = (h or "").lower()
        if not h:
            continue
        found.update(TREE_ALIASES.get(h, []))
        if h in CONFIG["korg"]["trees"]:
            found.add(h)
    return found


def trees_by_patch(out: dict) -> dict:
    """Subject key -> the maintainer trees that patch was actually aimed at."""
    result = defaultdict(set)
    for r in out.get("patchwork", []):
        result[r["key"]] |= trees_for(r.get("project"))
    threads = out.get("lore_threads", {})
    for sid, msgs in out.get("lore_series", {}).items():
        hints = {m["tree"] for m in msgs if m.get("tree")}
        hints |= {m["list"] for m in threads.get(sid, []) if m.get("list")}
        trees = trees_for(*hints)
        for m in msgs:
            result[norm(m["subject"])] |= trees
    return result


def relevant_trees(out: dict) -> set:
    """Which maintainer trees the posts actually point at."""
    hints = set()
    for msgs in out.get("lore_series", {}).values():
        for m in msgs:
            if m.get("tree"):
                hints.add(m["tree"].lower())
    for msgs in out.get("lore_threads", {}).values():
        for m in msgs:
            if m.get("list"):
                hints.add(m["list"].lower())
    for r in out.get("patchwork", []):
        hints.add((r.get("project") or "").lower())

    wanted = set()
    for h in hints:
        for name in TREE_ALIASES.get(h, []):
            wanted.add(name)
        if h in CONFIG["korg"]["trees"]:
            wanted.add(h)
    return wanted


def collect_korg(f: Fetcher, out: dict, quick: bool = False,
                 everything: bool = False) -> None:
    """Two questions, answered two different ways.

    Is it merged, and is it queued for the merge window?  cgit can list every
    commit by an author, so one search of Linus' tree and one of linux-next
    answers that for every patch at once.  linux-next pulls in every
    maintainer's -next branch, so a patch a maintainer took shows up there
    within a day.

    Which maintainer took it?  The author search is expensive, minutes per
    tree, because cgit walks the whole history.  Where patchwork already told
    us the commit hash there is no need to search at all: asking a tree for
    that one hash is a single fast request, and the tree either has the object
    or it does not.
    """
    cfg = CONFIG["korg"]
    base = cfg["base"]
    all_trees = cfg.get("trees", {})

    sweep = dict(cfg.get("always", {}))
    tree_urls = {name: base + path for name, path in
                 dict(all_trees, **sweep).items()}
    landed = defaultdict(dict)          # tree -> subject key -> commit

    for name, path in sweep.items():
        rows = cgit_author_log(f, base, path)
        log("git.kernel.org: %-12s %d commits" % (name, len(rows)))
        for r in rows:
            landed[name].setdefault(r["key"], r)

    # hashes we already know about, from patchwork and from maintainers who
    # replied with one
    known = {}
    for r in out.get("patchwork", []):
        if r.get("commit") and len(r["commit"]) >= 12:
            known[r["key"]] = r["commit"]
    for msgs in out.get("lore_threads", {}).values():
        for m in msgs:
            if not m.get("applied"):
                continue
            for h in m.get("commit_hints", []):
                if len(h) >= 12:
                    known.setdefault(norm(m["subject"]), h)

    # Every maintainer tree carries Linus' history, so once a patch is in
    # mainline every tree answers yes and the answer means nothing.  Only ask
    # about a hash that has not reached mainline, and only ask the trees that
    # patch was actually sent to.
    where_sent = trees_by_patch(out)
    jobs = []
    for key, sha in known.items():
        if key in landed.get("mainline", {}):
            continue
        for tree in sorted(where_sent.get(key, ())):
            if tree in all_trees and key not in landed.get(tree, {}):
                jobs.append((key, sha, tree))

    probed = 0
    if jobs:
        def probe(job):
            key, sha, tree = job
            url = "%s%s/commit/?id=%s" % (base, all_trees[tree], sha)
            return job, f.head_ok(url, ttl=6 * 3600)

        with futures.ThreadPoolExecutor(cfg.get("workers", 3)) as ex:
            for (key, sha, tree), hit in ex.map(probe, jobs):
                probed += 1
                if hit:
                    landed[tree].setdefault(key, {
                        "commit": sha, "subject": "", "key": key, "date": "",
                    })
        log("git.kernel.org: checked %d hashes against the trees they were "
            "sent to" % probed)

    # the slow path, only when it is asked for
    if everything and not quick:
        rest = [(n, p) for n, p in all_trees.items() if n not in sweep]
        done = [0]

        def scan(item):
            name, path = item
            rows = cgit_author_log(f, base, path)
            with _print_lock:
                done[0] += 1
                log("git.kernel.org %d/%d %-14s %d commits"
                    % (done[0], len(rest), name, len(rows)))
            return name, rows

        with futures.ThreadPoolExecutor(cfg.get("workers", 3)) as ex:
            for name, rows in ex.map(scan, rest):
                for r in rows:
                    landed[name].setdefault(r["key"], r)

    out["landed"] = {t: list(v.values()) for t, v in landed.items()}
    out["tree_urls"] = tree_urls
    out["sources"]["korg"] = {
        "ok": True,
        "swept": ", ".join(sweep),
        "hashes_probed": probed,
        "full_scan": bool(everything and not quick),
        "trees_with_commits": len([t for t, v in landed.items() if v]),
        "hits": sum(len(v) for v in landed.values()),
    }
    log("git.kernel.org: our commits found in %d trees"
        % len([t for t, v in landed.items() if v]))


# --------------------------------------------------------------------------
# stitch it together
# --------------------------------------------------------------------------


def build(out: dict, brain=None) -> dict:
    evidence = {}            # msgid -> what was known when it was classified
    posts = out.get("lore_posts", [])
    lore_series = out.get("lore_series", {})
    threads = out.get("lore_threads", {})
    pw = out.get("patchwork", [])
    landed = out.get("landed", {})
    tree_urls = out.get("tree_urls", {})
    lore_base = CONFIG["lore"]["base"]

    pw_by_msgid = {r["msgid"]: r for r in pw if r["msgid"]}
    pw_by_key = defaultdict(list)
    for r in pw:
        pw_by_key[r["key"]].append(r)

    # key -> {tree: record}
    landed_by_key = defaultdict(dict)
    for tree, rows in landed.items():
        for r in rows:
            landed_by_key[r["key"]][tree] = r

    def landed_for(key: str) -> dict:
        """Maintainers routinely reword a subject as they apply it, usually by
        adding detail: "LoongArch: fix typo" goes in as "LoongArch: Fix typo
        ... of vmlinux.lds.S".  Fall back to a prefix match so the commit is
        still tied to the patch it came from."""
        if key in landed_by_key:
            return landed_by_key[key]
        if len(key) < 20:
            return {}
        for other, where in landed_by_key.items():
            if len(other) >= 20 and (other.startswith(key)
                                     or key.startswith(other)):
                return where
        return {}

    def lore_url(msgid: str) -> str:
        return "%s/all/%s/" % (lore_base, urllib.parse.quote(msgid))

    patches, series_out = [], []

    for key, msgs in lore_series.items():
        thread = threads.get(key) or []
        by_msgid = {m["msgid"]: m for m in thread}
        replies = [m for m in thread if not m["mine"]]
        human_replies = [m for m in replies if not m["bot"]]
        bot_replies = [m for m in replies if m["bot"]]

        our_ids = {m["msgid"] for m in msgs}
        # a reply lands on a patch when it answers that message directly
        replies_for = defaultdict(list)
        for r in replies:
            target = r["in_reply_to"]
            hops = 0
            while target and target not in our_ids and hops < 6:
                nxt = by_msgid.get(target)
                target = nxt["in_reply_to"] if nxt else None
                hops += 1
            replies_for[target if target in our_ids else None].append(r)

        ordered = sorted(msgs, key=lambda m: (m["seq"] if m["seq"] is not None
                                              else 999, m["msgid"]))
        cover = next((m for m in ordered if m["is_cover"]), None)
        members = [m for m in ordered if not m["is_cover"]]
        if not members:
            members = ordered

        listname = ""
        for m in thread:
            if m.get("list"):
                listname = m["list"]
                break

        version = max([m["version"] for m in ordered] or [1])
        sent_at = min([m["date"] for m in ordered if m["date"]] or [""])
        tree_hint = next((m["tree"] for m in ordered if m["tree"]), "")

        # A maintainer usually answers the cover letter, not the individual
        # patches: "Applied 1-2 to sched_ext/for-7.4" arrives once, on the
        # cover, and is the only record that either patch was taken.  Those
        # replies belong to every patch under the cover.
        cover_replies = replies_for.get(cover["msgid"], []) if cover else []

        series_patches = []
        for m in members:
            k = norm(m["subject"])
            pwrec = pw_by_msgid.get(m["msgid"])
            if not pwrec:
                cands = [c for c in pw_by_key.get(k, [])
                         if (c["series_version"] or 1) == version]
                pwrec = (cands or pw_by_key.get(k, [None]))[0]

            where = landed_for(k)
            mine_replies = replies_for.get(m["msgid"], [])
            tags = [t for r in mine_replies for t in r["tags"]]

            state, detail, firm = classify(pwrec, where, mine_replies, m,
                                           cover_replies)
            # Kept aside so that, once every version of every patch is known,
            # the whole history of one can be looked at together.
            evidence[m["msgid"]] = {"replies": mine_replies, "firm": firm,
                                    "pw": pwrec, "where": where,
                                    "cover": cover_replies}

            patch = {
                "subject": re.sub(r"^\s*\[[^\]]*\]\s*", "", m["subject"]),
                "raw_subject": m["subject"],
                "key": k,
                "msgid": m["msgid"],
                "series": key,
                "series_name": (re.sub(r"^\s*\[[^\]]*\]\s*", "",
                                       cover["subject"]) if cover else ""),
                "seq": m["seq"],
                "of": m["of"],
                "version": m["version"],
                "tree_hint": tree_hint,
                "list": listname,
                "date": m["date"],
                "lore": lore_url(m["msgid"]),
                "state": state,
                "state_detail": detail,
                "pw_state": pwrec["state"] if pwrec else "",
                "pw_url": pwrec["url"] if pwrec else "",
                "pw_project": pwrec["project"] if pwrec else "",
                "check": (pwrec or {}).get("check") or "",
                "delegate": (pwrec or {}).get("delegate") or "",
                "landed": [{
                    "tree": t,
                    "commit": r["commit"],
                    "short": r["commit"][:12],
                    "date": r["date"],
                    "url": "%s/commit/?id=%s" % (tree_urls.get(t, ""),
                                                 r["commit"]),
                } for t, r in sorted(where.items())],
                "in_mainline": "mainline" in where,
                "in_next": "linux-next" in where,
                "reply_count": len(mine_replies),
                "reviewers": sorted({r["name"] for r in mine_replies
                                     if not r["bot"]}),
                "tags": dedupe_tags(tags),
            }
            patches.append(patch)
            series_patches.append(patch)

        states = [p["state"] for p in series_patches]
        series_out.append({
            "id": key,
            "name": (re.sub(r"^\s*\[[^\]]*\]\s*", "", cover["subject"])
                     if cover else (series_patches[0]["subject"]
                                    if series_patches else "")),
            "version": version,
            "tree_hint": tree_hint,
            "list": listname,
            "date": sent_at,
            "count": len(series_patches),
            "lore": lore_url(cover["msgid"] if cover else members[0]["msgid"]),
            "state": rollup(states),
            "states": dict(Counter(states)),
            "merged": sum(1 for p in series_patches if p["in_mainline"]),
            "in_next": sum(1 for p in series_patches if p["in_next"]),
            "accepted": sum(1 for p in series_patches
                            if p["state"] in MERGE_STATES),
            "replies": len(human_replies),
            "bot_replies": len(bot_replies),
            "reviewers": sorted({r["name"] for r in human_replies}),
            "tag_count": sum(len(p["tags"]) for p in series_patches),
            "last_activity": max([m["date"] for m in thread if m["date"]]
                                 or [sent_at]),
            "ci": ci_verdict(bot_replies),
            "waiting_on_us": waiting_on_us(thread),
        })

    patches.sort(key=lambda p: (p["date"] or ""), reverse=True)
    series_out.sort(key=lambda s: (s["date"] or ""), reverse=True)

    link_versions(patches)
    if brain is not None:
        reread(brain, soft_cases(patches, evidence), patches, series_out)
    restate_series(patches, series_out)

    return assemble(out, patches, series_out, threads, tree_urls)


LANDED_STATES = ("merged", "in-next", "in-tree", "accepted")


def link_versions(patches: list) -> None:
    """Tie every version of a patch together, and let the newest one speak.

    A patch resent as v2 is the same piece of work, so the two rows must not
    both count.  Two things go wrong without this: an abandoned v1 sits in the
    totals for ever as "no reply yet", and a single commit gets credited to
    every version that shares its subject, so one accepted patch is counted
    three times.

    A version is superseded by a later one unless it is the version that
    actually landed, which is decided by date: the newest one sent before the
    commit was made."""
    by_key = defaultdict(list)
    for p in patches:
        by_key[p["key"]].append(p)

    for rows in by_key.values():
        rows.sort(key=lambda p: (p["version"], p["date"] or ""))
        top = rows[-1]["version"]

        # Which version the commit belongs to, when there is one.
        owner = None
        commit_at = ""
        for p in rows:
            for l in p.get("landed") or []:
                if l.get("date") and (not commit_at or l["date"] < commit_at):
                    commit_at = l["date"]
        if commit_at:
            sent_before = [p for p in rows if p["date"] and p["date"] <= commit_at]
            owner = (sent_before or rows)[-1]
        elif any(p.get("landed") for p in rows):
            owner = rows[-1]

        # The same patch posted twice at the same version is one piece of
        # work that produced at most one commit, so the last posting speaks
        # for it and the earlier copies step aside.
        newest = rows[-1]

        for p in rows:
            p["versions"] = [{"version": q["version"], "date": q["date"],
                              "msgid": q["msgid"], "lore": q["lore"],
                              "series": q["series"]} for q in rows]
            p["latest_version"] = top

            if owner is not None and p is not owner and p.get("landed"):
                # The commit belongs to one posting; the others only matched
                # it because they share a subject.
                p["landed"] = []
                p["tree_hint"] = p.get("tree_hint") or ""

            if p is owner or p is newest:
                continue
            if p["state"] in LANDED_STATES and p.get("landed"):
                continue
            p["state"] = "superseded"
            p["state_detail"] = ("replaced by v%d" % top if p["version"] < top
                                 else "the same patch was posted again")
            p["superseded_by"] = top
            p.pop("state_by_ai", None)


def soft_cases(patches: list, evidence: dict) -> list:
    """The patches whose status is worth a second reading, with the whole
    history of each.

    Two kinds qualify.  One is a status this collector inferred from English,
    which is what the regular expressions are weakest at.  The other is a
    patchwork state, which is usually right but goes wrong when a patch is
    caught by the wrong project's instance: sched_ext patches land in netdev's
    patchwork, which marks them not-applicable while the maintainer is busy
    applying them.  Only a commit in a tree is beyond question."""
    by_key = defaultdict(list)
    for p in patches:
        by_key[p["key"]].append(p)

    cases = []
    for p in patches:
        ev = evidence.get(p["msgid"]) or {}
        if p["state"] == "superseded" and p.get("superseded_by"):
            continue                    # settled by arithmetic, not opinion
        if p.get("landed"):
            continue                    # a commit is not a matter of opinion

        replies = ev.get("replies") or []
        pw = ev.get("pw")
        recorded = ("%s on %s" % (pw["state"], pw["project"])) if pw else ""

        # The whole history: every version, what each one was told directly,
        # and what was said on its cover letter.
        history = []
        for q in sorted(by_key[p["key"]], key=lambda x: (x["version"],
                                                         x["date"] or "")):
            qev = evidence.get(q["msgid"]) or {}
            history.append({"version": q["version"], "date": q["date"],
                            "replies": qev.get("replies") or [],
                            "cover": qev.get("cover") or [],
                            "is_this": q["msgid"] == p["msgid"]})

        if pw and not aiclass.worth_checking(p["state"], replies, history):
            continue
        if not pw and not ev.get("firm") and not aiclass.is_soft(p["state"], replies):
            continue
        if not pw and ev.get("firm"):
            continue

        cases.append({"id": p["msgid"], "subject": p["subject"],
                      "replies": replies, "state": p["state"],
                      "recorded": recorded, "history": history,
                      "version": p["version"], "latest": p.get("latest_version",
                                                               p["version"])})
    return cases


def restate_series(patches: list, series_out: list) -> None:
    """A series shows the state of the patches under it, so it is worked out
    again once those have settled."""
    by_series = defaultdict(list)
    for p in patches:
        by_series[p["series"]].append(p["state"])
    for s in series_out:
        states = by_series.get(s["id"]) or []
        if states:
            s["state"] = rollup(states)
            s["states"] = sorted(set(states))


def reread(brain, soft, patches, series_out) -> None:
    """Let a model read the threads the regular expressions had to guess at.

    Hard evidence has already been applied by this point, so nothing here can
    contradict a commit or a patchwork state.  Every state it changes is
    marked, so the dashboard can say which ones a model decided rather than
    presenting them as fact."""
    if not soft:
        return
    if not brain.usable:
        log("  no API key, so %d thread%s keep the state read from their text"
            % (len(soft), "" if len(soft) == 1 else "s"))
        return

    log("  asking a model about %d thread%s the text was unclear on"
        % (len(soft), "" if len(soft) == 1 else "s"))
    verdicts = brain.run(soft)
    if not verdicts:
        return

    by_id = {p["msgid"]: p for p in patches}
    changed = 0
    for msgid, (state, why) in verdicts.items():
        p = by_id.get(msgid)
        if not p or p["state"] == state:
            continue
        p["state"] = state
        p["state_detail"] = why
        p["state_by_ai"] = True
        changed += 1
    brain.changed = changed
    if brain.failed and changed:
        log("  the model changed %d of them, then stopped answering; the "
            "rest keep the status read from their text and are asked about "
            "next time" % changed)
    elif brain.failed:
        log("  none could be read, so they keep the status read from their "
            "text")
    else:
        log("  the model changed %d of them" % changed)


def dedupe_tags(tags: list) -> list:
    seen, uniq = set(), []
    for t in tags:
        k = (t["tag"], t["addr"] or t["who"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(t)
    return uniq


def classify(pwrec, where, replies, msg, cover_replies=()) -> tuple:
    """The single word the dashboard shows for a patch, why, and how sure.

    The third value says whether it rests on hard evidence.  A commit in a
    tree and a state somebody set in patchwork are facts; everything below
    that line is this function reading English, and only those may later be
    re-read by a model."""
    if "mainline" in where:
        return ("merged",
                "in Linus' tree as %s" % where["mainline"]["commit"][:12], True)
    maint = [t for t in where if t not in ("mainline", "linux-next")]
    if "linux-next" in where:
        extra = (" via %s" % ", ".join(maint)) if maint else ""
        return "in-next", "queued in linux-next%s" % extra, True
    if maint:
        return "in-tree", "applied to %s" % ", ".join(maint), True

    if pwrec:
        st = pwrec["state"]
        if st == "accepted":
            return ("accepted", "patchwork marked it accepted%s" % (
                " (%s)" % pwrec["commit"][:12] if pwrec.get("commit") else ""),
                True)
        if st in ("changes-requested", "rejected", "superseded", "deferred",
                  "not-applicable", "handled-elsewhere", "awaiting-upstream",
                  "under-review", "needs-ack", "queued"):
            return st, "patchwork state on %s" % pwrec["project"], True

    # Below here it is all inference from what people wrote.  A reply to the
    # cover letter counts: that is where "applied 1-2" usually lands.
    for pool, where_said in ((replies, ""), (cover_replies, " on the cover")):
        said = [r for r in pool if r["applied"] and not r["bot"]]
        if said:
            return ("accepted",
                    "%s replied that it is applied%s" % (said[0]["name"],
                                                         where_said), False)
    if any(r["applied"] for r in list(replies) + list(cover_replies)):
        return "accepted", "an automated notice said it was applied", False

    human = [r for r in replies if not r["bot"]]
    if any(t["tag"] == "Nacked-by" for r in human for t in r["tags"]):
        return "rejected", "nacked on the list", False
    if human:
        tags = [t for r in human for t in r["tags"]]
        if tags:
            return "reviewed", "%s from %s" % (
                tags[0]["tag"], tags[0]["name"]), False
        return ("under-review", "%d repl%s on the list" % (
            len(human), "y" if len(human) == 1 else "ies"), False)
    return "awaiting", "posted, nothing back yet", False


def rollup(states: list) -> str:
    order = ["merged", "in-next", "in-tree", "accepted", "reviewed",
             "under-review", "awaiting", "queued", "awaiting-upstream",
             "needs-ack", "under-review", "not-applicable",
             "handled-elsewhere", "superseded", "deferred",
             "changes-requested", "rejected"]
    for s in order:
        if s in states:
            # a series is only "merged" when every patch is
            if s in ("merged", "in-next", "in-tree", "accepted"):
                if all(x in MERGE_STATES for x in states):
                    return s
                continue
            return s
    return states[0] if states else "awaiting"


def ci_verdict(bot_replies: list) -> str:
    for r in sorted(bot_replies, key=lambda r: r["date"], reverse=True):
        m = re.search(r"^\s*Status:\s*(\w+)", r["body"], re.M)
        if m:
            return m.group(1).lower()
        if re.search(r"\bbuild (?:failed|error)", r["body"], re.I):
            return "fail"
    return ""


def waiting_on_us(thread: list) -> bool:
    """True when the last word in the thread is a person wanting something.

    A maintainer writing "applied, thanks" has closed the thread, and one who
    only sends a Reviewed-by has said all they mean to say.  Neither needs an
    answer, so neither counts."""
    msgs = sorted([m for m in thread if m["date"]], key=lambda m: m["date"])
    if not msgs:
        return False
    last_ours = max([m["date"] for m in msgs if m["mine"]] or [""])
    later = [m for m in msgs
             if not m["mine"] and not m["bot"] and m["date"] > last_ours]
    if not later:
        return False
    last = later[-1]
    if last["applied"]:
        return False
    if last["tags"] and not last["question"]:
        return False
    return True


# --------------------------------------------------------------------------


def assemble(out, patches, series, threads, tree_urls) -> dict:
    pw = out.get("patchwork", [])

    # per tree, using the tree the subject asked for, falling back to the list
    def tree_of(p):
        return p["tree_hint"] or p["list"] or p["pw_project"] or "unspecified"

    trees = {}
    for p in patches:
        t = trees.setdefault(tree_of(p), {
            "tree": tree_of(p), "patches": 0, "merged": 0, "in_next": 0,
            "accepted": 0, "reviewed": 0, "open": 0, "problems": 0, "tags": 0,
            "series": set(),
        })
        t["patches"] += 1
        t["series"].add(p["series"])
        t["tags"] += len(p["tags"])
        if p["in_mainline"]:
            t["merged"] += 1
        elif p["in_next"]:
            t["in_next"] += 1
        elif p["state"] in MERGE_STATES:
            t["accepted"] += 1
        elif p["state"] in ("changes-requested", "rejected", "superseded",
                            "not-applicable", "handled-elsewhere"):
            t["problems"] += 1
        elif p["state"] == "reviewed":
            t["reviewed"] += 1
        else:
            t["open"] += 1
    for t in trees.values():
        t["series"] = len(t["series"])
    trees = sorted(trees.values(), key=lambda t: -t["patches"])

    # everything that landed, newest first.  A patch reposted as v2 and v3
    # shares one commit, so key the list on the commit, not the posting.
    merged, seen_commits = [], {}
    for p in patches:
        if not p["landed"]:
            continue
        main = next((l for l in p["landed"] if l["tree"] == "mainline"), None)
        nxt = next((l for l in p["landed"] if l["tree"] == "linux-next"), None)
        maint = [l for l in p["landed"]
                 if l["tree"] not in ("mainline", "linux-next")]
        pick = main or nxt or p["landed"][0]
        if pick["commit"] in seen_commits:
            row = seen_commits[pick["commit"]]
            row["versions"] = row.get("versions", 1) + 1
            continue
        seen_commits[pick["commit"]] = row = {
            "subject": p["subject"],
            "commit": pick["commit"],
            "short": pick["short"],
            "url": pick["url"],
            "date": pick["date"] or p["date"][:10],
            "mainline": bool(main),
            "in_next": bool(nxt),
            "trees": [l["tree"] for l in p["landed"]],
            "maintainer_trees": [l["tree"] for l in maint],
            "lore": p["lore"],
            "series": p["series_name"] or p["subject"],
            "versions": 1,
        }
        merged.append(row)
    merged.sort(key=lambda c: c["date"], reverse=True)

    # people and their tags
    people = defaultdict(lambda: {"replies": 0, "tags": 0, "name": "",
                                  "series": set(), "kinds": Counter()})
    tagrows = []
    for s in series:
        thread = threads.get(s["id"]) or []
        for m in thread:
            if m["mine"] or m["bot"]:
                continue
            who = m["addr"] or m["name"]
            rec = people[who]
            rec["name"] = m["name"]
            rec["replies"] += 1
            rec["series"].add(s["id"])
            rec["tags"] += len(m["tags"])
            for t in m["tags"]:
                rec["kinds"][t["tag"]] += 1
    for p in patches:
        for t in p["tags"]:
            tagrows.append({
                "tag": t["tag"], "who": t["name"], "addr": t["addr"],
                "subject": p["subject"], "lore": p["lore"],
                "state": p["state"], "date": p["date"],
            })
    people = sorted(
        ({"addr": k, "name": v["name"], "replies": v["replies"],
          "tags": v["tags"], "series": len(v["series"]),
          "kinds": dict(v["kinds"])} for k, v in people.items()),
        key=lambda p: (-p["tags"], -p["replies"]))

    # timeline
    per_day = defaultdict(lambda: {"sent": 0, "merged": 0, "series": 0})
    for p in patches:
        if p["date"]:
            per_day[p["date"][:10]]["sent"] += 1
    for s in series:
        if s["date"]:
            per_day[s["date"][:10]]["series"] += 1
    for c in merged:
        if c["date"]:
            per_day[c["date"][:10]]["merged"] += 1
    timeline = [{"date": d, **v} for d, v in sorted(per_day.items())]
    run = 0
    for row in timeline:
        run += row["sent"]
        row["cumulative"] = run

    # threads that look like they need us
    openthreads = []
    for s in series:
        thread = sorted([m for m in (threads.get(s["id"]) or []) if m["date"]],
                        key=lambda m: m["date"], reverse=True)
        last = next((m for m in thread if not m["mine"] and not m["bot"]), None)
        if not last:
            continue
        openthreads.append({
            "series": s["name"] or s["id"],
            "id": s["id"],
            "lore": s["lore"],
            "tree": s["tree_hint"] or s["list"],
            "state": s["state"],
            "waiting_on_us": s["waiting_on_us"],
            "last_from": last["name"],
            "last_date": last["date"],
            "excerpt": last["excerpt"],
            # Every reply, not just the newest.  A question like "what did
            # the reviewer ask me to change" is about something said several
            # messages back, and a single excerpt cannot answer it.
            "replies": [{"who": m["name"], "date": m["date"],
                         "text": m["excerpt"]}
                        for m in reversed(thread)
                        if not m["mine"] and not m["bot"]][-12:],
            "count": len([m for m in thread if not m["mine"] and not m["bot"]]),
            "tags": s["tag_count"],
        })
    openthreads.sort(key=lambda t: (not t["waiting_on_us"], t["last_date"]),
                     reverse=False)
    openthreads.sort(key=lambda t: t["last_date"], reverse=True)

    # activity feed
    activity = []
    for s in series:
        activity.append({"ts": s["date"], "kind": "sent",
                         "text": "%s  (%d patch%s)" % (
                             s["name"] or s["id"], s["count"],
                             "" if s["count"] == 1 else "es"),
                         "note": s["tree_hint"] or s["list"] or "",
                         "url": s["lore"]})
    for s in series:
        for m in (threads.get(s["id"]) or []):
            if m["mine"] or not m["date"]:
                continue
            activity.append({
                "ts": m["date"],
                "kind": "ci" if m["bot"] else ("applied" if m["applied"]
                                               else "reply"),
                "text": m["subject"][:130],
                "note": m["name"],
                "url": "%s/all/%s/" % (CONFIG["lore"]["base"],
                                       urllib.parse.quote(m["msgid"])),
            })
    for c in merged:
        activity.append({"ts": (c["date"] or "") + "T12:00:00",
                         "kind": "merged" if c["mainline"] else "queued",
                         "text": c["subject"][:130],
                         "note": ", ".join(c["trees"]),
                         "url": c["url"]})
    activity = [a for a in activity if a["ts"]]
    activity.sort(key=lambda a: a["ts"], reverse=True)

    states = Counter(p["state"] for p in patches)
    netdev_open = sum(1 for p in patches
                      if (p["tree_hint"] or "").startswith("net")
                      and p["state"] in ("awaiting", "under-review", "reviewed",
                                         "needs-ack"))

    kpis = {
        "patches": len(patches),
        "series": len(series),
        "unique_patches": len({p["key"] for p in patches}),
        "versions": sum(1 for s in series if s["version"] > 1),
        # every count comes off the patch state, so the cards, the donut and
        # the tables can never disagree
        "merged": states.get("merged", 0),
        "in_next": states.get("in-next", 0),
        "in_tree": states.get("in-tree", 0),
        "accepted": states.get("accepted", 0),
        "mainline_commits": sum(1 for c in merged if c["mainline"]),
        "landed_total": len(merged),
        "reviewed": states.get("reviewed", 0),
        "under_review": states.get("under-review", 0),
        "awaiting": states.get("awaiting", 0),
        "changes_requested": states.get("changes-requested", 0),
        "rejected": states.get("rejected", 0),
        "superseded": states.get("superseded", 0),
        "not_applicable": (states.get("not-applicable", 0)
                           + states.get("handled-elsewhere", 0)),
        "review_tags": sum(len(p["tags"]) for p in patches),
        "reviewers": len(people),
        "trees": len(trees),
        "lists": len({p["list"] for p in patches if p["list"]}),
        "pw_projects": len({r["project"] for r in pw}),
        "replies": sum(s["replies"] for s in series),
        "waiting_on_us": sum(1 for s in series if s["waiting_on_us"]),
        "ci_fail": sum(1 for s in series if s["ci"] in ("fail", "conflict")),
        "netdev_open": netdev_open,
        "netdev_cap": CONFIG.get("netdev_outstanding_cap", 15),
        "first": min([p["date"] for p in patches if p["date"]], default=""),
        "last": max([p["date"] for p in patches if p["date"]], default=""),
        "states": dict(states),
    }

    return {
        "generated": iso(datetime.now(timezone.utc)),
        "profile": {
            "name": NAME or display_name(out) or ME.split("@")[0],
            "email": ME,
            "lore": "%s/all/?q=%s" % (CONFIG["lore"]["base"],
                                      urllib.parse.quote("f:" + ME)),
            "patchwork": "%s/project/netdevbpf/list/?submitter=%s" % (
                CONFIG["patchwork"]["base"],
                urllib.parse.quote(ME)),
        },
        "sources": out["sources"],
        "kpis": kpis,
        "timeline": timeline,
        "trees": trees,
        "series": series,
        "patches": patches,
        "merged": merged,
        "threads": openthreads,
        "people": people,
        "tagrows": tagrows,
        "activity": activity[:1200],
        "notes": out.get("notes", []),
    }


# --------------------------------------------------------------------------


def display_name(out: dict) -> str:
    """What this person calls themselves, taken from their own posts.

    Config cannot know: one server collects for whoever signs in.  The From:
    line on their patches can, and the name they use most often is the one to
    greet them by."""
    seen = Counter()
    for msgs in (out.get("lore_threads") or {}).values():
        for m in msgs:
            if (m.get("addr") or "").lower() != ME:
                continue
            name = (m.get("name") or "").strip()
            if name and "@" not in name:
                seen[name] += 1
    return seen.most_common(1)[0][0] if seen else ""


def read_notes() -> list:
    path = os.path.join(OUT_DIR, "notes.json")
    if os.path.exists(path):
        try:
            return json.load(open(path))
        except Exception:
            log("notes.json is not valid JSON, ignoring it")
    return []


def render_standalone(data: dict) -> None:
    html = open(os.path.join(HERE, "index.html"), encoding="utf-8").read()
    css = open(os.path.join(HERE, "style.css"), encoding="utf-8").read()
    js = open(os.path.join(HERE, "app.js"), encoding="utf-8").read()
    blob = json.dumps(data, ensure_ascii=False).replace("</", "<\\/")
    html = html.replace('<link rel="stylesheet" href="style.css">',
                        "<style>\n%s\n</style>" % css)
    html = html.replace('<script src="app.js"></script>',
                        "<script>window.__DATA__ = %s;</script>\n<script>\n%s\n"
                        "</script>" % (blob, js))
    dst = os.path.join(HERE, "dashboard.html")
    with open(dst, "w", encoding="utf-8") as fh:
        fh.write(html)
    log("wrote %s (%.0f KB, opens without a server)"
        % (dst, os.path.getsize(dst) / 1024))


def main() -> int:
    argv = sys.argv[1:]
    flags, args, opts = set(), set(), {}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--for", "--name", "--out"):
            opts[a.lstrip("-")] = argv[i + 1] if i + 1 < len(argv) else ""
            i += 2
            continue
        if a.startswith("--") and "=" in a:
            k, v = a[2:].split("=", 1)
            if k in ("for", "name", "out"):
                opts[k] = v
                i += 1
                continue
        (flags if a.startswith("-") else args).add(a)
        i += 1

    working_for(opts.get("for") or ME,
                opts.get("name") or (CONFIG.get("name") if not opts.get("for")
                                     else ""),
                opts.get("out") or HERE)
    if not ME or "@" not in ME:
        log("no address to collect for: pass --for someone@example.com")
        return 2
    log("collecting for %s" % ME)

    wanted = args or {"lore", "patchwork", "korg"}

    f = Fetcher(CONFIG.get("cache_hours", 3), fresh="--fresh" in flags)
    out = {"sources": {}, "notes": read_notes()}
    t0 = time.time()

    steps = [
        ("lore", lambda: collect_lore(f, out)),
        ("patchwork", lambda: collect_patchwork(f, out)),
        ("korg", lambda: collect_korg(f, out, quick="--quick" in flags,
                                      everything="--all-trees" in flags)),
    ]
    for name, fn in steps:
        if name not in wanted:
            out["sources"][name] = {"ok": False, "error": "skipped"}
            continue
        try:
            fn()
        except Exception as exc:
            out["sources"][name] = {"ok": False, "error": str(exc)}
            log("%s FAILED: %s" % (name, exc))
            if "--debug" in flags:
                traceback.print_exc()

    brain = None
    if "--no-ai" not in flags:
        cfg = CONFIG.get("ai") or {}
        providers.configure(cfg.get("endpoints"))
        brain = aiclass.Classifier(
            keys=providers.load_keys(os.path.join(HERE, "secrets.json")),
            models=cfg.get("models"),
            cache_path=os.path.join(CACHE, "ai-states.json"),
            log=log,
            limit=int(cfg.get("classify_limit", 200)))

    data = build(out, brain)
    if brain is not None:
        # A run that answered everything from the cache asked nothing and
        # still used a model's reading, so the two are counted apart.
        data["ai_states"] = {
            "used": bool(brain.changed or brain.asked),
            "asked": brain.asked,
            "changed": brain.changed,
            "error": brain.failed,
        }
    data["collect_seconds"] = round(time.time() - t0, 1)
    data["sources"]["cache"] = {"hits": f.hits, "misses": f.misses,
                                "errors": f.errors, "stale": f.stale_hits}
    if f.stale_hits:
        data["stale"] = {
            "count": f.stale_hits,
            "hosts": sorted({urllib.parse.urlsplit(u).netloc
                             for u in f.stale_urls}),
        }
        log("%d request%s could not be made; used the last known answer for "
            "%s" % (f.stale_hits, "" if f.stale_hits == 1 else "s",
                    ", ".join(sorted({urllib.parse.urlsplit(u).netloc
                                      for u in f.stale_urls}))))

    path = os.path.join(OUT_DIR, "data.json")
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=1)
    log("wrote %s (%.0f KB) in %ss"
        % (path, os.path.getsize(path) / 1024, data["collect_seconds"]))

    # dashboard.html carries the data inside it and answers to nobody, so it
    # is only written when it is asked for
    if "--standalone" in flags:
        try:
            render_standalone(data)
        except FileNotFoundError as exc:
            log("standalone page not built: %s" % exc)

    k = data["kpis"]
    log("%d patches in %d series | merged %d, in linux-next %d, "
        "maintainer tree %d | under review %d, awaiting %d | %d review tags"
        % (k["patches"], k["series"], k["merged"], k["in_next"],
           k["in_tree"] + k["accepted"], k["under_review"] + k["reviewed"],
           k["awaiting"], k["review_tags"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
