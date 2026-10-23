#pragma once
// NTAG 424 DNA "SUN" (Secure Dynamic Message / SDM) verification for the kolo
// door controller. A tap gives the reader PICCData (encrypted UID+counter) and
// an 8-byte truncated CMAC; this verifies both and returns the UID + counter.
//
// Algorithm is NXP AN12196 §3.4, byte-exact against the public test vectors in
// Amperstrand/ntag424-vectors (an12196 + sdm_full categories). The matching
// host verification + the vendored vectors live in test/ — see that dir before
// touching anything here. Uses mbedTLS (AES + CMAC), bundled with ESP-IDF; do
// NOT hand-roll the crypto.
//
//   PICCData = AES-decrypt(meta_key, picc_enc)              [single block, ECB]
//            = PICCDataTag(1) || UID(7) || SDMReadCtr(3) || pad(5)
//   gate: PICCDataTag == 0xC7
//   SV2  = 3C C3 00 01 00 80 || UID(7) || SDMReadCtr(3)
//   Ks   = CMAC(mac_key, SV2)
//   MACt = odd-index bytes (1,3,..,15) of CMAC(Ks, <empty>)
//   accept iff MACt == the tag's 8-byte CMAC, and counter strictly increases.
//
// Per-tag MAC keys: meta_key is shared across all kolo tags (it must be, since
// it decrypts the UID that diversification would key on). mac_key is per-UID,
// derived with ntag424_derive_key(master_mac, uid) once the UID is known. The
// enrol path MUST program each tag with the identical derivation.

#include <cstdint>
#include <cstring>
#include "mbedtls/aes.h"
#include "mbedtls/cipher.h"
#include "mbedtls/cmac.h"

namespace kolo {

// AES-128 single-block ECB decrypt (== AN12196's CBC-decrypt with zero IV for
// one block).
inline void aes128_ecb_dec(const uint8_t key[16], const uint8_t in[16], uint8_t out[16]) {
  mbedtls_aes_context a;
  mbedtls_aes_init(&a);
  mbedtls_aes_setkey_dec(&a, key, 128);
  mbedtls_aes_crypt_ecb(&a, MBEDTLS_AES_DECRYPT, in, out);
  mbedtls_aes_free(&a);
}

// AES-128-CMAC (RFC 4493). msg may be empty (len == 0).
inline void aes128_cmac(const uint8_t key[16], const uint8_t *msg, size_t len, uint8_t out[16]) {
  static const uint8_t empty = 0;  // valid non-null pointer for the len==0 case
  const mbedtls_cipher_info_t *ci = mbedtls_cipher_info_from_type(MBEDTLS_CIPHER_AES_128_ECB);
  mbedtls_cipher_cmac(ci, key, 128, msg ? msg : &empty, len, out);
}

// CMAC(master, UID) — per-tag key diversification. The enrol path must mirror
// this exactly. (If you ever want domain separation, prepend a fixed label and
// change both sides together.)
inline void ntag424_derive_key(const uint8_t master[16], const uint8_t uid[7], uint8_t out[16]) {
  aes128_cmac(master, uid, 7, out);
}

inline void ntag424_sv2(const uint8_t uid[7], const uint8_t ctr[3], uint8_t sv2[16]) {
  static const uint8_t hdr[6] = {0x3C, 0xC3, 0x00, 0x01, 0x00, 0x80};
  memcpy(sv2, hdr, 6);
  memcpy(sv2 + 6, uid, 7);
  memcpy(sv2 + 13, ctr, 3);
}

// Compute the 8-byte truncated SDMMAC for a given mac_key/UID/counter.
inline void ntag424_sun_mac(const uint8_t mac_key[16], const uint8_t uid[7],
                            const uint8_t ctr[3], uint8_t mact[8]) {
  uint8_t sv2[16], ks[16], full[16];
  ntag424_sv2(uid, ctr, sv2);
  aes128_cmac(mac_key, sv2, 16, ks);     // Ks
  aes128_cmac(ks, nullptr, 0, full);     // CMAC(Ks, empty)
  for (int i = 0; i < 8; i++) mact[i] = full[i * 2 + 1];  // odd-index bytes
}

struct SunTap {
  bool ok;          // decrypt gate + MAC both passed
  uint8_t uid[7];
  uint32_t counter; // SDMReadCtr as little-endian uint (ctr[0] | ctr[1]<<8 | ctr[2]<<16)
};

// Decrypt PICCData and recover UID + 3 counter bytes. Returns true only if the
// PICCDataTag is 0xC7 (UID+counter mirrored). Does NOT check the MAC.
inline bool ntag424_decrypt_picc(const uint8_t meta_key[16], const uint8_t picc_enc[16],
                                 uint8_t uid[7], uint8_t ctr[3]) {
  uint8_t pt[16];
  aes128_ecb_dec(meta_key, picc_enc, pt);
  if (pt[0] != 0xC7) return false;
  memcpy(uid, pt + 1, 7);
  memcpy(ctr, pt + 8, 3);
  return true;
}

// Constant-time 8-byte compare.
inline bool ct_equal8(const uint8_t a[8], const uint8_t b[8]) {
  uint8_t d = 0;
  for (int i = 0; i < 8; i++) d |= a[i] ^ b[i];
  return d == 0;
}

// Full verify: decrypt PICC (with the shared meta_key), check the 8-byte MAC
// (with this tag's mac_key). The caller still MUST reject a counter that is not
// strictly greater than the last one it stored for this UID (replay).
inline SunTap ntag424_verify(const uint8_t meta_key[16], const uint8_t mac_key[16],
                             const uint8_t picc_enc[16], const uint8_t mac[8]) {
  SunTap r;
  r.ok = false;
  r.counter = 0;
  uint8_t ctr[3];
  if (!ntag424_decrypt_picc(meta_key, picc_enc, r.uid, ctr)) return r;
  uint8_t mact[8];
  ntag424_sun_mac(mac_key, r.uid, ctr, mact);
  if (!ct_equal8(mact, mac)) return r;
  r.counter = (uint32_t) ctr[0] | ((uint32_t) ctr[1] << 8) | ((uint32_t) ctr[2] << 16);
  r.ok = true;
  return r;
}

}  // namespace kolo
