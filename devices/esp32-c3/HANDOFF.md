# ESP32-C3 Yale firmware — handoff / continuation notes

Last updated: 2026-11-04. Repo: `github.com:pitvaeltajat/kolo.git`.

This file is the durable continuation base for the ESP32-C3 firmware work. It
captures the current state and the next steps so work can resume without
re-deriving context.

## Where we are

**The full BLE path works end-to-end against the real lock**: scan → connect →
GATT discovery → secure-channel handshake → command channel → `GETSTATUS`.
`status` on the console returns live `lock status` / `door status` / `battery`.
The secure handshake frame now matches the yalexs-ble reference byte-for-byte.

Now developed/flashed on **macOS** (not WSL): board enumerates at
`/dev/cu.usbmodem1101`; ESP-IDF v5.4 at `~/esp/esp-idf`; a pyserial venv drives
`tools/esp_console.py`. The WSL/usbipd notes below are retained for that host.

## WiFi / MQTT cloud link (2026-11-04, BLE done; WiFi association is the open bug)

The `net/` module (`net.cpp`/`net.hpp`) implements the full device↔kolo contract
(`devices/README.md`, mirrored from `devices/esp32/kolo-door.yaml`): WiFi STA +
SNTP + MQTT(TLS, private CA) + signed `kolo/door/cmd` → verify (HMAC + ±30 s +
nonce) → actuate via `YaleBleLock` → signed `kolo/door/ack`, plus signed HTTPS
POST `/api/state`. Config is in NVS via new CLI setters (`setwifi`, `setmqtt`,
`sethmac`, `net`); the result callback is now a fan-out (`addResultCallback`) so
the CLI and net layer both see command results.

**Build/flash changes:** firmware grew past 1 MB, so `partitions.csv` gives a
2 MB app on 4 MB flash (`CONFIG_PARTITION_TABLE_CUSTOM`, `FLASHSIZE_4MB`); NVS
kept at 0x9000 so creds survive. `sdkconfig.defaults` adds
`ESP_COEX_SW_COEXIST_ENABLE` (WiFi+BLE share the radio) and the mbedTLS cert
bundle (public CA for `kolo.pitva.fi`). The broker CA is embedded from
`../../mqtt-ca.crt` (verified to match the live broker's CA, sha256
`C6:12:23:...:5D:32`).

**Infra provisioned this session (all consistent):**
- Broker: Mosquitto in Docker on Lightsail `pitva-debian-13` (13.51.186.114),
  container `kolo-mosquitto`, config at `/etc/kolo-mosquitto/config`. Host/CN
  **`mqtt.pitva.fi`**:8883, user `kolo`, `allow_anonymous false`. SSH via
  `aws lightsail get-instance-access-details` (user `admin`, needs
  `aws sso login --sso-session pitva`).
- **Secrets were ROTATED** (the old MQTT password was unrecoverable): new
  `MQTT_PASSWORD` set on the broker (`mosquitto_passwd`) + device NVS + Vercel
  env; new `DEVICE_HMAC_KEY` set on device NVS + Vercel env. kolo **redeployed**
  to production (aliased `kolo.pitva.fi`) so the app uses the new values.
- Device provisioned: `ssid`=this Mac's WiFi, `mqtt host`=mqtt.pitva.fi, mqtt
  pass + hmac set (all in NVS, `net` confirms).

**RESOLVED + full path verified end-to-end (2026-11-04).** The WiFi "never
associates" symptom was a wrong SSID: the USB-Serial-JTAG console strips
non-ASCII input, so the UTF-8 SSID `Pitkäjärven Vaeltajat` lost its `ä`s and
`setwifi` stored a bad name → `STA_DISCONNECTED reason=201` (NO_AP_FOUND). Fixed
with a `setwifi hex:<utf8-bytes> <pass>` option (commit `5da249d`). After that:
WiFi gets IP, MQTT connects over TLS (private CA) to `mqtt.pitva.fi:8883`, and a
signed `kolo/door/cmd` unlock was driven from the broker →
`net: cmd unlock` → secure session → `[OK] unlock` → `net: ack ok` →
`net: state posted (200)`. So cmd→verify→actuate→ack AND `/api/state` all work.

Provision a non-ASCII SSID like:
`setwifi hex:5069746bc3a46ac3a47276656e205661656c74616a6174 <password>`
(that hex is `Pitkäjärven Vaeltajat`; `python3 -c "print('<ssid>'.encode().hex())"`).

