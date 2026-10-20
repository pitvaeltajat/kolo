import { requireAccess } from '@/lib/authz';
import { getHeatingState } from '@/lib/heatingControl';
import { DEVICE_SILENT_MS } from '@/lib/config';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Current setpoint + each heater's room temperature and on/off state. */
export async function GET() {
  const { denied } = await requireAccess();
  if (denied) return denied;

  const { state, heaters } = await getHeatingState();
  return NextResponse.json({
    setpointC: state.setpointC,
    source: state.source,
    overrideUntil: state.overrideUntil?.toISOString() ?? null,
    heaters: heaters.map((h) => ({
      id: h.id,
      room: h.room,
      stale: Date.now() - h.updatedAt.getTime() > DEVICE_SILENT_MS,
      ...(h.state as Record<string, unknown>), // { relay, tempC, powerW }
    })),
  });
}
