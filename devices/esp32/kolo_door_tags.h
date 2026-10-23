#pragma once
// Tag-tap decision for the kolo door: verify an NTAG 424 SUN tap, reject
// replays (counter must strictly increase per UID), and look the UID up in the
// allowlist pushed from kolo. Pure logic over ntag424_sun.h — no hardware, no
// network — so it is unit-testable (see doortags_selftest()).
//
// Keys (both 16 bytes, from secrets.yaml, live in encrypted flash):
//   meta_key    — shared SDMMetaRead key; decrypts every tag's PICCData.
//   master_mac  — per-tag MAC keys are derived from this + UID; the enrol path
//                 programs each tag with ntag424_derive_key(master_mac, uid).

#include <array>
#include <map>
#include <string>
#include <utility>
#include <vector>
#include "ntag424_sun.h"

namespace kolo {

using Uid = std::array<uint8_t, 7>;

inline Uid to_uid(const uint8_t u[7]) {
  Uid a;
  memcpy(a.data(), u, 7);
  return a;
}

// Parse exactly n bytes from 2n lowercase/uppercase hex chars. Returns false on
// any non-hex char. Used for keys from secrets and UIDs from the allowlist.
inline bool hex_to_bytes(const char *h, uint8_t *out, size_t n) {
  auto nib = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    c |= 0x20;
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
  };
  for (size_t i = 0; i < n; i++) {
    int hi = nib(h[2 * i]), lo = nib(h[2 * i + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = (uint8_t) ((hi << 4) | lo);
  }
  return true;
}

class DoorTags {
 public:
  DoorTags(const uint8_t meta_key[16], const uint8_t master_mac[16]) {
    memcpy(meta_, meta_key, 16);
    memcpy(master_, master_mac, 16);
  }

  // Replace the whole allowlist (on each signed kolo/door/allowlist push).
  void set_allowlist(std::vector<std::pair<Uid, std::string>> entries) {
    allow_ = std::move(entries);
  }

  struct Decision {
    bool unlock;
    std::string member;  // who, when unlock
    const char *reason;  // "ok" | "bad_picc" | "bad_mac" | "replay" | "not_allowed"
  };

  // picc_enc[16] + mac[8] come from the tag's SDM, read by the PN532.
  Decision decide(const uint8_t picc_enc[16], const uint8_t mac[8]) {
    uint8_t uidb[7], ctr[3];
    if (!ntag424_decrypt_picc(meta_, picc_enc, uidb, ctr))
      return {false, "", "bad_picc"};

    uint8_t mac_key[16];
    ntag424_derive_key(master_, uidb, mac_key);
    SunTap t = ntag424_verify(meta_, mac_key, picc_enc, mac);
    if (!t.ok) return {false, "", "bad_mac"};  // not one of our tags, or forged

    Uid uid = to_uid(uidb);
    auto it = last_.find(uid);
    if (it != last_.end() && t.counter <= it->second)
      return {false, "", "replay"};
    // Valid, fresh tap from one of our tags: advance the counter even if the
    // member was removed, so a captured tap can never be replayed later.
    last_[uid] = t.counter;

    const std::string *m = lookup(uid);
    if (!m) return {false, "", "not_allowed"};
    return {true, *m, "ok"};
  }

  const std::string *lookup(const Uid &uid) const {
    for (const auto &e : allow_)
      if (e.first == uid) return &e.second;
    return nullptr;
  }

 private:
  // ponytail: last-seen counters are RAM-only; persist to NVS so a replay
  // cannot succeed once after a reboot. Fine pre-rollout; wire NVS before the
  // box goes on the wall.
  uint8_t meta_[16], master_[16];
  std::vector<std::pair<Uid, std::string>> allow_;
  std::map<Uid, uint32_t> last_;
};

}  // namespace kolo
