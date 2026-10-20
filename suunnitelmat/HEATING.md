# Central heating control — plan

Goal: one temperature setting (web app slider, optionally a wall knob) controls
the 3 hardwired ~2 kW electric radiators in two adjacent rooms.

**This is a different building from the door project** ([PLAN.md](PLAN.md)),
and it has **no internet**. It reuses the door project's Vercel app, Google
sign-in and MQTT broker, but needs its own 4G connection.

## Connectivity: 4G router

- **Teltonika RUT241** (4G + Wi-Fi, industrial, –40…+75 °C, ping watchdog
  auto-reboot, free remote management via Teltonika RMS), ~90–110 €.
  A consumer 4G router (~50–70 €) works if it stays above 0 °C, but is less
  dependable unattended.
- Data SIM (prices checked Oct 2026, verify before ordering):
  - **1st choice: 1NCE IoT SIM** — 12 € + 1 € SIM (ex VAT, ≈16 € incl.) for
    **10 years / 500 MB**, top-up 10 € per 500 MB. Roams on partner networks;
    Finnish coverage at the site unverified — buy one and test. Sells to
    businesses; the association's Y-tunnus should qualify.
  - **Fallback: cheapest postpaid data-only** — Telia Rehti netti 4G 50M
    ~9.99 €/mo (check if promo), Moi Reilu Netti ~14 €/mo, DNA Kotimokkula 4G
    ~14.90 €/mo. No expiry risk.
  - **Avoid prepaid**: packages need manual renewal, lines close if not topped
    up, and always-on pay-per-day (e.g. Elisa 0.99 €/day) hits the ~20 €/mo cap.
- Data budget for 500 MB to last: one MQTT connection per device with
  keepalive ≥ 120 s, Shelly Cloud off, Teltonika RMS off or long heartbeat,
  firmware updates done on site / deliberately. Expect ~5–15 MB/month →
  500 MB lasts years.
- All connections are outbound (MQTT over TLS), so operator CGNAT doesn't
  matter.

**Everything must keep working without internet**; 4G only adds remote
control and scheduling:
- Thermostat logic runs on each Shelly; last setpoint is kept.
- Vercel pushes the **next 7 days of heating periods** to the Shellys, so
  schedules continue through outages. Time comes from NTP; after a power cut
  with no connection, fall back to the plain setpoint (no schedule).
- Optional local wall knob (ESP32 + rotary encoder) talks to the Shellys over
  the router's Wi-Fi, no internet needed.
- Heartbeat: site silent > 30 min → Vercel emails the admins.

## Design

```
web app slider / Google Calendar ─► Vercel ─► MQTT ─► 4G router ─► Shelly 1PM Gen3 ×3 ─► heaters
                                                         ▲ (local BLE)
                                                Shelly BLU H&T ×2 (one per room)
```

- **Heater thermostats set to max**; the Shelly switches mains power. The
  heater's own overheat cutout stays as the safety net.
- **Thermostat logic runs locally on each Shelly** (Shelly script): reads its
  room's BLU H&T sensor over Bluetooth, compares with the setpoint received
  over MQTT. Internet down → keeps the last setpoint.
- **Room sensors away from heaters**, ~1.5 m high, not in direct sun or drafts.
  Heaters are mapped to the sensor of their room.
- **Separate from the door ESP32** — a heating fault must never take the door
  down and vice versa.

### Control rules

- Hysteresis ±0.5 °C **and** minimum on/off time ~10 min. A 2 kW load
  (~8.7 A) on a 16 A relay is fine, but fast cycling wears the contacts.
- Sensor silent > 30 min → fall back to frost protection (8 °C), not "on".
- Setpoint clamped to 5–24 °C.
- Same setpoint for both rooms by default; per-room offset if one runs cold.

### Setpoint sources

- **Web app**: slider in the door app (same Google Group, or a narrower
  `lampo@` group), shows current temperature per room and heater on/off.
- **Google Calendar** (biggest saving): heat to 20 °C from ~2 h before an
  event in the group calendar, otherwise 12 °C. Vercel cron every 15 min
  publishes the setpoint; manual override from the slider lasts until the
  next calendar change.
- Optional later: physical wall knob (ESP32 + rotary encoder + small display,
  low voltage, ~10 €), and shifting pre-heat into the cheapest spot-price hours.

## Hardware

| Item | Qty | ~€ | Note |
|---|---|---|---|
| Shelly 1PM Gen3 (16 A, power metering) | 3 | 60 | one per heater, in the wall box behind it. **Not the 1PM Mini (8 A)** |
| Shelly BLU H&T (Bluetooth temp/humidity) | 2 | 40 | one per room, battery |
| Teltonika RUT241 4G router | 1 | 90–110 | see Connectivity |
| 1NCE IoT SIM (10 y, 500 MB) | 1 | ~16 once | fallback: ~10–15 €/mo postpaid |

**Total ~215 € one-off** (with 1NCE), or ~200 € + ~10–15 €/mo postpaid.

Alternative if each heater has its own circuit in the panel: DIN-rail
installation at the distribution board — Shelly Pro relays or Shelly driving
modular contactors (20 A, ~20 € each). Contactors last far more switching
cycles and keep heat out of cramped wall boxes; costs ~60 € more.

## Installation notes

- Needs neutral at the wall box (Shelly 1PM requires it).
- 2 kW continuous in a closed wall box warms the Shelly; leave space, don't
  bury it in insulation. Check power metering reads ~2 kW when on.
- Existing circuits and fuses are unchanged (same load as today).
- Check each heater resumes heating after a power cut (mechanical
  thermostats do; some electronic ones restart in standby).
- In Finland, fixed electrical installation work must be done by someone
  qualified/registered for it (Tukes).

## Phases

0. Check 4G coverage at the site with a phone (operator, signal); order one
   1NCE SIM and test it there before committing.
1. Router + one Shelly + one BLU H&T on one heater; script with hysteresis, min on/off
   time and sensor-timeout fallback. Run a week, read the power log.
2. Remaining two heaters, MQTT setpoint from Vercel, slider in the web app.
3. Google Calendar schedule.

## Open questions

- Which heaters are in which room (2+1?).
- Separate circuits per heater in the panel? (decides wall box vs. DIN rail)
- Who can change the temperature — everyone in `ovi@`, or a smaller group?
