import { readInbound } from '@/lib/inbound';
import { recordDoorEvent } from '@/lib/doorlog';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * The door controller reports an event it handled on its own — a tag tap, a PIN
 * entry, a manual turn (HMAC-signed, queued and flushed when it reconnects).
 * These are the events the Vercel app didn't originate but still owns the audit
 * trail for.
 */
const METHODS = new Set(['TAG', 'PIN', 'MANUAL', 'PHONE']);
const ACTIONS = new Set(['UNLOCK', 'LOCK']);
const RESULTS = new Set(['OK', 'FAIL', 'DENIED']);

export async function POST(req: NextRequest) {
  const raw = await req.json().catch(() => null);
  const r = await readInbound(raw);
  if (!r.ok) return NextResponse.json({ message: r.reason }, { status: r.status });

  const b = r.value.body;
  const method = String(b.method ?? '');
  const action = String(b.action ?? '');
  const result = String(b.result ?? '');
  if (!METHODS.has(method) || !ACTIONS.has(action) || !RESULTS.has(result)) {
    return NextResponse.json({ message: 'bad-event' }, { status: 400 });
  }

  await recordDoorEvent({
    method: method as 'TAG' | 'PIN' | 'MANUAL' | 'PHONE',
    action: action as 'UNLOCK' | 'LOCK',
    result: result as 'OK' | 'FAIL' | 'DENIED',
    memberEmail: typeof b.member === 'string' ? b.member : null,
    detail: typeof b.detail === 'string' ? b.detail : null,
  });
  return NextResponse.json({ ok: true });
}
