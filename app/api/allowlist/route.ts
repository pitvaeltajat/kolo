import { requireAdmin } from '@/lib/authz';
import { pushAllowlist } from '@/lib/allowlist';
import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Manually re-push the tag allowlist to the reader (also runs on a cron and on tag edits). */
export async function POST() {
  const { denied } = await requireAdmin();
  if (denied) return denied;
  try {
    const count = await pushAllowlist();
    return NextResponse.json({ ok: true, count });
  } catch (err) {
    return NextResponse.json({ message: err instanceof Error ? err.message : 'virhe' }, { status: 502 });
  }
}
