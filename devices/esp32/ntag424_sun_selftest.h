#pragma once
// On-device self-test for ntag424_sun.h. Runs a few AN12196 / sdm_full vectors
// (from Amperstrand/ntag424-vectors) through the real mbedTLS path and asserts
// byte-exact. Call ntag424_sun_selftest() once at boot; it returns true on
// success. The full host check over all vectors is in test/verify_ntag424.py.

#include <cstdint>
#include <cstring>
#include <vector>
#include <utility>
#include "ntag424_sun.h"
#include "kolo_door_tags.h"
#ifdef ESP_PLATFORM
#include "esp_log.h"
#endif

namespace kolo {

// AES-128 ECB encrypt — only used here to synthesise a tag's PICCData for the
// DoorTags test (the reader never encrypts PICC in production).
inline void selftest_ecb_enc(const uint8_t key[16], const uint8_t in[16], uint8_t out[16]) {
  mbedtls_aes_context a;
  mbedtls_aes_init(&a);
  mbedtls_aes_setkey_enc(&a, key, 128);
  mbedtls_aes_crypt_ecb(&a, MBEDTLS_AES_ENCRYPT, in, out);
  mbedtls_aes_free(&a);
}

// Build a valid tap (picc_enc + mac) for a synthetic tag, as the tag hardware
// would, so DoorTags::decide can be exercised with known keys.
inline void selftest_make_tap(const uint8_t meta[16], const uint8_t master[16],
                              const uint8_t uid[7], uint32_t counter,
                              uint8_t picc_enc[16], uint8_t mac[8]) {
  uint8_t pt[16] = {0};
  pt[0] = 0xC7;
  memcpy(pt + 1, uid, 7);
  pt[8] = counter & 0xff;
  pt[9] = (counter >> 8) & 0xff;
  pt[10] = (counter >> 16) & 0xff;
  selftest_ecb_enc(meta, pt, picc_enc);
  uint8_t mac_key[16];
  ntag424_derive_key(master, uid, mac_key);
  const uint8_t ctr[3] = {pt[8], pt[9], pt[10]};
  ntag424_sun_mac(mac_key, uid, ctr, mac);
}

inline bool ntag424_sun_selftest() {
  bool pass = true;

  // 1) sun_mac — AN12196 Table 4 (zero mac key).
  {
    const uint8_t mac_key[16] = {0};
    const uint8_t uid[7] = {0x04, 0xde, 0x5f, 0x1e, 0xac, 0xc0, 0x40};
    const uint8_t ctr[3] = {0x3d, 0x00, 0x00};
    const uint8_t want[8] = {0x94, 0xee, 0xd9, 0xee, 0x65, 0x33, 0x70, 0x86};
    uint8_t got[8];
    ntag424_sun_mac(mac_key, uid, ctr, got);
    if (memcmp(got, want, 8) != 0) pass = false;
  }

  // 2) picc_decrypt — AN12196 Table 2 (zero meta key).
  {
    const uint8_t meta[16] = {0};
    const uint8_t enc[16] = {0xef, 0x96, 0x3f, 0xf7, 0x82, 0x86, 0x58, 0xa5,
                             0x99, 0xf3, 0x04, 0x15, 0x10, 0x67, 0x1e, 0x88};
    const uint8_t want_uid[7] = {0x04, 0xde, 0x5f, 0x1e, 0xac, 0xc0, 0x40};
    const uint8_t want_ctr[3] = {0x3d, 0x00, 0x00};
    uint8_t uid[7], ctr[3];
    if (!ntag424_decrypt_picc(meta, enc, uid, ctr) ||
        memcmp(uid, want_uid, 7) != 0 || memcmp(ctr, want_ctr, 3) != 0)
      pass = false;
  }

  // 3) full verify, positive + replay/forgery negatives — sdm_full counter0.
  {
    const uint8_t meta[16] = {0x55, 0xda, 0x17, 0x4c, 0x96, 0x08, 0x99, 0x3d,
                              0xc2, 0x7b, 0xb3, 0xf3, 0x0a, 0x4a, 0x73, 0x14};
    const uint8_t mac_key[16] = {0x2a, 0xb7, 0x4a, 0xbc, 0x12, 0x73, 0xfb, 0x43,
                                 0xca, 0xe9, 0x75, 0x53, 0xa3, 0x6d, 0x4d, 0x08};
    const uint8_t enc[16] = {0xe6, 0x1c, 0xb0, 0x56, 0xf5, 0x2d, 0x34, 0xf9,
                             0x36, 0x8f, 0x07, 0x9d, 0x18, 0x14, 0xd2, 0xcf};
    const uint8_t mac[8] = {0xfc, 0xc9, 0xa2, 0x22, 0x01, 0xea, 0x22, 0x98};
    const uint8_t want_uid[7] = {0x04, 0x25, 0x60, 0x7a, 0x8f, 0x69, 0x80};

    SunTap r = ntag424_verify(meta, mac_key, enc, mac);
    if (!r.ok || r.counter != 0 || memcmp(r.uid, want_uid, 7) != 0) pass = false;

    uint8_t bad[8];
    memcpy(bad, mac, 8);
    bad[7] ^= 0x01;  // forged MAC must be rejected
    if (ntag424_verify(meta, mac_key, enc, bad).ok) pass = false;
  }

  // 4) DoorTags decision: allowlist + replay + per-UID key derivation.
  {
    const uint8_t meta[16] = {0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88,
                              0x99, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff, 0x00};
    const uint8_t master[16] = {0xde, 0xad, 0xbe, 0xef, 0x01, 0x23, 0x45, 0x67,
                                0x89, 0xab, 0xcd, 0xef, 0xfe, 0xdc, 0xba, 0x98};
    const uint8_t uid_a[7] = {0x04, 0x01, 0x02, 0x03, 0x04, 0x05, 0x80};
    const uint8_t uid_b[7] = {0x04, 0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0x80};

    DoorTags d(meta, master);
    std::vector<std::pair<Uid, std::string>> list;
    list.push_back({to_uid(uid_a), "alice"});
    d.set_allowlist(list);

    uint8_t pe[16], mc[8];

    selftest_make_tap(meta, master, uid_a, 0, pe, mc);
    auto r0 = d.decide(pe, mc);
    if (!r0.unlock || r0.member != "alice") pass = false;

    // Replaying the exact same tap (counter 0) must now be rejected.
    if (d.decide(pe, mc).unlock) pass = false;

    // A fresh tap with a higher counter is accepted.
    selftest_make_tap(meta, master, uid_a, 1, pe, mc);
    if (!d.decide(pe, mc).unlock) pass = false;

    // One of our tags, valid MAC, but not on the allowlist → no unlock.
    selftest_make_tap(meta, master, uid_b, 0, pe, mc);
    auto rb = d.decide(pe, mc);
    if (rb.unlock || strcmp(rb.reason, "not_allowed") != 0) pass = false;

    // Forged MAC → rejected as bad_mac.
    selftest_make_tap(meta, master, uid_a, 2, pe, mc);
    mc[0] ^= 0x01;
    if (d.decide(pe, mc).unlock) pass = false;
  }

#ifdef ESP_PLATFORM
  ESP_LOGI("kolo", "ntag424 self-test: %s", pass ? "PASS" : "FAIL");
#endif
  return pass;
}

}  // namespace kolo
