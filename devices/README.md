# Device side — Shelly (heating) & ESP32 (door)

The on-site firmware/scripts that talk to the kolo Vercel app. Written **in
advance** of the hardware so the contract is pinned and phases 1→ can start the
day the parts arrive. Nothing here is on the wall yet.

```
                 kolo.pitva.fi (Vercel)
   setpoint/schedule │        │ cmd/allowlist        ▲ state / ack / log
   (MQTT, signed)    ▼        ▼ (MQTT, signed)        │ (HTTP POST or MQTT, signed)
            ┌─────────────┐        ┌───────────────────────────┐
            │ Shelly 1PM  │        │ ESP32-C6 + PN532 (door box)│
            │ ×3 heaters  │        │ BLE → Yale Doorman L3      │
            │ BLE → BLU H&T│        │ NTAG 424 tags              │
            └─────────────┘        └───────────────────────────┘
```

## The signing contract (both devices, both directions)

The broker is **untrusted** — it only relays. Every message is an envelope:

```json
{ "device": "heater-eteinen", "payload": "<json-string>", "sig": "<hex>" }
```

- `payload` is a JSON **string**. `sig = HMAC_SHA256(key, payload_bytes)`, hex.
  Both sides hash the exact bytes — never re-serialise an object to verify, or
  key ordering/whitespace will diverge. (This is why kolo's `lib/sign.ts` signs
  the string, not the object.)
- The decoded `payload` always has `ts` (epoch ms) and `nonce` (hex). Reject if
  `|now − ts| > 30 s`, and never accept the same `nonce` twice.
- `device` outside the envelope is only a **key hint** — it picks which HMAC key
  to try. It is not trusted: the signed payload repeats `device`, and the
  signature fails if the hint is wrong.
- Key: a single shared secret `DEVICE_HMAC_KEY` for v1 (kolo also supports
  per-device `DEVICE_HMAC_KEY_<ID>` later; keep one key until you need more).

### Topics / endpoints

| Direction | Transport | Topic / path | Body (inside `payload`) |
|---|---|---|---|
| kolo → door | MQTT | `kolo/door/cmd` | `{action:"unlock"\|"lock"\|"enroll", member?}` |
| door → kolo | MQTT | `kolo/door/ack` | `{reply:<cmd nonce>, result:"ok"\|"fail", detail?}` |
| kolo → door | MQTT | `kolo/door/allowlist` | `{entries:[{uid,member}], count}` |
| door → kolo | HTTP POST | `/api/state` | `{kind:"DOOR", locked, doorOpen, battery}` |
| door → kolo | HTTP POST | `/api/log` | `{method, action, result, member?, detail?}` |
| kolo → heat | MQTT | `kolo/heating/setpoint` | `{setpointC, source}` |
| kolo → heat | MQTT | `kolo/heating/schedule` | `{periods:[{startMs,endMs,setpointC}]}` |
| heat → kolo | HTTP POST | `/api/state` | `{kind:"HEATER", room, relay, tempC, powerW}` |

HTTP POSTs carry the same `{device,payload,sig}` envelope as the JSON body.

## Broker (live)

Mosquitto on the troop's Lightsail box: **`mqtts://mqtt.pitva.fi:8883`**, TLS
with a private CA (`mqtt-ca.crt` here) + password auth. Each device needs:
username `kolo`, the shared password, and `mqtt-ca.crt` as its trusted CA.

- **Shelly:** Settings → MQTT → server `mqtt.pitva.fi:8883`, user `kolo`, enable
  TLS and upload `mqtt-ca.crt` as the CA (the thermostat *script* assumes the
  device's own MQTT client is already connected).
- **ESP32:** in `esp32/` secrets.yaml set `mqtt_broker: mqtts://mqtt.pitva.fi:8883`,
  `mqtt_username: kolo`, and add the `certificate_authority:` from `mqtt-ca.crt`.

## Contents

- `shelly/kolo-heating.js` — Shelly Gen3 thermostat script (phase 1 heating).
- `yale/fetch_offline_key.py` — fetch the lock's BLE offline key/slot/MAC (phase 1 door).
- `esp32/` — ESPHome config + crypto helper for the door controller (phases 2–3).

Phases follow the plans: [../suunnitelmat/PLAN.md](../suunnitelmat/PLAN.md) (door),
[../suunnitelmat/HEATING.md](../suunnitelmat/HEATING.md) (heating).
