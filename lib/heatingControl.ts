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
  const heaters = await prisma.device.findMany({ where: { kind: { in: ['HEATER', 'SENSOR'] } }, orderBy: { id: 'asc' } });
  return { state, heaters };
}

function overrideFrom(state: { boostUntil: Date | null }): Override | null {
  return state.boostUntil ? { untilMs: state.boostUntil.getTime() } : null;
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

  const areaSetpoints = (state.areaSetpoints as Record<string, number>) ?? {};
  await publishSigned('heating', 'kolo/heating/setpoint', { setpointC: active.setpointC, source: active.source, areaSetpoints });
  await publishSigned('heating', 'kolo/heating/schedule', { periods });

  // Clear a spent override so `source` reflects reality once it lapses.
  const boostUntil = active.source === 'BOOST' ? state.boostUntil : null;
  await prisma.heatingState.update({
    where: { id: SINGLETON },
    data: { setpointC: active.setpointC, source: active.source, boostUntil, overrideUntil: null },
  });
  return active;
}

/** Admin-only area setpoint. It is stored separately for downstairs/upstairs. */
export async function setAreaSetpoint(area: string, setpointC: number, events: Event[], nowMs: number = Date.now()) {
  if (!['downstairs', 'upstairs'].includes(area)) throw new Error('Tuntematon lämmitysalue');
  const current = await getHeatingState();
  const areaSetpoints = { ...((current.state.areaSetpoints as Record<string, number>) ?? {}), [area]: clampSetpoint(setpointC) };
  await prisma.heatingState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, areaSetpoints },
    update: { areaSetpoints },
  });
  return refreshHeating(events, nowMs);
}

/** All-user boost: comfort temperature immediately for three hours. */
export async function startHeatingBoost(events: Event[], nowMs: number = Date.now()) {
  const until = new Date(nowMs + 3 * 3_600_000);
  await prisma.heatingState.upsert({
    where: { id: SINGLETON },
    create: { id: SINGLETON, setpointC: 20, source: 'BOOST', boostUntil: until },
    update: { setpointC: 20, source: 'BOOST', boostUntil: until },
  });
  return refreshHeating(events, nowMs);
}
