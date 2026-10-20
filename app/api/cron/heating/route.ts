import { denyNonCron } from '@/lib/cron';
import { refreshHeating } from '@/lib/heatingControl';
import { upcomingEvents } from '@/lib/calendar';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Every 15 min: read the calendar, recompute the setpoint, push setpoint + 7-day schedule. */
export async function GET(req: NextRequest) {
  const bad = denyNonCron(req);
  if (bad) return bad;
  const events = await upcomingEvents();
  const active = await refreshHeating(events);
  return NextResponse.json({ ok: true, ...active });
}
