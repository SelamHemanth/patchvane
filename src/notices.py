#!/usr/bin/env python3
"""What this server has to say to one person, and whether they have read it.

Three things end up here, and they are deliberately the same thing once
they arrive.  The owner of a deployment writing to everybody; the tree
moving on to a new -rc; a patch somebody sent in June turning up in Linus'
tree.  All three are news about work the reader did not have to ask for,
all three are worth one line and a date, and none of them is worth an
email.

A notice is only ever additive and it is never edited after the fact: the
one thing that changes is whether it has been read.  That matters when the
thing being said is "your patch landed" -- a record that rewrites itself is
no record at all, and this is the nearest thing the dashboard keeps to one.

Stored per person, beside their collection, as plain JSON.  Not in the
vault: nothing in here is a secret, it is read on nearly every poll, and
paying to decrypt a list of "your patch landed" on each one would be a
strange way to spend a request.
"""
import json
import os
import secrets
import time

# Enough that nobody loses a landing they had not looked at yet, and few
# enough that the file stays small: at one a week this is four years.
KEEP = 200


def path_of(home: str) -> str:
    return os.path.join(home, "notices.json")


def read(home: str) -> list:
    """Everything said to this person, newest first."""
    try:
        with open(path_of(home), encoding="utf-8") as fh:
            rows = json.load(fh)
    except (OSError, ValueError):
        return []
    return rows if isinstance(rows, list) else []


def write(home: str, rows: list) -> bool:
    """Replace the file, or leave the old one alone if it cannot be done.

    Through a temporary file: a half-written notices.json read by the next
    poll is a client that thinks it has no notices, and it would then mark
    that nothing as read."""
    try:
        os.makedirs(home, exist_ok=True)
        tmp = path_of(home) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(rows[:KEEP], fh, ensure_ascii=False)
        os.replace(tmp, path_of(home))
        return True
    except OSError:
        return False


def add(home: str, kind: str, title: str, body: str = "",
        url: str = "", frm: str = "", key: str = "") -> dict:
    """Say one thing, and hand back what was said.

    `key` is how a thing that can be noticed twice says so.  A collection
    that runs every twenty minutes will find the same new -rc every time;
    given a key, the second run finds the first one already there and says
    nothing.  Without a key every call is a new notice, which is what the
    owner writing to everybody wants."""
    rows = read(home)
    if key and any(r.get("key") == key for r in rows):
        return {}

    row = {
        "id": secrets.token_hex(8),
        "at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "kind": kind,
        "title": title,
        "body": body,
        "url": url,
        "from": frm,
        "read": False,
    }
    if key:
        row["key"] = key
    rows.insert(0, row)
    write(home, rows)
    return row


def unread(home: str) -> int:
    return sum(1 for r in read(home) if not r.get("read"))


def mark_read(home: str, ids=None) -> int:
    """Mark some, or all of them, and say how many changed.

    All of them is the ordinary case: opening the list is the reading, and
    asking somebody to tick off notices one at a time would be inventing a
    chore.  The per-id form is there for a client that shows one on its
    own."""
    rows = read(home)
    want = set(ids) if ids else None
    hit = 0
    for r in rows:
        if r.get("read"):
            continue
        if want is None or r.get("id") in want:
            r["read"] = True
            hit += 1
    if hit:
        write(home, rows)
    return hit


def clear(home: str) -> int:
    """Throw the read ones away, keeping anything still unread."""
    rows = read(home)
    keep = [r for r in rows if not r.get("read")]
    if len(keep) != len(rows):
        write(home, keep)
    return len(rows) - len(keep)
