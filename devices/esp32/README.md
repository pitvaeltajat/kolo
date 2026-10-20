# Door controller (ESP32-C6) — build notes

Implements the door side of the kolo contract (devices/README.md). This is the
hardware-dependent part and follows PLAN.md's phase order — it is **prep**, not
a finished flashable image, because the Yale BLE driver and the NTAG 424 reader
can only be validated against the real lock and tags.

## Files

- `kolo-door.yaml` — ESPHome config. MQTT in/out, HMAC verify of commands,
  signed acks, unlock/lock via a community Yale component, signed state report.
- `kolo_crypto.h` — HMAC-SHA256 envelope sign/verify (mbedTLS) for the lambdas.

## Phase order (PLAN.md)

1. **Offline key.** Dedicated Yale owner account → `../yale/fetch_offline_key.py`
   → put the key/slot/mac in `secrets.yaml`.
2. **BLE spike.** Flash the community Yale component alone, 100 lock/unlock
   cycles with the Connect bridge plugged in, measure latency/failures, check
   the lock battery after a week. Go/no-go for ESP32-only.
3. **kolo wiring.** Add the MQTT + HMAC blocks from `kolo-door.yaml`; pilot
   unlock/lock/ack/state from the web app with leaders for ~2 weeks.
4. **Reader.** Add PN532 + NTAG 424 DNA SUN verification + enrol + allowlist
   cache in NVS. This is a **custom component** (ISO-DEP + AES-128 + AES-CMAC,
   mbedTLS has both) and is not in `kolo-door.yaml` yet.

## secrets.yaml (keep out of git)

```yaml
wifi_ssid: "..."
wifi_password: "..."
ota_password: "..."
mqtt_broker: "mqtts://your-broker:8883"
mqtt_username: "..."
mqtt_password: "..."
kolo_hmac_key: "..."          # same value as kolo's DEVICE_HMAC_KEY
yale_mac: "xx:xx:xx:xx:xx:xx" # from fetch_offline_key.py
yale_offline_key: "..."       # ditto
yale_key_slot: 1              # ditto
```

## Integration points to pin (the `TODO`s)

- **Yale component:** `external_components` points at `splitice/esphome-yale-smartlock`;
  pin a commit and match the `lock:` platform/key field names to its README
  (the alternative, `marcusadolfsson/apple-homekey-yale`, is a C++/PN532 design
  if you want Apple Home Key tap-to-unlock too).
- **state POST:** add the ESPHome `http_request` component and replace the
  `ESP_LOGD` placeholder in the 60 s interval with a real POST to
  `${kolo_url}/api/state` carrying the signed envelope.
- **lock state enum:** `lock::LOCK_STATE_LOCKED` is the ESPHome name; confirm
  against the component you pin.

## Security (PLAN.md "Physical attack")

The box is reachable outdoors, so before rollout: enable **flash encryption +
secure boot** (the HMAC key and offline key live in flash), add a **tamper
switch** → alert via kolo, and keep 2–3 PIN fallback codes on the lock. If a
board is stolen: remove its Yale slot, re-fetch a new offline key, rotate
`DEVICE_HMAC_KEY`.
