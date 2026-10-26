# kolo door firmware — ESP32-C3 supermini + Yale Doorman L3 over BLE

Phase-1 spike: an ESP-IDF (NimBLE) firmware for the **ESP32-C3 supermini** that
drives the Yale lock directly over BLE using its **offline key + slot + MAC** —
no Yale cloud, no hub. This phase is the go/no-go from
[`suunnitelmat/FIRMWARE.md`](../../suunnitelmat/FIRMWARE.md): prove the lock can
be driven from the indoor spot before any kolo integration (MQTT, signed
commands, state reporting) is written.

The BLE protocol is a from-scratch C++ port for ESP-IDF/NimBLE, using
[`marcusadolfsson/apple-homekey-yale`](https://github.com/marcusadolfsson/apple-homekey-yale)
(MIT) as the **protocol reference** — its `main/YaleBleLock.*` is a C++ port of
`yalexs-ble` and its `CLAUDE.md` §5 documents the wire protocol. We do not copy
that code; we implement the same protocol against the C3.

> **Why not the fork?** The fork targets the ESP32-C6 (XIAO) and is tied to its
> app-event system, HomeKit and a web UI. The C3 supermini is a different board
> (single-core RISC-V, no PSRAM, USB-Serial-JTAG console). This project keeps
> only what phase 1 needs: BLE central + serial CLI.

## Hardware

- **ESP32-C3 supermini**: single-core RISC-V @ 160 MHz, 4 MB flash, ~320 KB
  usable SRAM, BLE 5.0, native USB (USB-Serial-JTAG) console, onboard LED on
  GPIO8, boot button on GPIO9.
- **Yale Doorman L3** (`Etuovi`): speaks the generic Yale/August Access BLE
  protocol (service `0xFE24`). Unverified on the L3 — that is exactly what this
  phase proves.

## Credentials

The lock's **offline key, slot and MAC** come from
[`devices/yale/fetch_offline_key.py`](../yale/fetch_offline_key.py) (run once
against the Yale cloud with a dedicated owner account). They are **not** in this
repository. Provision them at build time via Kconfig defaults or at runtime via
the serial console (`setkey` / `setmac` / `setslot`); they persist in NVS.

## Build & flash

```bash
. ~/esp/esp-idf/export.sh          # ESP-IDF v5.4
idf.py set-target esp32c3
idf.py menuconfig                  # set YALE_MAC / YALE_SLOT / YALE_OFFLINE_KEY
idf.py build
idf.py -p /dev/ttyACM0 flash monitor
```

The console is the USB-Serial-JTAG port (`/dev/ttyACM0` on Linux). Commands:

| Command                                                          | What                                            |
| ---------------------------------------------------------------- | ----------------------------------------------- |
| `scan`                                                           | read lock/door/battery (scans for the lock if the direct connect fails) |
| `status`                                                         | read lock/door/battery state                    |
| `unlock` / `lock`                                                | drive the lock                                  |
| `setkey <32-hex>` / `setmac <aa:bb:cc:dd:ee:ff>` / `setslot <n>` | provision credentials (persist in NVS)          |
| `info`                                                           | show configured MAC/slot (key masked)           |
| `forget`                                                         | clear the cached GATT handles (forces re-discovery) |

## Host unit tests

The protocol crypto (frames, checksums, CBC chain, ECB round-trip) is pure
logic and compiles for the host. The test build compiles the mbedTLS bundled
with ESP-IDF (v3) from source — the system `libmbedcrypto` is v2 with a
different ABI (the `mbedtls_aes_crypt_cbc` iv pointer const-ness changed):

```bash
cmake -S test -B test/build-test
cmake --build test/build-test
./test/build-test/test_crypto          # "all tests passed"
```

## Layout

```
main/
  CMakeLists.txt
  Kconfig.projbuild      # YALE_* config + timing knobs
  main.cpp               # app_main: NVS, config, CLI, YaleBleLock
  nvs_config.*           # credentials + GATT cache in NVS
  cli.*                  # serial console
  yale/
    YaleBleLock.*        # BLE driver: worker task, NimBLE callbacks, connect/discover/handshake/commands
    yale_crypto.*        # AES-128-ECB/CBC, 18-byte frames, checksums (host-testable)
test/
  test_crypto.cpp        # host-side unit tests for yale_crypto
  CMakeLists.txt         # host test build (builds mbedTLS from ESP-IDF source)
```

## Status (Oct 2026)

**Implemented — code complete, builds clean, host tests pass:**
- **A — skeleton**: builds, boots, console on USB-Serial-JTAG.
- **B — config + CLI**: credentials in NVS, console commands.
- **C — BLE connect/discover**: NimBLE central, service `0xFE24`, GATT cache in NVS.
- **D — secure + command channels**: handshake, unlock/lock/status.
- **E — state tracking**: lock/door/battery from commands + reads.
- **F — host verification**: `idf.py build` clean (~316 KB image, ~69 KB DRAM);
  crypto/frame unit tests pass.

**Pending — hardware go/no-go** (FIRMWARE.md phase 2):
- Flash the C3 supermini, provision the offline key/slot/MAC from
  [`fetch_offline_key.py`](../yale/fetch_offline_key.py), run the 100-cycle
  soak, measure latency/battery, confirm out-of-range fails cleanly. The GATT
  cache must survive a reboot (second connect skips discovery).

## Troubleshooting: "connect failed: status=9"

`status=9` is `BLE_ERR_CONN_LIMIT` (and `status=13` is
`BLE_ERR_CONN_REJ_RESOURCES`): the lock is a **single-connection device** and
is already connected to something else. The Yale Connect bridge, the Yale Home
app, and Apple Home all hold its one slot, and the lock drops idle links only
after **~30 s**.

To free the slot:

1. Unplug the Yale Connect bridge (and any other Yale hub).
2. Close the Yale Home app and Apple Home / HomeKit on every phone/tablet.
3. Wait **30–60 s** for the lock to drop the stale link.
4. Run `status` again.

The firmware already retries (`YALE_CONNECT_ATTEMPTS`, default 5) with a
generous backoff (`YALE_CONNECT_RETRY_BACKOFF_MS`, default 4000 ms) so it can
catch a slot as it frees up, but it cannot force the lock to drop a live
connection. If the lock stays busy after everything is disconnected, pull the
lock's battery for a few seconds to reset its radio.

## Security notes

- The offline key is never logged; `info` masks it.
- Flash encryption is **not** enabled in this phase — the key lives in plain
  NVS. Enable it before any deployment (PLAN.md).
- The serial console is unauthenticated (USB only). Fine for a bench spike.

## Out of scope (later phases)

WiFi/MQTT/TLS, signed command/ack envelopes, `/api/state` + `/api/log`
reporting, allowlist, NTAG 424, OTA, flash encryption. The signing contract
these will implement is in [`devices/README.md`](../README.md) and
[`lib/sign.ts`](../../lib/sign.ts).
