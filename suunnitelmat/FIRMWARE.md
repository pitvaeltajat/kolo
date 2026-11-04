# ESP32 firmware — C3 is the chosen path, fork as reference

> **Update (Nov 2026).** We wrote a **from-scratch ESP-IDF firmware for the
> ESP32-C3 supermini** — [`devices/esp32-c3/`](../devices/esp32-c3/README.md):
> BLE driver + serial CLI + the kolo cloud link, no HomeKit/web UI. Same Yale
> BLE protocol, implemented to the same wire format, with [the fork](#the-fork)
> as the protocol reference. **It passed the go/no-go** (drives the real
> Doorman L3) and has since grown the integration — signed MQTT cmd/ack and
> `/api/state` reporting work end-to-end (`net/`). So the C3 is the controller;
> the fork and ESPHome plans below stay only as references/fallbacks for the
> parts still unbuilt (the NTAG 424 reader). The C3 board is what's on hand; the
> fork's C6/HomeKit/web-UI surface was unrelated weight.

## The fork

The door firmware is **a fork of
[marcusadolfsson/apple-homekey-yale](https://github.com/marcusadolfsson/apple-homekey-yale)**,
not a from-scratch project. That repo is an ESP-IDF (ESP32-C6) firmware that
already implements the hard parts of [PLAN.md](PLAN.md):

- `main/YaleBleLock.*` — a C++ port of `yalexs-ble`: offline-key handshake,
  session key, unlock, GATT cache in NVS (Yale Access BLE, service 0xFE24).
  **Do not hand-write this** — it's the whole reason we fork.
- PN532 over I²C, MQTT, OTA, a web config UI.
- A **split reader where the outdoor part holds no credentials** — the same
  keys-stay-inside split we designed, done over ESP-NOW (`main/RemoteNfcReader.*`,
  `relay-doorbell/`).

## Status: two paths, shared crypto

The repo currently carries **two** firmware routes, and the NTAG 424 work is
written to serve either:

- **In-repo today: ESPHome** (`devices/esp32/kolo-door.yaml`) on the
  `splitice/esphome-yale-smartlock` component for BLE. The signed MQTT
  command/allowlist path, boot self-test, and the NTAG 424 modules are wired
  here.
- **Fallback: the C++ fork** below — switch to it if the ESPHome Yale component
  proves unreliable on the Doorman L3 (its BLE driver is the proven one).

The **NTAG 424 SUN verification + decision** (`devices/esp32/ntag424_sun.h`,
`kolo_door_tags.h`, self-tested, AN12196 byte-exact) is plain C++/mbedTLS with
no ESPHome or fork dependency, so it drops into whichever BLE route wins. Only
the PN532 ISO-DEP read and tag enrol remain, and those are hardware-gated.

## Outdoor ↔ indoor link: wired vs ESP-NOW

Both keep keys + BLE indoors (our goal). Pick one:

- **Wired (plan default):** dumb PN532 outside on a UART run → one ESP32 inside.
  One board, no battery, but a data cable through the wall.
- **ESP-NOW (port's native `RELAY_ESPNOW`):** a second ESP32+PN532 outside that
  holds no keys and talks to the indoor board over the air. No data hole (power
  or battery only), but a second board and a second 2.4 GHz radio sharing air
  with the BLE unlock (the code already pauses relay polling during a BLE
  session — see `g_bleRadioBusy` in `YaleBleLock.hpp`).

Mains is available at the door → **wired** is simpler. ESP-NOW is the drop-in if
drilling for the cable is a problem.

## Our three additions (seams in the fork)

1. **NTAG 424 DNA SUN verification** → `NfcManager::handleGenericTag()`
   (`main/NfcManager.cpp`). Today it only publishes the UID. Replace with:
   decrypt PICC data (AES-128-CBC, meta read key) → derive session MAC key →
   verify SDMMAC (AES-CMAC, truncated) → counter must increase (NVS) → look up
   UID in the allowlist → `LockManager::setTargetState(UNLOCKED, NFC)`.
   **Port the crypto from NXP AN12196 reference vectors, not from memory.**
2. **Vercel-signed MQTT unlock** → the MQTT command topics in
   `MqttManager.cpp` accept lock/unlock **unsigned** today. Add a signed-command
   topic: verify HMAC-SHA256 over `{action,ts,nonce}` with the shared key,
   reject if `|now-ts|>30 s` or nonce seen (small NVS/RAM replay cache), then
   call `setTargetState`. Vercel signs with the identical scheme.
3. **Allowlist cache in NVS** — UID → member id, replaced on each Vercel push;
   tags keep working offline with the last list.

## Sequencing — where we are

The BLE protocol is generic Yale Access and was **unverified on the Doorman L3**
(the fork targets a Yale **nexTouch**, US mortise), so nothing was built on top
of it until a driver was proven. That gate is now cleared. Order (matches
PLAN.md phases):

1. ✅ **Phase 1 — offline key.** Fetched via
   [`devices/yale/fetch_offline_key.py`](../devices/yale/fetch_offline_key.py).
2. ✅ **Phase 2 — C3 spike proves lock/unlock on the L3** from the indoor spot.
   Go/no-go passed. (100-cycle soak + latency/battery still to run.)
3. ✅ **Phase 3 — integration** on the C3: additions #2 (signed MQTT unlock) and
   the ack/state reporting are live and verified end-to-end (`net/`).
   Addition #1 (NTAG 424) and #3 (allowlist push) remain — phase 4, hardware-gated;
   the SUN crypto is already written and host-tested (`devices/esp32/`).

## Build

**C3 spike (active):** ESP-IDF v5.4, target `esp32c3`. See
[`devices/esp32-c3/README.md`](../devices/esp32-c3/README.md) for build, flash,
and the console commands.

**Fork (fallback):** ESP-IDF v5.5.5, ESP32-C6.
`idf.py set-target esp32c6 && idf.py build`. The repo's `CLAUDE.md` is the real
documentation (wire protocol, gotchas, what's unfinished).
