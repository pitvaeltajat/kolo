#include "yale/yale_crypto.h"

#include <cstdint>

namespace yale {

// CRC-32 (IEEE 802.3, reflected, poly 0xEDB88320) — the same table-driven
// implementation the reference firmware uses for the secure-channel 32-bit
// checksum at frame offset 0x0C.
uint32_t crc32(const uint8_t* data, size_t len) {
  static uint32_t table[256];
  static bool init = false;
  if (!init) {
    for (uint32_t i = 0; i < 256; ++i) {
      uint32_t c = i;
      for (int k = 0; k < 8; ++k)
        c = (c & 1) ? (0xEDB88320u ^ (c >> 1)) : (c >> 1);
      table[i] = c;
    }
    init = true;
  }
  uint32_t crc = 0xFFFFFFFFu;
  for (size_t i = 0; i < len; ++i)
    crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >> 8);
  return crc ^ 0xFFFFFFFFu;
}

}  // namespace yale