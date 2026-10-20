import { getGoogleAccessToken } from './googleAuth';
import { ACCESS_GROUP, DIRECTORY_SUBJECT, requireEnv } from './config';

/**
 * Google Group membership is kolo's whole authorisation model: in the group →
 * you can open the door and set the heating; out of it → you can't, and your
 * tags drop off the next allowlist push. Checked live against the Admin SDK
 * Directory API with a domain-wide-delegated service account.
 */

const SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member.readonly';

function subject(): string {
  // Must be a real admin in the domain; the SA impersonates them to read the directory.
  return DIRECTORY_SUBJECT ?? requireEnv('GOOGLE_DIRECTORY_SUBJECT');
}

function group(): string {
  if (!ACCESS_GROUP) throw new Error('ACCESS_GROUP is not set');
  return ACCESS_GROUP;
}

/** Is this email a member of the access group? `hasMember` also follows nesting. */
export async function isMember(email: string): Promise<boolean> {
  const token = await getGoogleAccessToken([SCOPE], subject());
  const url = `https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group())}/hasMember/${encodeURIComponent(email)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Directory hasMember failed (${res.status})`);
  const body = (await res.json()) as { isMember?: boolean };
  return body.isMember === true;
}

export type GroupMember = { email: string; name?: string };

/** Every active member of the group, for building the reader's tag allowlist. */
export async function listMembers(): Promise<string[]> {
  const token = await getGoogleAccessToken([SCOPE], subject());
  const emails: string[] = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`https://admin.googleapis.com/admin/directory/v1/groups/${encodeURIComponent(group())}/members`);
    url.searchParams.set('maxResults', '200');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Directory members.list failed (${res.status})`);
    const body = (await res.json()) as {
      members?: { email?: string; status?: string }[];
      nextPageToken?: string;
    };
    for (const m of body.members ?? []) {
      if (m.email && m.status === 'ACTIVE') emails.push(m.email.toLowerCase());
    }
    pageToken = body.nextPageToken;
  } while (pageToken);
  return emails;
}
