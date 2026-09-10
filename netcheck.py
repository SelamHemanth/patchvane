#!/usr/bin/env python3
"""Can this machine read the archives Patchvane collects from?

A collection that cannot reach lore finishes anyway and writes a dashboard
of zeros, so when the page says it read nothing, the question is whether
the network refused or the address really has posted nothing.  This asks
the same hosts the same way the collector does, with the same library and
the same User-Agent, and says what came back.

    python3 netcheck.py                     the address in config.json
    python3 netcheck.py you@example.com     somebody else's

When a network opens TLS and signs it again itself, the certificate doing
that is sitting on the connection, and writing it into the system store is
the whole fix.  This saves it:

    python3 netcheck.py --save-ca           into ./network-ca/
    python3 netcheck.py --save-ca /tmp/ca   somewhere else
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


def chain_of(host: str, port: int = 443) -> list:
    """Every certificate this host sends, leaf first, unverified.

    Unverified because the point is to look at a chain that will not
    verify.  Nothing here is trusted by reading it; the certificates are
    written to a file and it takes root to install them.
    """
    try:
        p = subprocess.run(
            ["openssl", "s_client", "-showcerts", "-servername", host,
             "-connect", "%s:%d" % (host, port)],
            input="", capture_output=True, text=True, timeout=30)
    except FileNotFoundError:
        return []
    except Exception:
        return []
    return re.findall(r"-----BEGIN CERTIFICATE-----.*?"
                      r"-----END CERTIFICATE-----", p.stdout or "", re.S)


def describe(pem: str) -> dict:
    """Subject, issuer, and whether this certificate may sign others."""
    def ask(*args) -> str:
        try:
            p = subprocess.run(["openssl", "x509", "-noout"] + list(args),
                               input=pem, capture_output=True, text=True,
                               timeout=15)
            return (p.stdout or "").strip()
        except Exception:
            return ""

    subject = ask("-subject")
    issuer = ask("-issuer")
    for head in ("subject=", "issuer="):
        subject = subject[len(head):].strip() if subject.startswith(head) \
            else subject
        issuer = issuer[len(head):].strip() if issuer.startswith(head) \
            else issuer
    return {"pem": pem, "subject": subject, "issuer": issuer,
            "ca": "CA:TRUE" in ask("-text"), "root": subject == issuer}


def save_ca(host: str, where: str) -> int:
    """Write the signing certificates from host's chain for installing."""
    chain = chain_of(host)
    if not chain:
        print("Could not read the chain %s presents. Is openssl installed,"
              % host)
        print("and can this machine open a connection to it at all?")
        return 1

    certs = [describe(pem) for pem in chain]
    signers = [c for c in certs if c["ca"]]
    if not signers:
        print("%s sent %d certificate(s) and none of them signs others,"
              % (host, len(certs)))
        print("so there is nothing here to install. The trouble is elsewhere.")
        return 1

    os.makedirs(where, exist_ok=True)
    for n, cert in enumerate(signers, 1):
        path = os.path.join(where, "network-ca-%d.crt" % n)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(cert["pem"].strip() + "\n")
        print("%s\n    %s%s" % (path, cert["subject"],
                                "  (signs itself)" if cert["root"] else ""))

    print("""
Read those names. Installing one tells this machine to believe anything it
signs, so it has to be an authority you mean to trust: your employer, or
whoever runs this network. If a name there is not one you recognise, stop
and ask, because trusting the wrong one is worse than not reading lore.

If you do recognise it, this installs them for every program on the
machine, Python included:

    sudo cp %s/network-ca-*.crt /usr/local/share/ca-certificates/
    sudo update-ca-certificates

Then forget the refusals already remembered and look again:

    rm -rf cache/ && python3 netcheck.py""" % where)
    return 0


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
    args = sys.argv[1:]

    lore_base = (cfg.get("lore") or {}).get("base", "https://lore.kernel.org")
    if "--save-ca" in args:
        at = args.index("--save-ca")
        rest = args[at + 1:]
        where = (rest[0] if rest and not rest[0].startswith("-")
                 and "@" not in rest[0] else os.path.join(HERE, "network-ca"))
        host = urllib.parse.urlsplit(lore_base).hostname or "lore.kernel.org"
        return save_ca(host, where)

    who = (args[0] if args
           else os.environ.get("PATCHVANE_OWNER") or cfg.get("email") or "")
    if not who:
        print("Which address? pass one: python3 netcheck.py you@example.com")
        return 2

    ua = "%s (%s)" % (cfg.get("user_agent", "patchvane/2.0"), who)
    lore = lore_base
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
public authority, this network opens TLS and signs it again itself, and
the interpreter has not been told to trust the certificate doing that.
The browser works because it was told separately, usually by whoever set
the machine up.

The certificate is on the connection, so you do not have to go and find
it. This writes it out and prints how to install it:

      python3 netcheck.py --save-ca

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
