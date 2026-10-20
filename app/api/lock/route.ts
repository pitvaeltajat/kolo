import { requireAccess } from '@/lib/authz';
import { operateDoor } from '@/lib/door';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST() {
  const { caller, denied } = await requireAccess();
  if (denied) return denied;
  const r = await operateDoor('LOCK', caller);
  return NextResponse.json({ ok: r.ok, message: r.message }, { status: r.status });
}
