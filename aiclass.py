"""Reading what the maintainer actually said.

Most of a patch's status comes from hard evidence: a commit in a tree, or a
state somebody set in patchwork.  What is left is a thread of English, and
the collector reads it with regular expressions.  Those handle "Applied,
thanks" and miss "I've taken this into my tree for the next merge window",
"this needs to go via net-next instead", and every other way a maintainer
might phrase it.

This module hands those, and only those, to a model.  It never overrules a
commit or a patchwork state, it only ever answers with one of the words the
dashboard already knows, and it says on the patch that a model decided, so
nothing here can quietly invent a status.
"""

import hashlib
import json
import os
import re

import providers

# The only answers accepted.  Anything else the model returns is dropped.
VOCABULARY = {
    "accepted": "a maintainer said they applied, took, queued or picked it up",
    "changes-requested": "a reviewer asked for changes, so a new version is owed",
    "rejected": "a maintainer said no, or nacked it",
    "not-applicable": "it does not apply, or belongs somewhere else entirely",
    "handled-elsewhere": "somebody else's patch fixed it first, or it is "
                         "already fixed in another tree",
    "superseded": "a later version of this patch replaced it",
    "awaiting-upstream": "it is waiting on a different tree or subsystem first",
    "reviewed": "somebody reviewed it favourably, or gave a tag, but nobody "
                "has applied it",
    "under-review": "there is discussion but no conclusion yet",
    "awaiting": "nothing of substance has been said",
}

# Which of the inferred states are thin enough to be worth a second opinion.
# The caller has already established that the state was inferred at all: a
# commit or a patchwork record never reaches this.
SOFT = {"accepted", "reviewed", "under-review", "awaiting", "rejected"}

SYSTEM = """You read Linux kernel mailing list threads and say what happened
to a patch.

You are given a patch, every version of it that was sent, and the replies
each version received. Decide what happened to the version marked "this one",
and answer with that exact word:

%s

Rules:
- Answer only from the replies you are shown. Do not guess.
- A maintainer writing "applied", "queued", "taken", "pushed", "picked up"
  or "merged" about this patch means accepted, however they phrase it, and
  whichever branch or tree they name.
- "Applied 1-2 to sched_ext/for-7.4" means both patches were accepted.
- "This does not apply", "please rebase", "send this to another tree", or a
  request for any change means changes-requested, unless they clearly refuse
  it outright, which is rejected.
- A bot saying a build failed is not a rejection by itself.
- Reviewed-by, Acked-by or Tested-by with nobody applying it is reviewed.
- Discussion with no conclusion is under-review.
- Replies to a different version are context, not the answer. What a
  reviewer said about v1 does not decide v2.
- If the replies do not tell you, answer under-review rather than guessing.

Some patches come with a status somebody already recorded in patchwork,
shown as "recorded". That is usually right, so keep it unless the replies
plainly contradict it. It goes wrong in one particular way: a patch sent to
one subsystem gets picked up by another subsystem's patchwork and marked
not-applicable or rejected there, while the maintainer who owns the code
applies it. If a maintainer says in the thread that they applied it, believe
the maintainer.

Reply with JSON only, an array of objects, one per patch, in the order given:
[{"n": 1, "state": "accepted", "why": "Tejun applied 1-2 to sched_ext"}]

"why" must be under twelve words and must quote or paraphrase the reply, not
your reasoning.""" % "\n".join(
    "- %s: %s" % (k, v) for k, v in VOCABULARY.items())


def is_soft(state, replies) -> bool:
    """Worth asking about: a state the collector guessed from prose, on a
    thread that actually has prose in it."""
    return state in SOFT and any(not r["bot"] for r in replies)


# States that already say the patch got in, so no reply can improve on them.
LANDED = {"merged", "in-next", "in-tree"}

# Phrases that mean a maintainer took the patch, whatever a patchwork
# instance elsewhere may have recorded.  Deliberately loose: this only
# decides whether to spend a question, not what the answer is.
TOOK_IT = re.compile(
    r"\b(applied|applying|queued|pushed|picked up|taken|merged|"
    r"pulled|in my tree|to my tree|for-next|for-\d)\b", re.I)


