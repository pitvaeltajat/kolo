#pragma once
// Persistent configuration for the kolo door firmware: Yale credentials and
// the BLE GATT cache. Credentials come from Kconfig defaults and can be
// overridden at runtime via the serial console; both persist in NVS.
//
// The offline key is a secret: it is never logged and `info` masks it.

#include <array>
#include <cstdint>
#include <string>

namespace nvs_config {

// Yale lock credentials.
struct YaleCreds {
  std::array<uint8_t, 6> mac{};  // canonical order, as printed (MSB first)
  bool macValid = false;
  uint8_t slot = 0;
  std::array<uint8_t, 16> key{};  // offline key
  bool keyValid = false;
};

// Cached BLE discovery results (the lock's GATT table is static).
struct GattCache {
  bool valid = false;
  uint8_t addrType = 0;
  uint16_t svcStart = 0;
  uint16_t svcEnd = 0;
  uint16_t hWrite = 0;     // …611 command write
  uint16_t hRead = 0;      // …612 command notify
  uint16_t hSecWrite = 0;  // …613 secure write
  uint16_t hSecRead = 0;   // …614 secure notify
  uint16_t hReadCccd = 0;
  uint16_t hSecReadCccd = 0;
  uint8_t readProps = 0;
  uint8_t secReadProps = 0;
};

// Init the NVS subsystem (call once at boot).
void init();

// Load credentials; falls back to Kconfig defaults when NVS is empty.
YaleCreds loadCreds();

// Persist credentials (all three at once).
void saveCreds(const YaleCreds& c);

// Load the GATT cache (valid=false if absent).
GattCache loadGattCache();

// Persist the GATT cache.
void saveGattCache(const GattCache& c);

// Clear the GATT cache (e.g. on a "forget" command).
void clearGattCache();

// Parse helpers shared by the CLI and the config loader.
bool parseMac(const std::string& s, std::array<uint8_t, 6>& out);
bool parseHex(const std::string& s, uint8_t* out, size_t len);

}  // namespace nvs_config