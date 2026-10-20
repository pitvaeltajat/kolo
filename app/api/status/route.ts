import { requireAccess } from '@/lib/authz';
import prisma from '@/lib/prisma';
import { DEVICE_SILENT_MS } from '@/lib/config';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Last reported door state, for the status line under the unlock button. */
export async function GET() {
  const { denied } = await requireAccess();
  if (denied) return denied;

  const door = await prisma.device.findUnique({ where: { id: 'door' } });
  if (!door) return NextResponse.json({ known: false });

  const stale = Date.now() - door.updatedAt.getTime() > DEVICE_SILENT_MS;
  return NextResponse.json({
    known: true,
    stale,
    updatedAt: door.updatedAt.toISOString(),
    ...(door.state as Record<string, unknown>), // { locked, doorOpen, battery }
  });
}
