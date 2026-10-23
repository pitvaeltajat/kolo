# ESP32 firmware — C3 spike first, fork as fallback

> **Update (Oct 2026).** For the phase-2 go/no-go spike we're writing a
> **from-scratch ESP-IDF firmware for the ESP32-C3 supermini** instead —
> [`devices/esp32-c3/`](../devices/esp32-c3/README.md): BLE driver + serial
> CLI, no HomeKit/web UI. Same Yale BLE protocol, implemented to the same wire
> format, with [the fork](#the-fork) as the protocol reference. The C3 board is
> what's on hand; the fork's C6/HomeKit/web-UI surface is unrelated weight for
> proving the Doorman L3. If the C3 driver passes the go/no-go, grow it into
> the full controller; otherwise fall back to this fork plan. The fork below
> remains the reference for the production feature set (Home Key, split
> reader, MQTT, web UI).

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

## Sequencing — why no integration code is written yet

The BLE protocol is generic Yale Access, but it is **unverified on the Doorman
L3** (the fork targets a Yale **nexTouch**, US mortise). Writing the three
additions before confirming a BLE driver drives the L3 is building on sand.
Order (matches PLAN.md phases):

1. **Phase 1 — offline key.** Dedicated Yale owner account → fetch key/slot/MAC
   ([`devices/yale/fetch_offline_key.py`](../devices/yale/fetch_offline_key.py)).
2. **Phase 2 — flash the C3 spike, prove lock/unlock on the L3** from the
   indoor spot, 100 cycles, latency, battery. Go/no-go.
3. Only then: write additions #1–#3 above — on the C3 firmware if it passed,
   on the fork if not.

## Build

**C3 spike (active):** ESP-IDF v5.4, target `esp32c3`. See
[`devices/esp32-c3/README.md`](../devices/esp32-c3/README.md) for build, flash,
and the console commands.

**Fork (fallback):** ESP-IDF v5.5.5, ESP32-C6.
`idf.py set-target esp32c6 && idf.py build`. The repo's `CLAUDE.md` is the real
documentation (wire protocol, gotchas, what's unfinished).
