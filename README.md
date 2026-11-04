# Kolo

`kolo.pitva.fi` — the Vercel web app that controls the PitVa kolo **front door**
and **electric heating**. It is the "policy, logs and UI" layer the two plans in
[`suunnitelmat/`](suunnitelmat/) describe ([PLAN.md](suunnitelmat/PLAN.md) door,
[HEATING.md](suunnitelmat/HEATING.md) heating). The door controller firmware
([`devices/esp32-c3/`](devices/esp32-c3/README.md)) and the MQTT broker are
built and verified end-to-end against the real lock; the NTAG 424 tag reader
and the heating Shellys are still to come.

Sign-in is the shared `atk.pitva.fi` Google login (same cookie as klapi/budu).
**Authorisation is Google Group membership** — a member of `ACCESS_GROUP` can
open the door and set the heating; nobody else can. There is no user database.

## How it fits together

```mermaid
flowchart LR
    P["phone"] -->|"signed cmd"| MQTT
    K["kolo.pitva.fi"] -->|"signed cmd"| MQTT
    MQTT -->|"signed cmd"| E["ESP32<br/>BLE → Yale lock"]
    E -->|"BLE"| Y["Yale lock"]
    E -->|"events POSTed back<br/>signed"| K
    T["tag"] -->|"offline allowlist"| E
    S["admin setpoint · 3 h boost · Google Calendar"] -->|"plan"| K
    K -->|"setpoint/schedule<br/>signed"| MQTT
    MQTT -->|"signed"| SH["Shelly ×3"]
    SH -->|"heat"| H["heaters"]
```

The broker is untrusted and only relays: **every command is HMAC-SHA256 signed**
([`lib/sign.ts`](lib/sign.ts)) and every device report verified the same way,
with timestamp-skew and single-use-nonce replay protection.

## Routes

| Route | What |
|---|---|
| `POST /api/unlock` · `/api/lock` | member → signed command → wait for ack → log |
| `GET /api/status` | last door state (locked / open / battery) |
| `GET /api/heating` · `POST /api/heating/setpoint` · `/api/heating/boost` | room temps + plan; admin per-area setpoint; any member starts a 3 h boost |
| `POST /api/state` · `/api/log` | device reports state / door events (signed) |
| `GET/POST/DELETE /api/tags…` · `POST /api/tags/enroll` | tag admin + on-reader enrol |
| `POST /api/allowlist` | push the signed tag allowlist to the reader |
| `GET /api/cron/{heating,allowlist,heartbeat}` | Vercel Cron (see `vercel.json`) |

## Develop

```bash
npm install
cp .env.example .env            # fill in at least NEXTAUTH_SECRET + DATABASE_URL
npx prisma migrate dev          # create the schema
ENABLE_DEV_LOGIN=true npm run dev
npm test                        # pure-logic checks (signing, heating maths)
```

With `MQTT_URL` unset, the door/heating commands return a clear "transport not
configured" instead of pretending to work — nothing fakes a successful unlock.

## Status

The web app is complete. The **door** path is working end-to-end (Nov 2026): an
ESP32-C3 drives the Yale lock over BLE, and a signed unlock from this app travels
`web → signed MQTT → device → lock → ack + state`, all verified. Remaining there:
the NTAG 424 tag reader hardware and a leaders' pilot. The **heating** side is
built in the app but its Shellys/sensors aren't installed yet (see HEATING.md).
The signing contract here ([`lib/sign.ts`](lib/sign.ts),
[`devices/README.md`](devices/README.md)) is what the firmware and Shelly scripts
implement against.
