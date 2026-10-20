import { requireAdmin } from '@/lib/authz';
import prisma from '@/lib/prisma';
import { pushAllowlist } from '@/lib/allowlist';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Revoke a tag (soft: mark inactive, keep the audit trail), then re-push the allowlist. */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { denied } = await requireAdmin();
  if (denied) return denied;

  const { id } = await params;
  await prisma.tag.update({ where: { id }, data: { active: false, revokedAt: new Date() } });
  await pushAllowlist().catch((e) => console.error('[kolo] allowlist push after revoke failed:', e));
  return NextResponse.json({ ok: true });
}
