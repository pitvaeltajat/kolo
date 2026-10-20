import { requireAdmin } from '@/lib/authz';
import prisma from '@/lib/prisma';
import { pushAllowlist } from '@/lib/allowlist';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** All tags, newest first — for the admin table. */
export async function GET() {
  const { denied } = await requireAdmin();
  if (denied) return denied;
  const tags = await prisma.tag.findMany({ orderBy: { createdAt: 'desc' } });
  return NextResponse.json({ tags });
}

/** Register a tag by UID (manual entry; see /api/tags/enroll for on-reader enrolment). */
export async function POST(req: NextRequest) {
  const { denied } = await requireAdmin();
  if (denied) return denied;

  const body = await req.json().catch(() => null);
  const uid = typeof body?.uid === 'string' ? body.uid.trim().toLowerCase() : '';
  const memberEmail = typeof body?.memberEmail === 'string' ? body.memberEmail.trim().toLowerCase() : '';
  if (!/^[0-9a-f]{8,32}$/.test(uid) || !memberEmail) {
    return NextResponse.json({ message: 'uid ja memberEmail vaaditaan' }, { status: 400 });
  }

  const tag = await prisma.tag.create({
    data: {
      uid,
      memberEmail,
      memberName: typeof body?.memberName === 'string' ? body.memberName : null,
      label: typeof body?.label === 'string' ? body.label : null,
    },
  });
  await pushAllowlist().catch((e) => console.error('[kolo] allowlist push after tag create failed:', e));
  return NextResponse.json({ tag }, { status: 201 });
}
