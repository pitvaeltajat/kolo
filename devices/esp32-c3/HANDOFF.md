# ESP32-C3 Yale firmware — handoff / continuation notes

Last updated: 2026-10-26. Repo: `github.com:pitvaeltajat/kolo.git`.

This file is the durable continuation base for the ESP32-C3 firmware work. It
captures the current state, the blocker, and the exact next steps so work can
resume without re-deriving context.

## Where we are

The firmware is **code-complete, builds clean, host tests pass, and is flashed
to the board**. It is blocked on **one** thing: the Yale Doorman L3 refuses BLE
connections because it is at its connection limit (it is a single-connection
device, currently held by another device).

## Hardware / environment

- **Board**: ESP32-C3 supermini, flashed via USB-Serial-JTAG.
- **Serial port**: `/dev/ttyACM1` (NOT `ttyACM0` — that one is stale).
  WSL2 + usbipd-win for USB passthrough.
- **ESP-IDF v5.4** at `~/esp/esp-idf`. Export: `. ~/esp/esp-idf/export.sh`.
- **Python with pyserial**: `~/.espressif/python_env/idf5.4_py3.11_env/bin/python`.
- **Credentials in NVS** (survive reflash): MAC `98:1b:b5:b9:cb:bd`, slot `2`,
  offline key set.
- **Lock advertises** as name `LA0008R`, mfg `0x01D1`, service `0xFE24`,
  RSSI −72..−80 dBm.

## Commands

```bash
# Build
cd devices/esp32-c3 && . ~/esp/esp-idf/export.sh >/dev/null 2>&1 && idf.py build

# After editing Kconfig.projbuild, reconfigure first (else CONFIG_* undefined)
idf.py reconfigure

# Flash
idf.py -p /dev/ttyACM1 flash

# Console test
ESP_SETTLE=45 ~/.espressif/python_env/idf5.4_py3.11_env/bin/python \
  tools/esp_console.py /dev/ttyACM1 "status"

# Host unit tests
cmake -S test -B build-test && cmake --build build-test && ./build-test/test_crypto
```

## The blocker (`status=9`)

- `status=9` = `BLE_ERR_CONN_LIMIT`; `status=13` = `BLE_ERR_CONN_REJ_RESOURCES`.
- **Cause**: the lock is a single-connection device. The Yale Connect bridge,
  the Yale Home app, and Apple Home all hold its one slot. The lock drops idle
  links only after **~30 s**.
- A **live** connection cannot be forced to drop from our side.
- **Fix already in firmware** (commit `979dd3d`): 5 attempts × 4 s backoff
  (Kconfig `YALE_CONNECT_ATTEMPTS` / `YALE_CONNECT_RETRY_BACKOFF_MS`);
  `waitFor(Connected)` returns immediately on `ConnectFailed`.
- **Verified on hardware**: the retry loop runs, but every attempt still
  returns `status=9`.

## Next steps (in order)

1. **Free the lock's slot externally**:
   - Unplug the Yale Connect bridge (and any other Yale hub).
   - Close the Yale Home app + Apple Home/HomeKit on all phones/tablets.
   - Wait **30–60 s**.
   - If still busy: pull the lock's battery for a few seconds to reset its radio.
2. Re-run `status` on `/dev/ttyACM1`. Expect: connect → discover → handshake →
   `GETSTATUS` returns lock/door/battery.
3. If connect succeeds: run `unlock` / `lock`, then the 100-cycle soak
   (FIRMWARE.md phase 2), measure latency/battery, confirm out-of-range fails
   cleanly.
4. Confirm the GATT cache survives a reboot (second connect skips discovery).
5. Then move to later phases: WiFi/MQTT/TLS, signed cmd/ack envelopes,
   `/api/state` + `/api/log` reporting (contract in `devices/README.md`,
   `lib/sign.ts`).

## Git

- Branch `main`, pushed to `origin`. Latest: `979dd3d` (retry + backoff + README
  troubleshooting + `idf-env.sh` / `usbipd-env.sh` / `tools/esp_console.py`).
- Working tree clean after push.

## Key files

- `main/yale/YaleBleLock.cpp` — BLE driver (`scanAndConnect`, `waitFor`, `gapEvent`).
- `main/yale/yale_crypto.*` — AES-ECB/CBC + 18-byte frames.
- `main/Kconfig.projbuild` — `YALE_MAC` / `SLOT` / `OFFLINE_KEY` + timing knobs.
- `main/cli.*` — serial console (`scan` / `status` / `unlock` / `lock` / `setkey` / …).
- `README.md` — build/flash + "Troubleshooting: status=9" section.
- `tools/esp_console.py` — serial console helper.

## Protocol essentials (quick reference)

- Service `0xFE24`; frames always 18 bytes (16-byte AES block + 2 plain bytes).
- Secure channel (`…613` write / `…614` notify), AES-128-ECB with offline key:
  opcode `0x01` exchanges 8 random bytes each way; session key =
  `ours[0:8] || theirs[0:8]`; opcode `0x03` confirms.
- Command channel (`…611` write / `…612` notify), AES-128-CBC zero IV; the CBC
  chain continues across every frame per direction. Frames start `0xEE` (cmd),
  replies `0xAA` (ack) / `0xBB` (result); 8-bit checksum at `0x03`; result byte
  at `0x0F`.
- Opcodes: `GETSTATUS 0x02`, `UNLOCK 0x0A`, `LOCK 0x0B`. GETSTATUS subtypes:
  lock `0x02`, door `0x2E`, battery `0x0F`.
- CCCDs are INDICATE-only: write `0x0002`, NOT `0x0001`.
