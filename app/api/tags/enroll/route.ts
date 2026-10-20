import { requireAdmin } from '@/lib/authz';
import prisma from '@/lib/prisma';
import { command } from '@/lib/mqtt';
import { pushAllowlist } from '@/lib/allowlist';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Enrol the next blank tag on the reader: tell the ESP32 to program the next
 * tap and report its UID back in the ack (PLAN.md "Enrol mode"). The admin taps
 * a fob within the ack window; we store it and re-push the allowlist.
 */
export async function POST(req: NextRequest) {
  const { denied } = await requireAdmin();
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const memberEmail = typeof body?.memberEmail === 'string' ? body.memberEmail.trim().toLowerCase() : '';
  if (!memberEmail) return NextResponse.json({ message: 'memberEmail vaaditaan' }, { status: 400 });

  let result;
  try {
    result = await command('door', 'enroll', { member: memberEmail });
  } catch (err) {
    return NextResponse.json({ message: err instanceof Error ? err.message : 'virhe' }, { status: 502 });
  }
  if (!result.ok) return NextResponse.json({ message: result.reason }, { status: 502 });

  const uid = (result.detail ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{8,32}$/.test(uid)) {
    return NextResponse.json({ message: 'lukija ei palauttanut kelvollista UID:ta' }, { status: 502 });
  }

  const tag = await prisma.tag.upsert({
    where: { uid },
    create: { uid, memberEmail, memberName: typeof body?.memberName === 'string' ? body.memberName : null },
    update: { memberEmail, active: true, revokedAt: null },
  });
  await pushAllowlist().catch((e) => console.error('[kolo] allowlist push after enroll failed:', e));
  return NextResponse.json({ tag }, { status: 201 });
}
