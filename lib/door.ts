import { command } from './mqtt';
import { recordDoorEvent } from './doorlog';
import type { Caller } from './authz';

/**
 * Open or close the door for a signed-in member: send the signed command, wait
 * for the lock's ack, and log the outcome either way. Returns a short Finnish
 * message for the UI toast.
 */
export async function operateDoor(
  action: 'UNLOCK' | 'LOCK',
  caller: Caller,
): Promise<{ status: number; ok: boolean; message: string }> {
  let result: Awaited<ReturnType<typeof command>>;
  try {
    result = await command('door', action.toLowerCase());
  } catch (err) {
    // Transport not configured / broker unreachable — a real failure, logged as one.
    const reason = err instanceof Error ? err.message : 'tuntematon virhe';
    await recordDoorEvent({ ...who(caller), method: 'PHONE', action, result: 'FAIL', detail: reason });
    return { status: 502, ok: false, message: `Ovea ei tavoitettu: ${reason}` };
  }

  await recordDoorEvent({
    ...who(caller),
    method: 'PHONE',
    action,
    result: result.ok ? 'OK' : 'FAIL',
    detail: result.ok ? (result.detail ?? null) : result.reason,
  });

  if (result.ok) return { status: 200, ok: true, message: action === 'UNLOCK' ? 'Ovi auki' : 'Ovi lukittu' };
  return { status: 502, ok: false, message: result.reason };
}

function who(caller: Caller) {
  return { memberEmail: caller.email, memberName: caller.name };
}