def worth_checking(state, replies, history=()) -> bool:
    """Whether a recorded patchwork state is worth a second look.

    Patchwork is right nearly all the time, so asking about every patch would
    spend a day's quota re-confirming what is already known.  It is worth a
    question when somebody in the thread sounds like they took the patch, and
    the recorded state says otherwise."""
    if state in LANDED:
        return False
    pool = list(replies or ())
    for h in history or ():
        pool += list(h.get("replies") or []) + list(h.get("cover") or [])
    for r in pool:
        if r.get("bot"):
            continue
        if TOOK_IT.search(" ".join((r.get("body") or "").split())[:2500]):
            return True
    return False


def conversation(thread) -> str:
    """A thread as the model sees it, in order, so it can tell who spoke
    last and what they wanted."""
    msgs = sorted([m for m in thread if m.get("date")],
                  key=lambda m: m["date"])
    lines = []
    for m in msgs[-6:]:
        body = re.sub(r"\n{3,}", "\n\n",
                      "\n".join(l for l in (m.get("body") or "").splitlines()
                                if not l.startswith(">")).strip())[:700]
        who = m.get("name") or m.get("addr") or "somebody"
        if m.get("mine"):
            who += " (the patch author)"
        if m.get("bot"):
            who += " (a bot)"
        tags = ", ".join(t["tag"] for t in m.get("tags") or [])
        lines.append("  %s said%s: %s"
                     % (who, " (%s)" % tags if tags else "",
                        body or "(nothing quotable)"))
    return "\n".join(lines) or "  (nothing was said)"


def reply_fingerprint(subject, thread) -> str:
    """So an unchanged thread is only ever asked about once."""
    h = hashlib.sha256()
    h.update(("reply\x00%s" % subject).encode("utf-8", "replace"))
    for m in sorted([x for x in thread if x.get("date")],
                    key=lambda x: x["date"]):
        h.update(("\x02%s\x03%s\x04%s"
                  % (m.get("addr", ""), m.get("date", ""),
                     (m.get("body") or "")[:400])).encode("utf-8", "replace"))
    return h.hexdigest()[:32]


def fingerprint(subject, replies, history=(), recorded="") -> str:
    """Identifies the evidence, so an unchanged thread is never asked about
    twice, and one that gained a reply, a version or a new patchwork state
    is."""
    h = hashlib.sha256()
    h.update(("%s\x00%s" % (subject, recorded)).encode("utf-8", "replace"))
    for entry in history or ():
        h.update(("\x01v%s" % entry.get("version")).encode())
        for r in entry.get("replies") or []:
            h.update((r["name"] + "\x00" + (r.get("body") or "")[:1500])
                     .encode("utf-8", "replace"))
    if not history:
        for r in replies:
            h.update((r["name"] + "\x00" + (r.get("body") or "")[:1500])
                     .encode("utf-8", "replace"))
    return h.hexdigest()[:24]


def snippet(replies, limit=4) -> str:
    """The human replies, trimmed to what carries the meaning.

    Quoted lines are dropped: a reply that quotes the whole patch tells the
    model nothing and costs a great deal of context.  A quoted line that the
    author is replying *about* is kept when it is short, because "Applied 1-2
    to sched_ext" only makes sense next to the two subjects above it."""
    out = []
    for r in replies[:limit]:
        if r["bot"]:
            continue
        keep = []
        for l in (r.get("body") or "").splitlines():
            if re.match(r"^\s*On .*wrote:\s*$", l):
                continue
            if l.startswith(">"):
                # A short quote is the thing being answered; a long one is
                # the whole patch quoted back.
                if len(l) < 90 and len(keep) < 8:
                    keep.append(l)
                continue
            keep.append(l)
        body = re.sub(r"\n{3,}", "\n\n", "\n".join(keep).strip())[:900]
        tags = ", ".join(t["tag"] for t in r.get("tags", []))
        out.append("  %s said%s: %s"
                   % (r["name"], " (%s)" % tags if tags else "",
                      body or "(nothing quotable)"))
    return "\n".join(out)