**Known rough edge — intermittent "lock rejected" from the web app.** A BLE
connect can take up to `YALE_DIRECT_CONNECT_MS` (10 s), but the app waits only
`ACK_TIMEOUT_MS` (5 s, lib/config.ts). When the Yale **Connect bridge** holds
the lock's single BLE slot, the device can't connect+unlock within 5 s and the
app shows failure; when the slot is free it's ~1 s and works. Not a logic bug —
retry usually succeeds. To harden: raise the app's `ACK_TIMEOUT_MS` (~12–15 s)
and/or have `performCommand` retry the connect once (disconnect, short backoff)
within that window instead of fast-failing on the first miss (YaleBleLock.cpp
line ~860). A local console `unlock` works reliably (BLE + WiFi coexistence are
fine).

Local MQTT test harness: `scratchpad/kolo_cmd.py <unlock|lock|status>` signs and
publishes to the broker and prints the ack (needs the hmac key + mqtt password
files, which live only in this session's scratchpad — regenerate from 1Password
or re-rotate if gone).

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

## Bugs found and fixed 2026-11-04 (handshake now works)

The previous session stopped at a failing handshake. Four root causes, all now
fixed and verified against the real lock:

1. **Secure-notify CCCD discovered as handle 32, not 26** (`YaleBleLock.cpp`,
   `onDsc`). The range `m_hSecRead..m_svcEnd` sweeps up the CCCDs of later
   characteristics too, and NimBLE reports them all with the same
   `chr_val_handle` we asked for, so last-wins landed on 32. Fixed: keep the
   **first** `0x2902` per characteristic (`m_hReadCccd == 0` guard).
2. **Secure checksum was CRC-32** (`yale_crypto.h`). The August/Yale secure
   frame uses `(0 - (u32[0:4] + u32[4:8] + u32[8:18])) & 0xFFFFFFFF` LE at
   `0x0C` (yalexs-ble `util._security_checksum`), which reduces to the negated
   sum of three LE 32-bit words over bytes `0x00..0x0B`. Replaced
   `putCrc32`/`crc32` with `putSecurityChecksum`. Also: byte `0x10` must be
   `0x0F` (yalexs-ble `build_command`), and `decryptSecure` must AES-**decrypt**
   (it was calling encrypt).
3. **`setkey` didn't drop the RAM GATT cache** (`cli.cpp` → `clearCache`, now
   public). `forget` only cleared NVS, so the live object kept stale handles.
4. **Offline key read back as all-zeros** (`main.cpp`). `YaleBleLock lock` was a
   stack local in `app_main`; `app_main` returns after setup, destroying it, and
   `~YaleBleLock()` zeroes the offline key — while the BLE worker task keeps
   using the object. MAC/handles survived in that memory so scan/connect/discover
   worked; only the key was zero, so the handshake failed. Fixed with
   `static YaleBleLock lock(creds)`. (`saveCreds` now also reports NVS write
   failures instead of always logging "saved".)

The on-wire `0x01` frame now matches the yalexs-ble reference byte-for-byte, and
`status` returns `lock 0x03 / door 0x01 / battery ~5038 mV`.

## Current state

**Working end-to-end.** `status` → `secure session established` → live
lock/door/battery. GATT cache + address persist across reboots (second connect
skips the scan). Credentials in NVS: MAC `98:1b:b5:b9:cb:bd`, slot `2`, offline
key (matches the 1Password item "Kolo Doorman L3 — BLE offline key"; a cloud
re-fetch 2026-11-04 returned the same key, so it has **not** rotated).

## Next steps (in order)

1. `unlock` / `lock` — exercise the command channel end-to-end (actuates the
   real bolt; confirm with a human present). `status` already proves the
   command channel works for reads.
2. 100-cycle soak (FIRMWARE.md phase 2), latency / battery, out-of-range.
3. Later phases: WiFi/MQTT/TLS, signed cmd/ack envelopes, `/api/state` +
   `/api/log` reporting (contract in `devices/README.md`, `lib/sign.ts`).

Nice-to-have: `setkey`/`setslot` only take effect after a reboot (the live
object loads creds once at boot). Add a method to re-load creds into the running
`YaleBleLock` if runtime re-provisioning is wanted.

## Git

- Work done on branch `worktree-concurrent-exploring-treasure`.

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
