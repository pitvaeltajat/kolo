// kolo door firmware — ESP32-C3 supermini + Yale Doorman L3 over BLE.
//
// Phase-1 spike: BLE driver + serial CLI to prove the lock can be driven
// from the indoor spot (FIRMWARE.md phase 2 go/no-go). No WiFi/MQTT yet.

#include <cstring>

#include "cli.h"
#include "esp_log.h"
#include "nvs_config.h"
#include "nvs_flash.h"
#include "yale/YaleBleLock.hpp"

static const char* TAG = "kolo";

extern "C" void app_main(void) {
  ESP_LOGI(TAG, "kolo door firmware (ESP32-C3) starting");

  nvs_config::init();

  const auto creds = nvs_config::loadCreds();
  YaleBleLock lock(creds);
  lock.begin();

  cli::init(&lock);

  ESP_LOGI(TAG, "ready — console on USB-Serial-JTAG");
}