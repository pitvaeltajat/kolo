"""
Host check of the DoorTags decision logic in kolo_door_tags.h — the parts the
crypto vectors don't cover: counter-replay rejection, allowlist membership, and
per-UID key derivation. Mirrors decide() in Python and runs the same scenarios
as ntag424_sun_selftest.h section 4. Crypto primitives themselves are verified
byte-exact by verify_ntag424.py.

    pip install cryptography
    python3 decision_logic_test.py
"""

import sys

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.cmac import CMAC

AES = algorithms.AES


def cmac(key, msg):
    c = CMAC(AES(key))
    c.update(msg)
    return c.finalize()


def ecb_enc(key, blk):
    e = Cipher(AES(key), modes.ECB()).encryptor()
    return e.update(blk) + e.finalize()


def ecb_dec(key, blk):
    d = Cipher(AES(key), modes.ECB()).decryptor()
    return d.update(blk) + d.finalize()


def sv2(uid, ctr):
    return bytes([0x3C, 0xC3, 0x00, 0x01, 0x00, 0x80]) + uid + ctr


def odd(b):
    return bytes(b[i] for i in range(1, 16, 2))


def derive_key(master, uid):
    return cmac(master, uid)


def sun_mac(mac_key, uid, ctr):
    ks = cmac(mac_key, sv2(uid, ctr))
    return odd(cmac(ks, b""))


def make_tap(meta, master, uid, counter):
    ctr = bytes([counter & 0xFF, (counter >> 8) & 0xFF, (counter >> 16) & 0xFF])
    pt = bytes([0xC7]) + uid + ctr + b"\x00" * 5
    picc_enc = ecb_enc(meta, pt)
    mac = sun_mac(derive_key(master, uid), uid, ctr)
    return picc_enc, mac


class DoorTags:
    def __init__(self, meta, master):
        self.meta, self.master = meta, master
        self.allow = {}   # uid -> member
        self.last = {}    # uid -> counter

    def set_allowlist(self, entries):
        self.allow = dict(entries)

    def decide(self, picc_enc, mac):
        pt = ecb_dec(self.meta, picc_enc)
        if pt[0] != 0xC7:
            return (False, None, "bad_picc")
        uid, ctr = pt[1:8], pt[8:11]
        if sun_mac(derive_key(self.master, uid), uid, ctr) != mac:
            return (False, None, "bad_mac")
        counter = ctr[0] | (ctr[1] << 8) | (ctr[2] << 16)
        if uid in self.last and counter <= self.last[uid]:
            return (False, None, "replay")
        self.last[uid] = counter
        if uid not in self.allow:
            return (False, None, "not_allowed")
        return (True, self.allow[uid], "ok")


def main():
    meta = bytes(range(0x11, 0x11 + 16))
    master = bytes.fromhex("deadbeef0123456789abcdeffedcba98")
    uid_a = bytes.fromhex("04010203040580")
    uid_b = bytes.fromhex("04aabbccddee80")

    d = DoorTags(meta, master)
    d.set_allowlist([(uid_a, "alice")])
    fails = []

    pe, mc = make_tap(meta, master, uid_a, 0)
    if d.decide(pe, mc) != (True, "alice", "ok"):
        fails.append("counter0 should unlock alice")
    if d.decide(pe, mc)[0]:
        fails.append("replay of counter0 should be rejected")

    pe, mc = make_tap(meta, master, uid_a, 1)
    if not d.decide(pe, mc)[0]:
        fails.append("counter1 should unlock")

    pe, mc = make_tap(meta, master, uid_b, 0)
    if d.decide(pe, mc) != (False, None, "not_allowed"):
        fails.append("uid_b valid tag but not on allowlist")

    pe, mc = make_tap(meta, master, uid_a, 2)
    mc = bytes([mc[0] ^ 1]) + mc[1:]
    if d.decide(pe, mc)[2] != "bad_mac":
        fails.append("forged MAC should be bad_mac")

    # A counter lower than the last seen (stale capture) is a replay.
    pe, mc = make_tap(meta, master, uid_a, 1)
    if d.decide(pe, mc)[2] != "replay":
        fails.append("stale lower counter should be replay")

    if fails:
        for f in fails:
            print("FAIL:", f)
        return 1
    print("PASS 6 decision scenarios")
    return 0


if __name__ == "__main__":
    sys.exit(main())