def story(case) -> str:
    """One patch as the model sees it: every version, and what each was told."""
    lines = []
    if case.get("recorded"):
        lines.append("  recorded: %s" % case["recorded"])
    hist = case.get("history") or []
    if len(hist) > 1:
        lines.append("  sent %d times:" % len(hist))
    for h in hist:
        mark = "  v%s%s" % (h.get("version"),
                            " (this one)" if h.get("is_this") else "")
        lines.append("%s, %s:" % (mark, (h.get("date") or "")[:10]))
        said = snippet(h.get("replies") or [])
        cover = snippet(h.get("cover") or [])
        if said:
            lines.append(said)
        if cover:
            lines.append("    on the cover letter of this series:")
            lines.append(cover)
        if not said and not cover:
            lines.append("    nothing came back")
    if not hist:
        lines.append(snippet(case.get("replies") or []) or "  nothing came back")
    return "\n".join(lines)


REPLY_SYSTEM = """You read Linux kernel mailing list threads and say whether
the patch author owes a reply.

Kernel lists are read by thousands of people, and an unnecessary reply wastes
all of their attention. Maintainers treat "thanks for applying" and other
acknowledgements as noise. Silence is the correct, polite answer to good
news. Only say a reply is needed when somebody is genuinely blocked without
one.

A reply is NOT needed when:
- a maintainer says they applied, queued, took, picked up, pushed or merged
  the patch, however they phrase it and whatever they call the branch.
  "Applied 1-2 to sched_ext/for-7.4" needs nothing back. Branch names are
  arbitrary and often contain no hint that they are a staging branch.
- somebody sends a Reviewed-by, Acked-by or Tested-by and asks nothing.
- the last message only thanks, congratulates or closes the discussion.
- a bot reports a result and no human asked for anything.
- the patch was rejected with no route forward offered, or was superseded.

A reply IS needed when:
- a reviewer asks a direct question, or asks for a change or a new version.
- somebody disagrees or misunderstands and is waiting for the author.
- a maintainer asks the author to resend, rebase, split or target another
  tree.
- somebody asks the author to confirm, test or explain something.

Answer with JSON only, an array, one object per thread, in the order given:
[{"n": 1, "reply": false, "why": "Tejun applied 1-2 to sched_ext/for-7.4"}]

"why" must be under twelve words and must quote or paraphrase the thread."""


