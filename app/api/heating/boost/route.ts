import { requireAccess } from '@/lib/authz';
import { startHeatingBoost } from '@/lib/heatingControl';
import { upcomingEvents } from '@/lib/calendar';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Any signed-in member may start immediate three-hour heating. */
export async function POST() {
  const { denied } = await requireAccess();
  if (denied) return denied;
  const events = await upcomingEvents().catch(() => []);
  try {
    const active = await startHeatingBoost(events);
    return NextResponse.json({ ok: true, ...active });
  } catch (err) {
    return NextResponse.json({ message: err instanceof Error ? err.message : 'Virhe' }, { status: 502 });
  }
}
