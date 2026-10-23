# Door controller (ESP32-C6, ESPHome alternative) — build notes

> **Status (Oct 2026).** The active phase-2 spike is the native ESP-IDF
> firmware in [`../esp32-c3/`](../esp32-c3/README.md) — a from-scratch Yale
> BLE driver + serial CLI on the ESP32-C3 supermini. This ESPHome directory
> stays as the alternative integration path: it was written before the C3
> spike existed, is **prep** (not validated on hardware), and needs the
> community Yale component pinned to a commit before it can build.

Implements the door side of the kolo contract (devices/README.md). This is the
hardware-dependent part and follows PLAN.md's phase order — it is **prep**, not
a finished flashable image, because the Yale BLE driver and the NTAG 424 reader
can only be validated against the real lock and tags.

## Files

- `kolo-door.yaml` — ESPHome config. MQTT in/out, HMAC verify of commands,
  signed acks, unlock/lock via a community Yale component, signed allowlist
  push, boot self-test, signed state report.
- `kolo_crypto.h` — HMAC-SHA256 envelope sign/verify (mbedTLS) for the lambdas.
- `ntag424_sun.h` — **NTAG 424 DNA SUN verification** (NXP AN12196: AES-decrypt
  PICCData → UID+counter, AES-CMAC MAC check). Byte-exact against the public
  AN12196 vectors; mbedTLS. This is the custom crypto phase 4 needed.
- `kolo_door_tags.h` — tag decision: per-UID MAC-key derivation, counter-replay
  rejection, allowlist membership. `DoorTags::decide(picc_enc, mac)`.
- `ntag424_sun_selftest.h` — on-device self-test (AN12196 vectors + the full
  decision path) run from `on_boot`.
- `test/` — host verification. `verify_ntag424.py` runs the vendored
  `vectors.json` (sha-locked, see `LOCK`) through an independent impl;
  `decision_logic_test.py` checks the replay/allowlist logic. Both need
  `pip install cryptography`. Run them when touching the crypto.

## Phase order (PLAN.md)

1. **Offline key.** Dedicated Yale owner account → `../yale/fetch_offline_key.py`
   → put the key/slot/mac in `secrets.yaml`.
2. **BLE spike.** Flash the community Yale component alone, 100 lock/unlock
   cycles with the Connect bridge plugged in, measure latency/failures, check
   the lock battery after a week. Go/no-go for ESP32-only.
3. **kolo wiring.** Add the MQTT + HMAC blocks from `kolo-door.yaml`; pilot
   unlock/lock/ack/state from the web app with leaders for ~2 weeks.
4. **Reader.** SUN verification, per-UID key derivation, counter-replay and the
   allowlist are **written and self-tested** (`ntag424_sun.h`,
   `kolo_door_tags.h`, host tests in `test/`). What remains is hardware-only:
   - the **PN532 ISO-DEP read** of the tag's SDM (picc_enc + mac) — a small
     custom component, since stock ESPHome `pn532` doesn't expose those APDUs;
     it feeds `id(door_tags)->decide(...)` (see the tag-reader block in the yaml);
   - **enrol** — writing a blank tag's keys + SDM config (mirror
     `ntag424_derive_key`);
   - persist per-UID counters (and the allowlist) to **NVS** so a replay can't
     succeed once after a reboot (marked `ponytail:` in `kolo_door_tags.h`).

## secrets.yaml (keep out of git)

```yaml
wifi_ssid: "..."
wifi_password: "..."
ota_password: "..."
mqtt_broker: "mqtts://your-broker:8883"
mqtt_username: "..."
mqtt_password: "..."
kolo_hmac_key: "..."          # same value as kolo's DEVICE_HMAC_KEY
yale_mac: "xx:xx:xx:xx:xx:xx" # from fetch_offline_key.py (also in Vercel YALE_LOCK_MAC)
yale_offline_key: "..."       # ditto (Vercel YALE_OFFLINE_KEY)
yale_key_slot: 2              # ditto (Vercel YALE_KEY_SLOT)
yale_meta_key: "<32 hex>"     # kolo-generated random SDMMetaRead key, shared by all tags
tag_master_mac: "<32 hex>"    # kolo-generated random master; per-tag MAC key = CMAC(this, UID)
```

`yale_meta_key` and `tag_master_mac` are **our** NFC-tag keys (generate once,
e.g. `openssl rand -hex 16` each), not the Yale lock key. The enrol path writes
each tag with the matching keys. Keep them here and, when the enrol/allowlist
service needs them, in kolo's env — never in git.

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
