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
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))


def trust_store() -> list:
    """Where this interpreter looks for the authorities it trusts."""
    out = []
    p = ssl.get_default_verify_paths()
    for label, path in (("file", p.cafile), ("dir", p.capath)):
        if not path:
            out.append("%-5s not set" % label)
            continue
        out.append("%-5s %s%s" % (label, path,
                                  "" if os.path.exists(path) else "  MISSING"))
    try:
        loaded = len(ssl.create_default_context().get_ca_certs())
    except Exception:
        loaded = -1
    out.append("%-5s %s authorities loaded" % ("", loaded if loaded >= 0
                                               else "could not count"))
    return out


def presented_by(host: str, port: int = 443) -> str:
    """Who issued the certificate this host is presenting?

    Read without verifying, on purpose: the whole question is what is in
    the way, and a name taken from an untrusted certificate is reported
    and never trusted.  A middlebox that opens TLS names itself here.
    """
    try:
        ctx = ssl._create_unverified_context()
        with socket.create_connection((host, port), timeout=15) as raw:
            with ctx.wrap_socket(raw, server_hostname=host) as tls:
                der = tls.getpeercert(binary_form=True)
    except Exception as exc:
        return "could not read the certificate: %s" % exc
    if not der:
        return "no certificate offered"
    try:
        pem = ssl.DER_cert_to_PEM_cert(der)
        p = subprocess.run(["openssl", "x509", "-noout", "-issuer"],
                           input=pem, capture_output=True, text=True,
                           timeout=15)
        line = (p.stdout or "").strip()
        return line[7:].strip() if line.startswith("issuer=") else (
            line or "openssl said nothing")
    except FileNotFoundError:
        return "install openssl to see who issued it"
    except Exception as exc:
        return "could not read the issuer: %s" % exc


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

    results, tls_trouble = {}, False
    for name, url in checks:
        ok, note, body = probe(name, url, ua)
        results[name] = (ok, body)
        if not ok and "TLS failed" in note:
            tls_trouble = True
        print("%-15s %-4s %s" % (name, "ok" if ok else "FAIL", note))

    if tls_trouble:
        host = urllib.parse.urlsplit(lore).hostname or "lore.kernel.org"
        print("\nTLS could not be verified, so here is what is in the way.")
        print("\nthe certificate %s presents is issued by:" % host)
        print("  %s" % presented_by(host))
        print("\nthe authorities this python trusts:")
        for line in trust_store():
            print("  %s" % line)
        print("""
If that issuer is your employer or a security appliance rather than a
public authority, this network opens TLS and re-signs it, and the
interpreter has not been told to trust the certificate doing that. The
browser works because it was told separately. Two ways to fix it:

  * put that certificate in the system store, which fixes everything on
    the machine at once:

      sudo cp your-ca.crt /usr/local/share/ca-certificates/
      sudo update-ca-certificates

  * or point this at a bundle without touching the system, by adding it
    to .env, which run.sh reads:

      export SSL_CERT_FILE=/path/to/your-ca.pem

If instead the issuer is a normal public authority, the store itself is
the problem, and on Debian or Ubuntu this rebuilds it:

      sudo apt install --reinstall ca-certificates

Never turn verification off to get past this. It would leave every
password and API key this reads open to whatever is in the way.""")

    print()
    ok, body = results.get("lore search", (False, b""))
    if not ok:
        print("The collector cannot read your patches from here, and a run")
        print("will write a dashboard of zeros. Fix the reach to lore first.")
        print("Once it is fixed, clear the refusals it remembered:")
        print("  rm -rf cache/")
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
