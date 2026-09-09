"""Per-person secrets, encrypted where they sit.

One server collects for everybody who signs in, so one person's API keys must
never be readable as another's, and a copy of the disk must not be a list of
everybody's keys.  Each person gets a sealed vault in their own directory.

The standard library has no AES, and this project takes no dependencies, so
the construction here is built from what hashlib and hmac give:

  encrypt  a keystream of HMAC-SHA256(k_enc, nonce || counter) blocks,
           XORed into the plaintext, which is AES-CTR's shape with a
           different pseudo-random function
  then MAC HMAC-SHA256(k_mac, header || nonce || ciphertext) appended, and
           checked before anything is decrypted, so a tampered vault is
           rejected rather than parsed

Encrypt-then-MAC in that order is the arrangement that is safe to build by
hand; the reverse is where hand-rolled crypto usually goes wrong.

The two subkeys come from the server's own secret, which is already high
entropy, so the derivation is a single HMAC rather than a slow password KDF.
A per-vault salt means two people with the same key never produce the same
ciphertext, and a fresh nonce per write means one person's own two writes
never do either.

What this protects: a stolen disk, a stray backup, a misdirected file read,
and one signed-in person reaching another's keys through the app.  What it
cannot protect: the running server, which has to decrypt the keys to use
them.  Nothing that keeps a usable key on a machine can claim otherwise.
"""

import base64
import hashlib
import hmac
import json
import os

MAGIC = b"PV1"
SALT = 16
NONCE = 16
TAG = 32


def _subkeys(master: bytes, salt: bytes) -> tuple:
    """One key to encrypt with, a different one to authenticate with.

    Separate, because reusing a single key for both is the other classic way
    a construction like this goes wrong."""
    seed = hmac.new(master, b"patchvane-vault-v1" + salt, hashlib.sha256)
    root = seed.digest()
    return (hmac.new(root, b"enc", hashlib.sha256).digest(),
            hmac.new(root, b"mac", hashlib.sha256).digest())


def _stream(key: bytes, nonce: bytes, want: int) -> bytes:
    out = bytearray()
    counter = 0
    while len(out) < want:
        out += hmac.new(key, nonce + counter.to_bytes(8, "big"),
                        hashlib.sha256).digest()
        counter += 1
    return bytes(out[:want])


def seal(master: str, plain: bytes) -> str:
    """Encrypt, authenticate, and return something safe to write to a file."""
    if not master:
        raise ValueError("no secret to encrypt with")
    key = master.encode() if isinstance(master, str) else master
    salt = os.urandom(SALT)
    nonce = os.urandom(NONCE)
    k_enc, k_mac = _subkeys(key, salt)
    stream = _stream(k_enc, nonce, len(plain))
    cipher = bytes(a ^ b for a, b in zip(plain, stream))
    tag = hmac.new(k_mac, MAGIC + salt + nonce + cipher, hashlib.sha256).digest()
    return base64.b64encode(MAGIC + salt + nonce + cipher + tag).decode()


def unseal(master: str, blob: str):
    """The plaintext, or None if this was not sealed by us or was altered."""
    if not master or not blob:
        return None
    key = master.encode() if isinstance(master, str) else master
    try:
        raw = base64.b64decode(blob)
    except Exception:
        return None
    if len(raw) < len(MAGIC) + SALT + NONCE + TAG or not raw.startswith(MAGIC):
        return None
    at = len(MAGIC)
    salt, nonce = raw[at:at + SALT], raw[at + SALT:at + SALT + NONCE]
    body = raw[at + SALT + NONCE:-TAG]
    tag = raw[-TAG:]
    k_enc, k_mac = _subkeys(key, salt)
    want = hmac.new(k_mac, MAGIC + salt + nonce + body, hashlib.sha256).digest()
    # Constant time: a comparison that returns early leaks where it stopped.
    if not hmac.compare_digest(want, tag):
        return None
    return bytes(a ^ b for a, b in zip(body, _stream(k_enc, nonce, len(body))))


# ------------------------------------------------------------ the vault file


def read(path: str, master: str) -> dict:
    """One person's secrets.  An unreadable vault reads as empty rather than
    raising, because a server that will not start is worse than a settings
    page that has forgotten a key."""
    try:
        with open(path, encoding="utf-8") as fh:
            blob = fh.read()
    except OSError:
        return {}
    plain = unseal(master, blob.strip())
    if plain is None:
        return {}
    try:
        out = json.loads(plain.decode("utf-8"))
        return out if isinstance(out, dict) else {}
    except Exception:
        return {}


def write(path: str, master: str, data: dict) -> bool:
    """Replace a vault, readable only by the account running this."""
    try:
        sealed = seal(master, json.dumps(data).encode("utf-8"))
    except ValueError:
        return False
    tmp = path + ".tmp"
    try:
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as fh:
            fh.write(sealed)
        os.chmod(tmp, 0o600)
        # Swapped into place, so an interrupted write cannot leave somebody
        # with half a vault and no keys.
        os.replace(tmp, path)
        return True
    except OSError:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        return False