class Classifier:
    """Asks a model about the threads the regular expressions could not read.

    Falls back silently: with no key, or a model that will not answer, every
    patch keeps the state the collector worked out on its own.
    """

    def __init__(self, keys=None, models=None, cache_path=None, log=print,
                 batch=12, limit=200):
        self.keys = keys or {}
        self.models = models or {}
        self.cache_path = cache_path
        self.log = log
        self.batch = batch
        self.limit = limit          # a ceiling on questions per collection
        self.cache = {}
        self.asked = 0
        self.changed = 0
        self.failed = ""
        if cache_path and os.path.exists(cache_path):
            try:
                with open(cache_path) as fh:
                    self.cache = json.load(fh)
            except Exception:
                self.cache = {}

    @property
    def usable(self) -> bool:
        return any(self.keys.values())

    def save(self):
        if not self.cache_path:
            return
        tmp = self.cache_path + ".tmp"
        with open(tmp, "w") as fh:
            json.dump(self.cache, fh)
        os.replace(tmp, self.cache_path)

    def run(self, cases) -> dict:
        """cases: [{"id", "subject", "replies", "state"}] -> {id: (state, why)}

        Only the ones not already answered are sent, in batches."""
        found, pending = {}, []
        for c in cases:
            fp = fingerprint(c["subject"], c["replies"],
                             c.get("history"), c.get("recorded", ""))
            hit = self.cache.get(fp)
            if hit:
                found[c["id"]] = (hit["state"], hit["why"])
            else:
                pending.append((fp, c))

        if not pending or not self.usable:
            return found

        pending = pending[:self.limit]
        misses = 0
        for i in range(0, len(pending), self.batch):
            chunk = pending[i:i + self.batch]
            answers = self._ask(chunk)
            if answers is None:
                # An overloaded service usually recovers within a batch or
                # two.  Two failures in a row means stop bothering it; what
                # already came back is kept, and the next collection picks
                # up where this one left off.
                misses += 1
                if misses >= 2:
                    break
                continue
            misses = 0
            for n, (fp, c) in enumerate(chunk, 1):
                got = answers.get(n)
                if not got:
                    continue
                self.cache[fp] = {"state": got[0], "why": got[1]}
                found[c["id"]] = got
        self.save()
        return found

    def replies_needed(self, threads) -> list:
        """For each thread, True if a reply is owed, False if it would be
        noise, None when there is no answer either way.

        The collector has already decided a reply looks owed; this is the
        second opinion on the ones its regular expressions could not read.
        Anything unanswered stays as the collector had it, so a missing key
        or a model that will not reply leaves the page exactly as before."""
        out = [None] * len(threads)
        pending = []
        for i, t in enumerate(threads):
            fp = reply_fingerprint(t["subject"], t.get("thread") or ())
            hit = self.cache.get(fp)
            if hit and "reply" in hit:
                out[i] = hit["reply"]
            else:
                pending.append((i, fp, t))

        if not pending or not self.usable:
            return out

        pending = pending[:self.limit]
        for i in range(0, len(pending), self.batch):
            chunk = pending[i:i + self.batch]
            answers = self._ask_replies(chunk)
            if answers is None:
                break
            for n, (idx, fp, _) in enumerate(chunk, 1):
                if n in answers:
                    out[idx] = answers[n]
                    self.cache[fp] = {"reply": answers[n]}
        self.save()
        return out

    def _ask_replies(self, chunk):
        lines = []
        for n, (_, _, t) in enumerate(chunk, 1):
            lines.append("[%d] %s (status: %s)\n%s"
                         % (n, t["subject"], t.get("state") or "unknown",
                            conversation(t.get("thread") or ())))
        answer, trail = providers.ask(
            REPLY_SYSTEM, "\n\n".join(lines), self.keys, models=self.models,
            topic="code", timeout=180)
        self.asked += 1
        if not answer.ok:
            self.failed = answer.detail
            self.log("  the model could not read these threads: %s"
                     % answer.detail)
            return None
        return self._parse_replies(answer.text, len(chunk))

    @staticmethod
    def _parse_replies(text, count):
        raw = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M)
        start, end = raw.find("["), raw.rfind("]")
        if start < 0 or end < start:
            return {}
        try:
            blob = json.loads(raw[start:end + 1])
        except Exception:
            return {}
        out = {}
        for item in blob if isinstance(blob, list) else []:
            if not isinstance(item, dict):
                continue
            try:
                n = int(item.get("n"))
            except (TypeError, ValueError):
                continue
            # Only a real boolean counts.  A model that answers "maybe"
            # leaves the collector's own answer standing.
            if 1 <= n <= count and isinstance(item.get("reply"), bool):
                out[n] = item["reply"]
        return out

    def _ask(self, chunk):
        lines = []
        for n, (_, c) in enumerate(chunk, 1):
            lines.append("[%d] %s\n%s" % (n, c["subject"], story(c)))
        answer, trail = providers.ask(
            SYSTEM, "\n\n".join(lines), self.keys, models=self.models,
            topic="code", timeout=180)
        self.asked += 1
        if not answer.ok:
            self.failed = answer.detail
            self.log("  the model could not read these: %s" % answer.detail)
            return None
        return self._parse(answer.text, len(chunk))

    @staticmethod
    def _parse(text, count):
        """Strictly: an unknown state, a stray index or prose around the JSON
        must not turn into a wrong status on a patch."""
        raw = text.strip()
        raw = re.sub(r"^```(?:json)?|```$", "", raw, flags=re.M).strip()
        start, end = raw.find("["), raw.rfind("]")
        if start < 0 or end < start:
            return {}
        try:
            blob = json.loads(raw[start:end + 1])
        except Exception:
            return {}
        out = {}
        for item in blob if isinstance(blob, list) else []:
            if not isinstance(item, dict):
                continue
            try:
                n = int(item.get("n"))
            except (TypeError, ValueError):
                continue
            state = str(item.get("state") or "").strip().lower()
            if not 1 <= n <= count or state not in VOCABULARY:
                continue
            why = " ".join(str(item.get("why") or "").split())[:90]
            out[n] = (state, why or VOCABULARY[state])
        return out
