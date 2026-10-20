import prisma from './prisma';
import { listMembers } from './directory';
import { publishSigned } from './mqtt';
import { ACCESS_GROUP } from './config';

/**
 * The reader's offline allowlist: which tag UIDs may open the door. A tag only
 * counts if it is active AND its owner is still in the access group, so
 * removing someone from the group drops their tags on the next push — the group
 * is the single source of truth (PLAN.md). The ESP32 caches the last list in
 * NVS and keeps working through an internet outage.
 */

export type AllowEntry = { uid: string; member: string };

export async function buildAllowlist(): Promise<AllowEntry[]> {
  const tags = await prisma.tag.findMany({ where: { active: true } });
  // Without a group configured we can't check membership, so trust the active
  // tags as-is (local/preview). Production sets ACCESS_GROUP.
  if (!ACCESS_GROUP) return tags.map((t) => ({ uid: t.uid, member: t.memberEmail }));

  const members = new Set(await listMembers());
  return tags
    .filter((t) => members.has(t.memberEmail.toLowerCase()))
    .map((t) => ({ uid: t.uid, member: t.memberEmail }));
}

/** Build and publish the signed allowlist to the door reader. */
export async function pushAllowlist(): Promise<number> {
  const entries = await buildAllowlist();
  await publishSigned('door', 'kolo/door/allowlist', { entries, count: entries.length });
  return entries.length;
}
