import { requireAdmin } from '@/lib/authz';
import { setAreaSetpoint } from '@/lib/heatingControl';
import { upcomingEvents } from '@/lib/calendar';
import { SETPOINT_MIN_C, SETPOINT_MAX_C } from '@/lib/config';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Admin-only per-area setpoint. There is no general manual slider anymore. */
export async function POST(req: NextRequest) {
  const { denied } = await requireAdmin();
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const area = typeof body?.area === 'string' ? body.area : '';
  const setpointC = Number(body?.setpointC);
  if (!Number.isFinite(setpointC) || setpointC < SETPOINT_MIN_C || setpointC > SETPOINT_MAX_C) {
    return NextResponse.json({ message: `setpointC ${SETPOINT_MIN_C}–${SETPOINT_MAX_C}` }, { status: 400 });
  }

  const events = await upcomingEvents().catch(() => []);
  try {
    const active = await setAreaSetpoint(area, setpointC, events);
    return NextResponse.json({ ok: true, ...active });
  } catch (err) {
    return NextResponse.json({ message: err instanceof Error ? err.message : 'virhe' }, { status: 502 });
  }
}
