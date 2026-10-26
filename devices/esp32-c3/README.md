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

| Command                                                          | What                                                                    |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `scan`                                                           | read lock/door/battery (scans for the lock if the direct connect fails) |
| `status`                                                         | read lock/door/battery state                                            |
| `unlock` / `lock`                                                | drive the lock                                                          |
| `setkey <32-hex>` / `setmac <aa:bb:cc:dd:ee:ff>` / `setslot <n>` | provision credentials (persist in NVS)                                  |
| `info`                                                           | show configured MAC/slot (key masked)                                   |
| `forget`                                                         | clear the cached GATT handles (forces re-discovery)                     |

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

**Hardware bring-up (Oct 2026):**

- ✅ Flashed; credentials provisioned (MAC/slot/key in NVS).
- ✅ Scan finds the lock; connect succeeds; GATT discovery finds service
  `0xFE24` and all four characteristics; secure CCCD enabled.
- ⏳ **Secure-channel handshake** — the `0x01` key exchange gets no response.
  Next: fix the secure-notify CCCD handle (discovered at the service end, not
  adjacent to the value handle), then re-test; if it still fails, verify the
  offline key/slot.
- ⏳ 100-cycle soak, latency/battery, out-of-range behaviour, GATT-cache reboot.

See [`HANDOFF.md`](HANDOFF.md) for the full continuation notes.

## Troubleshooting

### "connect failed: status=9"

`status=9` is **`BLE_HS_EAPP`**, which NimBLE reports when *we* cancel the
connect after its duration expires — i.e. the lock never answered. It is **not**
an HCI connection-limit code. The usual cause is connecting to the wrong
address: `ble_addr_t.val` is least-significant byte first, so the configured
MSB-first MAC must be reversed (`addr.val[i] = m_mac[5 - i]`). If you see the
reversed MAC in the `peer_addr=` log line, that is the bug.

### "key exchange rejected: offline key or slot is incorrect"

The connect and GATT discovery succeeded, but the lock did not answer the
secure-channel `0x01` exchange (or answered with something other than `0x02`).
This is the error a wrong offline key or slot produces. Check `info`, and
re-fetch the key with [`fetch_offline_key.py`](../yale/fetch_offline_key.py) if
needed. A wrong **MAC** is different: the scan would not match the lock at all.

### The lock is genuinely busy

The lock is a single-connection device; the Yale Connect bridge, the Yale Home
app, and Apple Home all compete for its one slot, and it drops idle links only
after ~30 s. If connects time out while everything else is connected, unplug
the bridge, close the apps, wait 30–60 s, and retry. The firmware retries
(`YALE_CONNECT_ATTEMPTS`, default 5) with a backoff
(`YALE_CONNECT_RETRY_BACKOFF_MS`, default 4000 ms), but it cannot force the
lock to drop a live connection; pull the lock's battery to reset its radio.

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
