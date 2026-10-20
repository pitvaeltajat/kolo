import { denyNonCron } from '@/lib/cron';
import { pushAllowlist } from '@/lib/allowlist';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Periodically re-push the allowlist so group removals take effect without an admin edit. */
export async function GET(req: NextRequest) {
  const bad = denyNonCron(req);
  if (bad) return bad;
  const count = await pushAllowlist();
  return NextResponse.json({ ok: true, count });
}
