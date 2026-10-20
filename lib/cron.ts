import { NextRequest, NextResponse } from 'next/server';

/**
 * Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Reject anything else
 * so the cron endpoints can't be poked by the public. If CRON_SECRET is unset
 * the endpoints are closed entirely rather than open — a missing secret must
 * never mean "no auth".
 */
export function denyNonCron(req: NextRequest): NextResponse | null {
  const secret = process.env.CRON_SECRET?.trim();
  if (!secret) return NextResponse.json({ message: 'CRON_SECRET ei asetettu' }, { status: 503 });
  if (req.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ message: 'Unauthorized' }, { status: 401 });
  }
  return null;
}
