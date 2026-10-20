import prisma from '@/lib/prisma';
import { readInbound } from '@/lib/inbound';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * A device reports its current state (HMAC-signed). Door: { locked, doorOpen,
 * battery }. Heater Shelly: { relay, tempC, powerW }. The whole signed body
 * (minus the envelope meta) is stored as the device's latest state.
 */
export async function POST(req: NextRequest) {
  const raw = await req.json().catch(() => null);
  const r = await readInbound(raw);
  if (!r.ok) return NextResponse.json({ message: r.reason }, { status: r.status });

  const { device, body } = r.value;
  const { kind, room, controlGroup, ts: _ts, nonce: _nonce, device: _d, ...state } = body;

  await prisma.device.upsert({
    where: { id: device },
    create: {
      id: device,
      kind: typeof kind === 'string' ? kind : 'DOOR',
      room: typeof room === 'string' ? room : null,
      controlGroup: typeof controlGroup === 'string' ? controlGroup : null,
      state,
    },
    update: {
      state,
      ...(typeof room === 'string' ? { room } : {}),
      ...(typeof controlGroup === 'string' ? { controlGroup } : {}),
    },
  });

  return NextResponse.json({ ok: true });
}
