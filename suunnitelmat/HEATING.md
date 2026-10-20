# Heating control — Phase 1 (2027)

This is Kolo's heating system. It controls the existing electric radiators
over the building's existing Wi‑Fi network; no new 4G router or separate
internet connection is needed.

The goal is centralized, dependable temperature control with an optional
remote-control path. The heating system remains independent of the door lock
hardware and must fail safely for the building.

## Hardware and wiring

### Downstairs

- Replace the old control relay in the electrical cabinet (K2) with a
  **Shelly Pro 3**.
- The Pro 3 drives the existing three contactors.
- Those contactors control the five downstairs radiators:
  entrance, kitchen, and meeting rooms.
- One downstairs temperature sensor controls the downstairs heating zone.

### Upstairs

- Install one **Shelly 1 Gen4, 16 A** for each 2 kW radiator (two total).
- One upstairs temperature sensor controls the upstairs zone.
- The Shelly devices switch the existing radiator circuits; the radiator
  safety cut-outs remain in place.

### User controls and safety sensor

- The web app has a **Lämpö 3 tunniksi** button. Every signed-in user may use
  it; it immediately requests normal operating temperature for three hours and
  overrides the calendar schedule.
- A sensor beside the coldest pipe forces heating on below **+5 °C**.
- In a fault state, heating remains on. Fault handling must not silently leave
  the building unheated.

## Control program

- Monday–Thursday, 17:00–21:00: normal operating temperature.
- At all other times: **10 °C**.
- Wall boost: normal operating temperature for three hours.
- The downstairs and upstairs zones use their own temperature sensors.
- The implementation should expose the current temperatures, zone states and
  active override in the web UI.
- Only administrators may set the downstairs and upstairs target temperatures
  in the web app. There is no general-purpose manual temperature slider.
- The web app shows Google Calendar bookings and the resulting heating plan,
  including when pre-heating begins (two hours before each booking).
- Local scheduled control must continue without remote access.

## Control principles

- Centralized control improves comfort and avoids independent radiator
  thermostats fighting one another.
- Keep the existing electrical protection and radiator over-temperature
  protection.
- Test the system after power loss, sensor failure, Shelly failure and loss
  of network access.
- Fixed electrical installation work must be carried out by a qualified,
  registered professional in Finland (Tukes requirements).

## Estimated cost

| Item | Estimate |
|---|---:|
| Shelly Pro 3 | 100 € |
| Shelly 1 Gen4, 16 A ×2 | 40 € |
| Temperature sensors ×2 | 50 € |
| Wall boost button | 23 € |
| Installation materials | 30 € |
| **Total** | **about 240 €** |

Expected saving is approximately **4.5 MWh / 850 € per year**, giving a
payback period of under one year.

## Phase 1 acceptance tests

1. Verify all five downstairs radiators follow the downstairs sensor through
   the existing contactors.
2. Verify both upstairs 2 kW radiators follow the upstairs sensor.
3. Verify the Monday–Thursday schedule and 10 °C setback.
4. Verify the wall button provides exactly three hours of normal temperature.
5. Verify the coldest-pipe sensor forces heating below +5 °C.
6. Verify the defined fault behavior leaves heating on.
7. Verify operation after power loss and during Wi‑Fi/Vercel unavailability.
