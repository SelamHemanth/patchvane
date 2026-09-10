#!/usr/bin/env python3
"""Can this machine read the archives Patchvane collects from?

A collection that cannot reach lore finishes anyway and writes a dashboard
of zeros, so when the page says it read nothing, the question is whether
the network refused or the address really has posted nothing.  This asks
the same hosts the same way the collector does, with the same library and
the same User-Agent, and says what came back.

    python3 netcheck.py                     the address in config.json
    python3 netcheck.py you@example.com     somebody else's
"""

import json
import os
import re
import socket
import ssl
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def config() -> dict:
    try:
        with open(os.path.join(HERE, "config.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def probe(what: str, url: str, ua: str) -> tuple:
    """Fetch one URL the way collect.py would.  Returns (ok, note, body)."""
    req = urllib.request.Request(url, headers={"User-Agent": ua})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            body = r.read()
        return True, "HTTP %d, %d bytes" % (r.status, len(body)), body
    except urllib.error.HTTPError as exc:
        hint = {
            403: "refused. A proxy or a filter is answering instead of the "
                 "archive, or the archive is rate limiting this address.",
            407: "the proxy wants credentials.",
            502: "a gateway in the way could not reach it.",
        }.get(exc.code, "")
        return False, "HTTP %d %s%s" % (exc.code, exc.reason,
                                        " -- " + hint if hint else ""), b""
    except urllib.error.URLError as exc:
        why = exc.reason
        if isinstance(why, ssl.SSLError):
            return False, ("TLS failed: %s. A proxy that opens TLS needs its "
                           "certificate trusted by Python, not just by the "
                           "browser." % why), b""
        if isinstance(why, socket.gaierror):
            return False, "cannot resolve the name: %s" % why, b""
        return False, "did not connect: %s" % why, b""
    except Exception as exc:
        return False, "%s: %s" % (type(exc).__name__, exc), b""


def main() -> int:
    cfg = config()
    who = (sys.argv[1] if len(sys.argv) > 1
           else os.environ.get("PATCHVANE_OWNER") or cfg.get("email") or "")
    if not who:
        print("Which address? pass one: python3 netcheck.py you@example.com")
        return 2

    ua = "%s (%s)" % (cfg.get("user_agent", "patchvane/2.0"), who)
    lore = (cfg.get("lore") or {}).get("base", "https://lore.kernel.org")
    korg = (cfg.get("korg") or {}).get("base", "https://git.kernel.org")

    proxies = {k: v for k, v in os.environ.items()
               if k.lower() in ("http_proxy", "https_proxy", "no_proxy")}
    print("address : %s" % who)
    print("proxy   : %s" % (", ".join("%s=%s" % kv for kv in proxies.items())
                            if proxies else "none set"))
    print()

    checks = [
        ("lore search", "%s/all/?q=%s&x=A&o=0"
         % (lore, urllib.parse.quote("f:%s" % who))),
        ("lore itself", "%s/all/" % lore),
        ("git.kernel.org", "%s/pub/scm/linux/kernel/git/torvalds/linux.git/"
         % korg),
    ]

    results = {}
    for name, url in checks:
        ok, note, body = probe(name, url, ua)
        results[name] = (ok, body)
        print("%-15s %-4s %s" % (name, "ok" if ok else "FAIL", note))

    print()
    ok, body = results.get("lore search", (False, b""))
    if not ok:
        print("The collector cannot read your patches from here, and a run")
        print("will write a dashboard of zeros. Fix the reach to lore first.")
        return 1

    found = len(re.findall(rb"<entry>", body))
    print("messages on the first page: %d" % found)
    if found:
        print("The archive can be read and it has your posts, so a collection")
        print("should fill the dashboard. If it does not, keep the output of:")
        print("  python3 collect.py --for %s --out /tmp/pv --no-ai" % who)
        return 0
    print("The archive answered, but has nothing posted from this address.")
    print("Check it is the address you send patches from; the one in From:,")
    print("not the one on the account. This is what lore was asked:")
    print("  %s" % checks[0][1])
    return 1


if __name__ == "__main__":
    sys.exit(main())
