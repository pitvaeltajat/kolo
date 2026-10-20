import { createSign } from 'node:crypto';
import { requireEnv } from './config';

/**
 * Service-account auth for the Google APIs kolo talks to unattended: the
 * Directory API (is this email in the access group?), Sheets (door log) and
 * Calendar (heating schedule). Every token impersonates a real person in the
 * domain — domain-wide delegation — because that is the only Google flow that
 * works with no signed-in user. Lifted from klapi/utils/googleAuth.ts.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';

type ServiceAccountKey = { client_email: string; private_key: string };

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Accepts the raw JSON Google hands you or a base64 blob of it (base64 survives a Vercel env paste). */
function loadServiceAccountKey(): ServiceAccountKey {
  const raw = requireEnv('GOOGLE_WORKSPACE_SA_KEY').trim();
  const json = raw.startsWith('{') ? raw : Buffer.from(raw, 'base64').toString('utf8');
  let parsed: Partial<ServiceAccountKey>;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new Error('GOOGLE_WORKSPACE_SA_KEY is not valid JSON (raw or base64-encoded)');
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error('GOOGLE_WORKSPACE_SA_KEY is missing client_email or private_key');
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

export async function getGoogleAccessToken(scopes: string[], subject: string): Promise<string> {
  const key = loadServiceAccountKey();
  const iat = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64url(
    JSON.stringify({ iss: key.client_email, sub: subject, scope: scopes.join(' '), aud: TOKEN_URL, iat, exp: iat + 3600 }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const assertion = `${header}.${claims}.${base64url(signer.sign(key.private_key))}`;

  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  const body = (await res.json()) as { access_token?: string; error_description?: string };
  if (!res.ok || !body.access_token) {
    // `unauthorized_client` almost always means the scopes aren't authorised
    // for this SA's client id in the Admin console.
    throw new Error(`Google token exchange failed (${res.status}): ${body.error_description ?? 'unknown'}`);
  }
  return body.access_token;
}
