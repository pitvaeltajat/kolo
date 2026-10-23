#include "nvs_config.h"

#include <cctype>
#include <cstdio>
#include <cstring>

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "sdkconfig.h"

static const char* TAG = "nvs";

namespace nvs_config {

namespace {
constexpr const char* NS_CREDS = "yale";
constexpr const char* NS_GATT = "yaleble";
constexpr const char* KEY_MAC = "mac";
constexpr const char* KEY_SLOT = "slot";
constexpr const char* KEY_KEY = "key";
constexpr const char* KEY_GATT = "gatt";
}  // namespace

void init() {
  esp_err_t err = nvs_flash_init();
  if (err == ESP_ERR_NVS_NO_FREE_PAGES ||
      err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
    ESP_ERROR_CHECK(nvs_flash_erase());
    err = nvs_flash_init();
  }
  ESP_ERROR_CHECK(err);
}

bool parseMac(const std::string& s, std::array<uint8_t, 6>& out) {
  unsigned int b[6];
  if (std::sscanf(s.c_str(), "%2x:%2x:%2x:%2x:%2x:%2x", &b[0], &b[1], &b[2],
                  &b[3], &b[4], &b[5]) != 6) {
    return false;
  }
  for (int i = 0; i < 6; ++i) out[i] = static_cast<uint8_t>(b[i]);
  return true;
}

bool parseHex(const std::string& s, uint8_t* out, size_t len) {
  if (s.size() != len * 2) return false;
  for (size_t i = 0; i < len; ++i) {
    auto hex = [](char c) -> int {
      if (c >= '0' && c <= '9') return c - '0';
      if (c >= 'a' && c <= 'f') return c - 'a' + 10;
      if (c >= 'A' && c <= 'F') return c - 'A' + 10;
      return -1;
    };
    const int hi = hex(s[i * 2]);
    const int lo = hex(s[i * 2 + 1]);
    if (hi < 0 || lo < 0) return false;
    out[i] = static_cast<uint8_t>((hi << 4) | lo);
  }
  return true;
}

YaleCreds loadCreds() {
  YaleCreds c;

  // Kconfig defaults first.
  const char* mac = CONFIG_YALE_MAC;
  if (mac && mac[0]) c.macValid = parseMac(mac, c.mac);
  const char* key = CONFIG_YALE_OFFLINE_KEY;
  if (key && key[0]) c.keyValid = parseHex(key, c.key.data(), c.key.size());
  c.slot = CONFIG_YALE_SLOT;

  // NVS overrides.
  nvs_handle_t h;
  if (nvs_open(NS_CREDS, NVS_READONLY, &h) == ESP_OK) {
    uint8_t mac[6];
    size_t macLen = sizeof(mac);
    if (nvs_get_blob(h, KEY_MAC, mac, &macLen) == ESP_OK) {
      std::memcpy(c.mac.data(), mac, sizeof(mac));
      c.macValid = true;
    }
    uint8_t key[16];
    size_t keyLen = sizeof(key);
    if (nvs_get_blob(h, KEY_KEY, key, &keyLen) == ESP_OK) {
      std::memcpy(c.key.data(), key, sizeof(key));
      c.keyValid = true;
    }
    uint8_t slot = 0;
    if (nvs_get_u8(h, KEY_SLOT, &slot) == ESP_OK) c.slot = slot;
    nvs_close(h);
  }

  if (!c.macValid)
    ESP_LOGW(TAG, "no lock MAC configured — use setmac or Kconfig YALE_MAC");
  if (!c.keyValid)
    ESP_LOGW(
        TAG,
        "no offline key configured — use setkey or Kconfig YALE_OFFLINE_KEY");
  return c;
}

void saveCreds(const YaleCreds& c) {
  nvs_handle_t h;
  if (nvs_open(NS_CREDS, NVS_READWRITE, &h) != ESP_OK) {
    ESP_LOGE(TAG, "nvs_open(creds) failed");
    return;
  }
  nvs_set_blob(h, KEY_MAC, c.mac.data(), c.mac.size());
  nvs_set_blob(h, KEY_KEY, c.key.data(), c.key.size());
  nvs_set_u8(h, KEY_SLOT, c.slot);
  nvs_commit(h);
  nvs_close(h);
  ESP_LOGI(TAG, "credentials saved");
}

GattCache loadGattCache() {
  GattCache c;
  nvs_handle_t h;
  if (nvs_open(NS_GATT, NVS_READONLY, &h) == ESP_OK) {
    size_t len = sizeof(c);
    if (nvs_get_blob(h, KEY_GATT, &c, &len) == ESP_OK) {
      // Sanity: a valid cache must have all handles set.
      if (c.svcStart == 0 || c.hWrite == 0 || c.hSecWrite == 0) c.valid = false;
    }
    nvs_close(h);
  }
  return c;
}

void saveGattCache(const GattCache& c) {
  nvs_handle_t h;
  if (nvs_open(NS_GATT, NVS_READWRITE, &h) != ESP_OK) {
    ESP_LOGE(TAG, "nvs_open(gatt) failed");
    return;
  }
  nvs_set_blob(h, KEY_GATT, &c, sizeof(c));
  nvs_commit(h);
  nvs_close(h);
}

void clearGattCache() {
  nvs_handle_t h;
  if (nvs_open(NS_GATT, NVS_READWRITE, &h) != ESP_OK) return;
  nvs_erase_key(h, KEY_GATT);
  nvs_commit(h);
  nvs_close(h);
}

}  // namespace nvs_config