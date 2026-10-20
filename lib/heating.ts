import { COMFORT_C, IDLE_C, PREHEAT_HOURS, SCHEDULE_DAYS, clampSetpoint } from './config';

/**
 * The heating brain, kept pure so it can be unit-tested without a broker, a
 * database or a clock: feed it the time, the upcoming events and any manual
 * override and it tells you the setpoint. The Shellys run their own hysteresis
 * thermostat around whatever setpoint this produces (HEATING.md "Design").
 */

export type Event = { startMs: number; endMs: number; title?: string; location?: string };
export type Override = { untilMs: number; setpointC?: number };
export type Source = 'BOOST' | 'CALENDAR' | 'DEFAULT';
export type Setpoint = { setpointC: number; source: Source };

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** True when `now` is inside an event's heating window (preheat → event end). */
function inComfortWindow(nowMs: number, events: Event[]): boolean {
  const preheat = PREHEAT_HOURS * HOUR_MS;
  return events.some((e) => nowMs >= e.startMs - preheat && nowMs < e.endMs);
}

/**
 * The setpoint that applies right now. A manual override (the web slider) wins
 * until it expires; then the calendar decides — comfort during/just before an
 * event, idle otherwise.
 */
export function activeSetpoint(nowMs: number, events: Event[], override: Override | null): Setpoint {
  if (override && nowMs < override.untilMs) {
    return { setpointC: COMFORT_C, source: 'BOOST' };
  }
  if (inComfortWindow(nowMs, events)) return { setpointC: COMFORT_C, source: 'CALENDAR' };
  return { setpointC: IDLE_C, source: 'DEFAULT' };
}

export type Period = { startMs: number; endMs: number; setpointC: number };

/**
 * The comfort periods for the next SCHEDULE_DAYS, pushed to the Shellys so the
 * schedule survives an internet outage. Each event becomes one
 * [start-preheat, end] window at comfort temperature; overlapping windows are
 * merged. Between periods the device falls back to its idle setpoint, so only
 * comfort windows need sending.
 */
export function computeSchedule(nowMs: number, events: Event[]): Period[] {
  const preheat = PREHEAT_HOURS * HOUR_MS;
  const horizon = nowMs + SCHEDULE_DAYS * DAY_MS;

  const windows = events
    .filter((e) => e.endMs > nowMs && e.startMs < horizon)
    .map((e) => ({ startMs: e.startMs - preheat, endMs: e.endMs }))
    .sort((a, b) => a.startMs - b.startMs);

  const merged: Period[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.startMs <= last.endMs) {
      last.endMs = Math.max(last.endMs, w.endMs);
    } else {
      merged.push({ startMs: w.startMs, endMs: w.endMs, setpointC: COMFORT_C });
    }
  }
  return merged;
}

export const IDLE_SETPOINT_C = IDLE_C;
