#pragma once
// HMAC-SHA256 envelope sign/verify for the kolo door controller, for use from
// ESPHome lambdas. Uses mbedTLS (bundled with ESP-IDF / Arduino-ESP32) — do NOT
// hand-roll SHA on the ESP32, unlike the Shelly where no crypto lib is exposed.
//
// Envelope: {"device":..,"payload":"<json>","sig":"<hex>"}, sig = HMAC(key,payload).
// See devices/README.md for the full contract.

#include <string>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include "mbedtls/md.h"
#include "esp_random.h"

namespace kolo {

inline std::string hmac_sha256_hex(const std::string &key, const std::string &msg) {
  uint8_t out[32];
  const mbedtls_md_info_t *info = mbedtls_md_info_from_type(MBEDTLS_MD_SHA256);
  mbedtls_md_hmac(info, reinterpret_cast<const uint8_t *>(key.data()), key.size(),
                  reinterpret_cast<const uint8_t *>(msg.data()), msg.size(), out);
  static const char *H = "0123456789abcdef";
  std::string hex(64, '0');
  for (int i = 0; i < 32; i++) {
    hex[i * 2] = H[out[i] >> 4];
    hex[i * 2 + 1] = H[out[i] & 0xf];
  }
  return hex;
}

// Constant-time hex compare.
inline bool sig_equal(const std::string &a, const std::string &b) {
  if (a.size() != b.size()) return false;
  uint8_t diff = 0;
  for (size_t i = 0; i < a.size(); i++) diff |= (uint8_t) a[i] ^ (uint8_t) b[i];
  return diff == 0;
}

inline std::string random_nonce() {
  static const char *H = "0123456789abcdef";
  std::string s(32, '0');
  for (int i = 0; i < 16; i++) {
    uint8_t b = (uint8_t) esp_random();
    s[i * 2] = H[b >> 4];
    s[i * 2 + 1] = H[b & 0xf];
  }
  return s;
}

// Minimal JSON string-quoter for embedding payload (which is itself JSON text).
inline std::string json_quote(const std::string &s) {
  std::string out = "\"";
  for (char c : s) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else out += c;
  }
  out += "\"";
  return out;
}

// Wrap a payload (already a JSON string that includes ts+nonce) in an envelope.
inline std::string envelope(const std::string &key, const std::string &device, const std::string &payload) {
  std::string sig = hmac_sha256_hex(key, payload);
  return std::string("{\"device\":\"") + device + "\",\"payload\":" + json_quote(payload) +
         ",\"sig\":\"" + sig + "\"}";
}

}  // namespace kolo
