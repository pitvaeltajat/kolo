# ESP32-C3 Yale firmware — handoff / continuation notes

Last updated: 2026-10-26. Repo: `github.com:pitvaeltajat/kolo.git`.

This file is the durable continuation base for the ESP32-C3 firmware work. It
captures the current state, the blocker, and the exact next steps so work can
resume without re-deriving context.

## Where we are

The firmware is **code-complete, builds clean, host tests pass, and is flashed
to the board**. BLE connect + GATT discovery now work end-to-end against the
real lock. The remaining failure is the **secure-channel handshake** (no
response to the `0x01` key exchange) — see "Current state" below.

## Hardware / environment

- **Board**: ESP32-C3 supermini, flashed via USB-Serial-JTAG.
- **Serial port**: `/dev/ttyACM0` (re-attach with
  `usbipd.exe attach --wsl --busid 1-2`; the number can change between
  re-attaches — check `ls /dev/ttyACM*`). WSL2 + usbipd-win for USB passthrough.
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
idf.py -p /dev/ttyACM0 flash

# Console test
ESP_SETTLE=45 ~/.espressif/python_env/idf5.4_py3.11_env/bin/python \
  tools/esp_console.py /dev/ttyACM0 "status"

# Host unit tests
cmake -S test -B build-test && cmake --build build-test && ./build-test/test_crypto
```

## What `status=9` really was (resolved)

`status=9` is **`BLE_HS_EAPP`**, not an HCI connection-limit code. NimBLE sets
it in `ble_gap.c` when **we cancel the connect ourselves** after the duration
expires. So the lock was never rejecting us — the connect was timing out
because we were connecting to the **wrong address** (see below). The earlier
"lock is busy" theory was wrong; the bridge/apps were a red herring.

## Bugs found and fixed this session (all in `YaleBleLock.cpp`)

1. **MAC byte order in the connect path.** `ble_addr_t.val` is least-significant
   byte first (on-air order); `m_mac` is MSB-first. We did
   `memcpy(addr.val, m_mac.data(), 6)` — connecting to the byte-reversed
   address `bd:cb:b9:b5:1b:98` instead of `98:1b:b5:b9:cb:bd`. The scan-match
   code already reversed correctly, so the bug only showed on connect. Fixed
   with `addr.val[i] = m_mac[5 - i]` in both `connectDirect()` and
   `scanAndConnect()`. **This was the root cause of `status=9`.**
2. **`m_conn` never set.** `waitFor(Connected)` returns on the matching event
   *before* its inline handler runs, so `m_conn` stayed `0xFFFF` and every GATT
   call failed with `rc=7` (`BLE_HS_ENOTCONN`). Fixed by assigning
   `m_conn = event->connect.conn_handle` directly in the `gapEvent` callback
   (as the reference does).
3. **Characteristic UUIDs were 16-bit.** The Yale characteristics use the
   vendor base `bd4ac6xx-0b45-11e3-8ffd-0800200c9a66`, **not** the SIG base, so
   they are 128-bit. We matched `0x0611`…`0x0614` and bailed on non-16-bit
   UUIDs, so discovery found nothing. Fixed with `ble_uuid128_t` constants +
   `ble_uuid_cmp`, and switched to `val_handle` for all four (as the reference
   does).
4. **Descriptor (CCCD) range was empty.** `ble_gattc_disc_all_dscs(conn, h, h)`
   passes the same start and end handle → empty range → no CCCD. Fixed by
   bounding the range with the next characteristic's declaration handle
   (tracked via new `m_def*` members).
5. **Session setup order.** The reference notes: *"Order matters: secure
   notifications first, then the handshake, then the command channel."* Added
   `establishSession()` doing secure CCCD → handshake → command CCCD.

## Current state (end of session)

Discovery now works end-to-end: service `0xFE24` found (handles 16–32), all four
characteristics found (`write=18 read=20 cccd=21 secWrite=23 secRead=25
cccd=32`), secure CCCD enabled. **Remaining failure:** the handshake write to
`att_handle=23` gets **no response** and times out after 10 s →
`key exchange rejected: offline key or slot is incorrect`.

Two things to check next (in order):

1. **The secure-notify CCCD handle looks wrong.** It was discovered at handle
   **32** (the service end), not adjacent to the secure-notify value handle
   (25). The reference bounds the secure-notify descriptor search by the next
   characteristic declaration; we run it to `m_svcEnd`. Re-check the descriptor
   layout with `ESP_LOG_LEVEL=DEBUG` on the `YaleBle` tag (the `dsc chr_val=…
   handle=… uuid16=…` line) and fix the range so the CCCD lands at 26.
2. **Then re-test the handshake.** If the CCCD handle is right and the write
   still gets no reply, the offline key/slot may genuinely be wrong — that is
   the error the handshake reports. Verify with `info` and re-fetch the key via
   `devices/yale/fetch_offline_key.py` if needed.

## Next steps (in order)

1. Fix the secure-notify CCCD range (see above) and confirm the handle.
2. Re-run `status` on `/dev/ttyACM0`. Expect: connect → discover → handshake →
   `GETSTATUS` returns lock/door/battery.
3. If the handshake still fails, verify the offline key/slot (`info`, re-fetch).
4. Then: `unlock` / `lock`, the 100-cycle soak (FIRMWARE.md phase 2), latency /
   battery, out-of-range behaviour.
5. Confirm the GATT cache survives a reboot (second connect skips discovery).
6. Later phases: WiFi/MQTT/TLS, signed cmd/ack envelopes, `/api/state` +
   `/api/log` reporting (contract in `devices/README.md`, `lib/sign.ts`).

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
