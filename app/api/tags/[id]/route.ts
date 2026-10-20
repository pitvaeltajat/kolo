import { requireAdmin } from '@/lib/authz';
import prisma from '@/lib/prisma';
import { pushAllowlist } from '@/lib/allowlist';
import { NextResponse } from 'next/server';
import { NextRequest } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Move an active physical key to another person. The target must not already
 * have an active key; the operation changes the owner of this one key and
 * leaves the UID/audit history intact. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { denied } = await requireAdmin();
  if (denied) return denied;
  const { id } = await params;
  const body = await req.json().catch(() => null);
  const memberEmail = typeof body?.memberEmail === 'string' ? body.memberEmail.trim().toLowerCase() : '';
  if (!memberEmail || !memberEmail.includes('@')) {
    return NextResponse.json({ message: 'Uuden henkilön sähköposti vaaditaan' }, { status: 400 });
  }
  const current = await prisma.tag.findUnique({ where: { id } });
  if (!current?.active) return NextResponse.json({ message: 'Vain aktiivisen avaimen voi siirtää' }, { status: 409 });
  const target = await prisma.tag.findFirst({ where: { memberEmail, active: true, NOT: { id } } });
  if (target) return NextResponse.json({ message: 'Kohdehenkilöllä on jo aktiivinen avain' }, { status: 409 });
  const tag = await prisma.tag.update({ where: { id }, data: { memberEmail, memberName: typeof body?.memberName === 'string' ? body.memberName : current.memberName } });
  await pushAllowlist().catch((e) => console.error('[kolo] allowlist push after key move failed:', e));
  return NextResponse.json({ tag });
}

/** Revoke a tag (soft: mark inactive, keep the audit trail), then re-push the allowlist. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { denied } = await requireAdmin();
  if (denied) return denied;

  const { id } = await params;
  await prisma.tag.update({ where: { id }, data: { active: false, revokedAt: new Date() } });
  await pushAllowlist().catch((e) => console.error('[kolo] allowlist push after revoke failed:', e));
  return NextResponse.json({ ok: true });
}
