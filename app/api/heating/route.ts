import { requireAccess, requireAdmin } from '@/lib/authz';
import { getHeatingState } from '@/lib/heatingControl';
import { DEVICE_SILENT_MS } from '@/lib/config';
import { upcomingEvents } from '@/lib/calendar';
import { computeSchedule } from '@/lib/heating';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type HeatingRoom = {
  id: string;
  kind: string;
  room: string | null;
  controlGroup: string | null;
  stale: boolean;
  tempC?: unknown;
  powerW?: unknown;
  relay?: unknown;
  channels?: unknown;
};

type HeatingChannel = { id: string | number; label?: string; relay?: boolean; powerW?: number };

/** Current setpoint + each heater's room temperature and on/off state. */
export async function GET() {
  const { denied } = await requireAccess();
  if (denied) return denied;
  const admin = await requireAdmin();

  const { state, heaters } = await getHeatingState();
  const events = await upcomingEvents().catch(() => []);
  const rooms: HeatingRoom[] = heaters.map((h) => ({
    id: h.id,
    kind: h.kind,
    room: h.room,
    controlGroup: h.controlGroup,
    stale: Date.now() - h.updatedAt.getTime() > DEVICE_SILENT_MS,
    ...(h.state as Record<string, unknown>),
  }));
  const groups = [
    { id: 'downstairs', label: 'Alakerta · Shelly Pro 3' },
    { id: 'upstairs', label: 'Yläkerta · 2 patteria' },
  ].map((group) => {
    const members = rooms.filter((h) => h.controlGroup === group.id || (!h.controlGroup && (group.id === 'upstairs' ? h.room?.toLowerCase().includes('ylä') : true)));
    const temps = members.map((h) => h.tempC).filter((v): v is number => typeof v === 'number');
    const powers = members.map((h) => h.powerW).filter((v): v is number => typeof v === 'number');
    const channels = members.flatMap((h) => Array.isArray(h.channels) ? h.channels : []).filter((c): c is HeatingChannel => !!c && typeof c === 'object' && 'id' in c);
    const relays = channels.length ? channels.filter((c) => c.relay === true).length : members.filter((h) => h.relay === true).length;
    return {
      ...group,
      stale: members.length === 0 || members.every((h) => h.stale),
      tempC: temps.length ? temps.reduce((a, b) => a + b, 0) / temps.length : null,
      relayOn: relays > 0,
      activeDevices: relays,
      powerW: powers.length ? powers.reduce((a, b) => a + b, 0) : null,
      channels,
    };
  });
  return NextResponse.json({
    setpointC: state.setpointC,
    source: state.source,
    isAdmin: !admin.denied,
    areaSetpoints: state.areaSetpoints,
    boostUntil: state.boostUntil?.toISOString() ?? null,
    calendarEvents: events.map((e) => ({ ...e, start: new Date(e.startMs).toISOString(), end: new Date(e.endMs).toISOString() })),
    plan: computeSchedule(Date.now(), events).map((p) => ({ ...p, start: new Date(p.startMs).toISOString(), end: new Date(p.endMs).toISOString() })),
    groups,
    rooms,
  });
}
