"""
Host verification of the NTAG 424 SUN algorithm that ntag424_sun.h implements.

Runs every AN12196 / sdm_full vector in the vendored vectors.json (from
Amperstrand/ntag424-vectors) through an independent Python implementation and
asserts byte-exact. The 26 `derive_keys` vectors use a boltcard-specific key
scheme the kolo firmware does not implement, so they are skipped with a count.

This is the check of record: the C++ in ntag424_sun.h mirrors these exact
operations, and ntag424_sun_selftest.h re-runs a subset on-device via mbedTLS.

    pip install cryptography
    python3 verify_ntag424.py
"""

import hashlib
import json
import sys
from pathlib import Path

from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.cmac import CMAC

AES = algorithms.AES
HERE = Path(__file__).parent
EXPECTED_SHA = "522cab963c3f7db1ab9249c0d4e207b43abc0b4061323fd5c55755959a4ff65f"


def cmac(key: bytes, msg: bytes) -> bytes:
    c = CMAC(AES(key))
    c.update(msg)
    return c.finalize()


def ecb_dec(key: bytes, blk: bytes) -> bytes:
    d = Cipher(AES(key), modes.ECB()).decryptor()
    return d.update(blk) + d.finalize()


def sv2(uid: bytes, ctr: bytes) -> bytes:
    return bytes([0x3C, 0xC3, 0x00, 0x01, 0x00, 0x80]) + uid + ctr


def odd(b: bytes) -> bytes:
    return bytes(b[i] for i in range(1, 16, 2))


def h(s: str) -> bytes:
    return bytes.fromhex(s)


def main() -> int:
    raw = (HERE / "vectors.json").read_bytes()
    got_sha = hashlib.sha256(raw).hexdigest()
    if got_sha != EXPECTED_SHA:
        print(f"vectors.json sha256 mismatch: {got_sha} != {EXPECTED_SHA}")
        return 1

    vectors = json.loads(raw)["vectors"]
    ok = bad = skip = 0

    def eq(a, b, where):
        assert a == b, f"{where}: {a} != {b}"

    for v in vectors:
        op = v["input"].get("op")
        i, e = v["input"], v["expected"]
        neg = v.get("negative", False)
        idv = v["id"]
        try:
            if op == "aes_cmac":
                eq(cmac(h(i["key"]), h(i["message"])).hex(), e["cmac"], idv)
            elif op == "picc_decrypt":
                pt = ecb_dec(h(i["key"]), h(i["picc_enc_data"]))
                if "decrypted" in e:
                    eq(pt.hex(), e["decrypted"], idv)
                if "uid" in e:
                    eq(pt[1:8].hex(), e["uid"], idv)
                if "counter_bytes" in e:
                    eq(pt[8:11].hex(), e["counter_bytes"], idv)
            elif op == "sv2_build":
                eq(sv2(h(i["uid"]), h(i["counter_bytes"])).hex(), e["sv2"], idv)
            elif op == "sun_mac":
                ks = cmac(h(i["key"]), sv2(h(i["uid"]), h(i["counter_bytes"])))
                eq(odd(cmac(ks, b"")).hex(), e["cmac_truncated"], idv)
            elif op == "sdm_full":
                pt = ecb_dec(h(i["k1"]), h(i["p"]))
                if "decrypted_p" in e:
                    eq(pt.hex(), e["decrypted_p"], idv)
                uid, ctr = pt[1:8], pt[8:11]
                s = sv2(uid, ctr)
                if "sv2" in e:
                    eq(s.hex(), e["sv2"], idv)
                dk = cmac(h(i["k2"]), s)
                if "derived_mac_key" in e:
                    eq(dk.hex(), e["derived_mac_key"], idv)
                full = cmac(dk, b"")
                if "full_cmac" in e:
                    eq(full.hex(), e["full_cmac"], idv)
                computed_c = odd(full).hex()
                if neg:
                    assert computed_c != i["c"] or pt[0] != 0xC7, f"{idv}: negative should be rejected"
                else:
                    eq(computed_c, i["c"], f"{idv} (truncated cmac vs c)")
                    assert pt[0] == 0xC7, f"{idv}: PICCDataTag != C7"
            else:
                skip += 1
                continue
            ok += 1
        except AssertionError as ex:
            bad += 1
            print("FAIL", op, ex)

    print(f"PASS {ok}  FAIL {bad}  SKIP {skip} (derive_keys, not used by kolo)  total {len(vectors)}")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
