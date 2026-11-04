#pragma once
// Cloud link for the kolo door controller: WiFi + SNTP + MQTT(TLS) + signed
// command/ack + signed state reports to the kolo app.
//
// Contract (devices/README.md, mirrored from the ESPHome reference in
// devices/esp32/kolo-door.yaml):
//   - envelope {"device","payload":"<json>","sig":"<hmac-hex>"},
//     sig = HMAC_SHA256(DEVICE_HMAC_KEY, payload-bytes);
//   - kolo → door  MQTT kolo/door/cmd   {action:"unlock"|"lock", ts, nonce}
//   - door → kolo  MQTT kolo/door/ack   {reply:<cmd nonce>, result, ts, nonce}
//   - door → kolo  HTTPS POST /api/state {kind:"DOOR", locked, doorOpen, battery}
// Commands are accepted only within ±30 s (SNTP clock) and with an unseen
// nonce; the ack is published once the BLE worker reports the result.

#include "yale/YaleBleLock.hpp"

namespace net {

// Bring up WiFi/MQTT and wire commands to `lock`. Reads config from
// nvs_config::loadNet(); a no-op (logged) if WiFi/MQTT/HMAC are unconfigured.
// Non-blocking: all work happens on the system event loop and a small task.
void start(YaleBleLock* lock);

// One-line status for the CLI `net` command (wifi / ip / mqtt / time).
void printStatus();

}  // namespace net
