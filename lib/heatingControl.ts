import prisma from './prisma';
import { publishSigned } from './mqtt';
import { activeSetpoint, computeSchedule, type Event, type Override } from './heating';
import { clampSetpoint } from './config';

/**
 * Ties the pure heating logic (lib/heating.ts) to the database, the calendar
 * and the broker. The Shellys run their own thermostat; this decides the
 * *setpoint* they aim for and pushes the next week's comfort periods so the
 * schedule survives an outage.
 */

const SINGLETON = 'singleton';

export async function getHeatingState() {
  const state =
    (await prisma.heatingState.findUnique({ where: { id: SINGLETON } })) ??
    (await prisma.heatingState.create({ data: { id: SINGLETON } }));
  const heaters = await prisma.device.findMany({ where: { kind: 'HEATER' }, orderBy: { id: 'asc' } });
  return { state, heaters };
}

function overrideFrom(state: { setpointC: number; overrideUntil: Date | null }): Override | null {
  return state.overrideUntil ? { setpointC: state.setpointC, untilMs: state.overrideUntil.getTime() } : null;
}

/** Next time the calendar-driven setpoint would change, for "override until next calendar change". */
function nextBoundaryMs(nowMs: number, events: Event[], preheatMs: number): number {
  const boundaries = events
    .flatMap((e) => [e.startMs - preheatMs, e.endMs])
    .filter((b) => b > nowMs)
    .sort((a, b) => a - b);
  return boundaries[0] ?? nowMs + 12 * 3_600_000; // nothing upcoming → hold 12 h
}

/**
 * Recompute the setpoint from the override + calendar, publish it and the 7-day
 * schedule, and persist. Called by the slider (after setting an override) and
 * by the cron. `events` is injected so callers that already fetched the
 * calendar don't fetch twice, and tests don't fetch at all.
 */
export async function refreshHeating(events: Event[], nowMs: number = Date.now()) {
  const { state } = await getHeatingState();
  const active = activeSetpoint(nowMs, events, overrideFrom(state));
  const periods = computeSchedule(nowMs, events);

  await publishSigned('heating', 'kolo/heating/setpoint', { setpointC: active.setpointC, source: active.source });
  await publishSigned('heating', 'kolo/heating/schedule', { periods });

  // Clear a spent override so `source` reflects reality once it lapses.
  const overrideUntil = active.source === 'MANUAL' ? state.overrideUntil : null;
  await prisma.heatingState.update({
    where: { id: SINGLETON },
    data: { setpointC: active.setpointC, source: active.source, overrideUntil },
  });
  return active;
}

/** The slider: set a manual override that holds until the next calendar change, then publish. */
export async function setManualSetpoint(setpointC: number, events: Event[], nowMs: number = Date.now()) {
  const preheatMs = 2 * 3_600_000; // PREHEAT_HOURS; kept local to avoid a config import cycle in tests
  const untilMs = nextBoundaryMs(nowMs, events, preheatMs);
  await prisma.heatingState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, setpointC: clampSetpoint(setpointC), source: 'MANUAL', overrideUntil: new Date(untilMs) },
    update: { setpointC: clampSetpoint(setpointC), source: 'MANUAL', overrideUntil: new Date(untilMs) },
  });
  return refreshHeating(events, nowMs);
}
