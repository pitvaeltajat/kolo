import { NextResponse } from 'next/server';
import { auth } from './auth';
import { isMember } from './directory';
import { ACCESS_GROUP, ADMIN_EMAILS, WORKSPACE_DOMAIN } from './config';

/**
 * Route guards. Authorisation is: signed in, in the Workspace domain, and a
 * member of the access group. Admin ops (tag/device management) additionally
 * require the email to be in ADMIN_EMAILS — unless that list is empty, in which
 * case every member may, since the troop runs a single shared group.
 */

export type Caller = { email: string; name: string | null };
type Guard = { caller: Caller; denied: null } | { caller: null; denied: NextResponse };

const deny = (status: number, message: string): Guard => ({
  caller: null,
  denied: NextResponse.json({ message }, { status }),
});

function inDomain(email: string): boolean {
  if (!WORKSPACE_DOMAIN) return true; // unset (local/preview): don't gate on domain
  return email.toLowerCase().endsWith(`@${WORKSPACE_DOMAIN.toLowerCase()}`);
}

/** Any member of the access group. */
export async function requireAccess(): Promise<Guard> {
  const session = await auth();
  const email = session?.user?.email;
  if (!email) return deny(401, 'Kirjaudu sisään');
  if (!inDomain(email)) return deny(403, 'Vain PitVan tilillä');

  // ACCESS_GROUP unset means no group configured yet; in that case a signed-in
  // domain user is allowed, so local/preview deploys work before the group
  // exists. Set ACCESS_GROUP in production to actually gate on membership.
  if (ACCESS_GROUP && !(await isMember(email))) {
    return deny(403, 'Sinulla ei ole oven käyttöoikeutta');
  }
  return { caller: { email, name: session.user.name ?? null }, denied: null };
}

/** A member who may administer tags and devices. */
export async function requireAdmin(): Promise<Guard> {
  const guard = await requireAccess();
  if (guard.denied) return guard;
  if (ADMIN_EMAILS.length > 0 && !ADMIN_EMAILS.includes(guard.caller.email.toLowerCase())) {
    return deny(403, 'Vain ylläpitäjälle');
  }
  return guard;
}
