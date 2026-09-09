"""What leaves the process, and in what shape.

collect.py keeps the truth on disk.  Nothing reaches a browser, an export or a
model prompt without passing through here first, so redaction cannot be
forgotten at a call site.

The dashboard is single tenant: the person reading it is the person who sent
the patches.  Redaction is not about keeping secrets from them, it is about
limiting what a misconfigured host, a screenshot or a stray export can spill.
Every reviewer address in here belongs to somebody else, and republishing four
hundred of them in one machine readable file is how address books get scraped.
"""

from __future__ import annotations

import copy
import re

ADDR_RE = re.compile(r"[\w.+-]+@[\w.-]+\.\w{2,}")

EXCERPT_CAP = 400


def mask_addr(addr: str) -> str:
    """k.kozlowski@linaro.org becomes k***@linaro.org: enough to tell two
    reviewers at the same company apart, not enough to mail either of them."""
    if not addr or "@" not in addr:
        return addr
    local, _, domain = addr.partition("@")
    keep = local[:1] if local else ""
    return "%s***@%s" % (keep, domain)


def scrub_text(text: str) -> str:
    """Addresses quoted inside a message body, which is where they hide."""
    return ADDR_RE.sub(lambda m: mask_addr(m.group(0)), text or "")


class Policy:
    """Which of the above actually runs.  Local runs keep everything; a
    deployment reachable from the internet does not."""

    def __init__(self, mask_addresses=False, include_notes=True,
                 scrub_excerpts=False, own_email=""):
        self.mask_addresses = mask_addresses
        self.include_notes = include_notes
        self.scrub_excerpts = scrub_excerpts
        self.own_email = (own_email or "").lower()

    @classmethod
    def wide_open(cls, own_email=""):
        return cls(own_email=own_email)

    def describe(self) -> list:
        on = []
        if self.mask_addresses:
            on.append("reviewer addresses masked")
        if not self.include_notes:
            on.append("private notes withheld")
        if self.scrub_excerpts:
            on.append("message excerpts withheld")
        return on or ["nothing withheld"]

    # ------------------------------------------------------------------

    def _addr(self, addr: str) -> str:
        """The owner's own address stays readable; it is already on lore under
        every patch they sent, and they need to recognise their own name."""
        if not self.mask_addresses or not addr:
            return addr
        if addr.lower() == self.own_email:
            return addr
        return mask_addr(addr)

    def _excerpt(self, text: str) -> str:
        if self.scrub_excerpts:
            return ""
        text = (text or "")[:EXCERPT_CAP]
        return scrub_text(text) if self.mask_addresses else text

    def apply(self, data: dict) -> dict:
        """A redacted deep copy.  The original is left alone so the caller can
        keep using the full record."""
        if not (self.mask_addresses or self.scrub_excerpts
                or not self.include_notes):
            return data

        d = copy.deepcopy(data)

        for person in d.get("people", []):
            person["addr"] = self._addr(person.get("addr", ""))
        for row in d.get("tagrows", []):
            row["addr"] = self._addr(row.get("addr", ""))
            row["who"] = scrub_text(row.get("who", "")) if self.mask_addresses \
                else row.get("who", "")
        for thread in d.get("threads", []):
            thread["excerpt"] = self._excerpt(thread.get("excerpt", ""))
            for reply in thread.get("replies") or []:
                reply["text"] = self._excerpt(reply.get("text", ""))
                if self.mask_addresses:
                    reply["who"] = scrub_text(reply.get("who", ""))
        for item in d.get("activity", []):
            item["text"] = scrub_text(item.get("text", "")) \
                if self.mask_addresses else item.get("text", "")
        for patch in d.get("patches", []):
            patch["state_detail"] = scrub_text(patch.get("state_detail", "")) \
                if self.mask_addresses else patch.get("state_detail", "")
            for tag in patch.get("tags", []):
                tag["addr"] = self._addr(tag.get("addr", ""))

        if not self.include_notes:
            d["notes"] = []
            d["notes_withheld"] = len(data.get("notes", []))

        d["privacy"] = self.describe()
        return d
