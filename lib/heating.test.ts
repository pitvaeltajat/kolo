import { describe, it, expect } from 'vitest';
import { activeSetpoint, computeSchedule } from './heating';
import { COMFORT_C, IDLE_C } from './config';

const H = 3_600_000;
const T0 = Date.parse('2026-10-20T00:00:00Z');

describe('activeSetpoint', () => {
  it('an unexpired three-hour boost wins over the calendar', () => {
    const r = activeSetpoint(T0, [{ startMs: T0, endMs: T0 + H }], { setpointC: 18, untilMs: T0 + H });
    expect(r).toEqual({ setpointC: COMFORT_C, source: 'BOOST' });
  });

  it('a lapsed override falls back to the calendar', () => {
    const events = [{ startMs: T0 + 10 * H, endMs: T0 + 12 * H }];
    const r = activeSetpoint(T0, events, { setpointC: 18, untilMs: T0 - H });
    expect(r.source).not.toBe('BOOST');
  });

  it('heats during the pre-heat window before an event', () => {
    const event = { startMs: T0 + 2 * H, endMs: T0 + 4 * H };
    // 2 h of preheat → heating starts exactly at T0.
    expect(activeSetpoint(T0, [event], null)).toEqual({ setpointC: COMFORT_C, source: 'CALENDAR' });
    // 3 h before the event is still outside the window.
    expect(activeSetpoint(T0 - H, [event], null)).toEqual({ setpointC: IDLE_C, source: 'DEFAULT' });
  });

  it('is idle with no events', () => {
    expect(activeSetpoint(T0, [], null)).toEqual({ setpointC: IDLE_C, source: 'DEFAULT' });
  });

  it('starts an immediate boost at comfort temperature', () => {
    expect(activeSetpoint(T0, [], { setpointC: 99, untilMs: T0 + H })).toEqual({ setpointC: COMFORT_C, source: 'BOOST' });
  });
});

describe('computeSchedule', () => {
  it('turns each event into a preheat→end comfort window', () => {
    const periods = computeSchedule(T0, [{ startMs: T0 + 5 * H, endMs: T0 + 7 * H }]);
    expect(periods).toEqual([{ startMs: T0 + 3 * H, endMs: T0 + 7 * H, setpointC: COMFORT_C }]);
  });

  it('merges overlapping windows', () => {
    const periods = computeSchedule(T0, [
      { startMs: T0 + 5 * H, endMs: T0 + 7 * H },
      { startMs: T0 + 8 * H, endMs: T0 + 9 * H }, // preheat (−2h) = T0+6h, overlaps previous end T0+7h
    ]);
    expect(periods).toHaveLength(1);
    expect(periods[0].endMs).toBe(T0 + 9 * H);
  });

  it('drops events in the past and beyond the horizon', () => {
    const periods = computeSchedule(T0, [
      { startMs: T0 - 5 * H, endMs: T0 - 4 * H }, // past
      { startMs: T0 + 40 * 24 * H, endMs: T0 + 40 * 24 * H + H }, // > 7 days out
    ]);
    expect(periods).toEqual([]);
  });
});
