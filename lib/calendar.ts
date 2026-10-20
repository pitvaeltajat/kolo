import { getGoogleAccessToken } from './googleAuth';
import { SCHEDULE_DAYS, optionalEnv, requireEnv } from './config';
import type { Event } from './heating';

/**
 * Upcoming events from the troop's Google Calendar, which drive the heating
 * schedule (HEATING.md "Setpoint sources"): heat before a booking, idle
 * otherwise. Read-only, impersonating the calendar's owner.
 */

const SCOPE = 'https://www.googleapis.com/auth/calendar.events.readonly';

export async function upcomingEvents(nowMs: number = Date.now()): Promise<Event[]> {
  const calendarId = requireEnv('HEATING_CALENDAR_ID');
  const subject = optionalEnv('HEATING_CALENDAR_SUBJECT') ?? calendarId;
  const token = await getGoogleAccessToken([SCOPE], subject);

  const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`);
  url.searchParams.set('timeMin', new Date(nowMs).toISOString());
  url.searchParams.set('timeMax', new Date(nowMs + SCHEDULE_DAYS * 86_400_000).toISOString());
  url.searchParams.set('singleEvents', 'true');
  url.searchParams.set('orderBy', 'startTime');
  url.searchParams.set('maxResults', '250');

  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Calendar events.list failed (${res.status})`);
  const body = (await res.json()) as {
    items?: { summary?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[];
  };

  const events: Event[] = [];
  for (const item of body.items ?? []) {
    // All-day events (date only) don't mean "occupied all day" for heating — skip them.
    const start = item.start?.dateTime;
    const end = item.end?.dateTime;
    if (!start || !end) continue;
    events.push({ startMs: Date.parse(start), endMs: Date.parse(end), title: item.summary || 'Kalenterivaraus', location: item.location });
  }
  return events;
}
