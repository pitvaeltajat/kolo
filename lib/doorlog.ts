import prisma from './prisma';
import { appendDoorLog } from './sheets';

export type DoorEventInput = {
  memberEmail?: string | null;
  memberName?: string | null;
  method: 'PHONE' | 'TAG' | 'PIN' | 'MANUAL';
  action: 'UNLOCK' | 'LOCK';
  result: 'OK' | 'FAIL' | 'DENIED';
  detail?: string | null;
};

/** Record a door event: DB is authoritative, the Sheet is a best-effort mirror. */
export async function recordDoorEvent(e: DoorEventInput): Promise<void> {
  const row = await prisma.doorEvent.create({ data: e });
  try {
    await appendDoorLog([
      row.at.toISOString(),
      e.memberName ?? e.memberEmail ?? '',
      e.method,
      e.action,
      e.result,
      e.detail ?? '',
    ]);
  } catch (err) {
    console.error('[kolo] door log sheet mirror failed:', err);
  }
}
