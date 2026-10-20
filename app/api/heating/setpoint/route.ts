import { requireAccess } from '@/lib/authz';
import { setManualSetpoint } from '@/lib/heatingControl';
import { upcomingEvents } from '@/lib/calendar';
import { SETPOINT_MIN_C, SETPOINT_MAX_C } from '@/lib/config';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** The slider: set a manual setpoint. Holds until the next calendar change, then the schedule resumes. */
export async function POST(req: NextRequest) {
  const { denied } = await requireAccess();
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const setpointC = Number(body?.setpointC);
  if (!Number.isFinite(setpointC) || setpointC < SETPOINT_MIN_C || setpointC > SETPOINT_MAX_C) {
    return NextResponse.json({ message: `setpointC ${SETPOINT_MIN_C}–${SETPOINT_MAX_C}` }, { status: 400 });
  }

  // A calendar failure shouldn't block a manual change — fall back to no events
  // (override then just holds 12 h, see heatingControl).
  const events = await upcomingEvents().catch(() => []);
  try {
    const active = await setManualSetpoint(setpointC, events);
    return NextResponse.json({ ok: true, ...active });
  } catch (err) {
    return NextResponse.json({ message: err instanceof Error ? err.message : 'virhe' }, { status: 502 });
  }
}
