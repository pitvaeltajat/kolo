import { requireAdmin } from '@/lib/authz';
import prisma from '@/lib/prisma';
import { pushAllowlist } from '@/lib/allowlist';
import { NextRequest, NextResponse } from 'next/server';
import { ACCESS_GROUP } from '@/lib/config';
import { listMembers } from '@/lib/directory';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Group users with their current key assignment — for the admin table. */
export async function GET() {
  const { denied } = await requireAdmin();
  if (denied) return denied;
  const tags = await prisma.tag.findMany({ orderBy: { createdAt: 'desc' } });
  const members = ACCESS_GROUP ? await listMembers() : [];
  const emails = [...new Set([...members, ...tags.map((tag) => tag.memberEmail)])].sort();
  const users = emails.map((email) => ({
    email,
    name: tags.find((tag) => tag.memberEmail === email && tag.memberName)?.memberName ?? null,
    key: tags.find((tag) => tag.memberEmail === email && tag.active) ?? null,
    previousKeys: tags.filter((tag) => tag.memberEmail === email && !tag.active),
  }));
  return NextResponse.json({ users, tags });
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

  let tag;
  try {
    tag = await prisma.tag.create({
      data: {
        uid,
        memberEmail,
        memberName: typeof body?.memberName === 'string' ? body.memberName : null,
        label: typeof body?.label === 'string' ? body.label : null,
      },
    });
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'P2002') {
      return NextResponse.json({ message: 'Henkilöllä on jo aktiivinen avain — siirrä tai mitätöi se ensin' }, { status: 409 });
    }
    throw err;
  }
  await pushAllowlist().catch((e) => console.error('[kolo] allowlist push after tag create failed:', e));
  return NextResponse.json({ tag }, { status: 201 });
}
