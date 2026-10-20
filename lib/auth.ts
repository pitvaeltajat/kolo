import NextAuth, { type NextAuthConfig } from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { WORKSPACE_DOMAIN, optionalEnv } from './config';

/**
 * kolo's sign-in. It is deliberately database-free: identity comes from the
 * pitva.fi session cookie and authorisation from Google Group membership
 * (lib/authz.ts), so there is no user table to keep. The cookie config below is
 * copied bit-for-bit from klapi so one sign-in covers klapi, budu and kolo —
 * the secret and the cookie NAME must match across the apps or none can read
 * another's cookie (@auth/core salts the JWE key with the cookie name).
 */

const COOKIE_DOMAIN = optionalEnv('AUTH_COOKIE_DOMAIN');

/** Password-free local sign-in, gated like klapi's: never in production, and only on explicit opt-in. */
const devLoginEnabled = () => process.env.NODE_ENV !== 'production' && process.env.ENABLE_DEV_LOGIN === 'true';

const devLogin = Credentials({
  id: 'dev-login',
  name: 'Kehityskirjautuminen',
  credentials: { email: { label: 'Email', type: 'text' } },
  async authorize(credentials) {
    if (!devLoginEnabled()) return null;
    const email = typeof credentials?.email === 'string' ? credentials.email.trim() : '';
    if (!email) return null;
    return { email, name: email.split('@')[0] };
  },
});

if (devLoginEnabled()) {
  console.warn('[kolo] Kehityskirjautuminen on päällä: kuka tahansa voi kirjautua ilman salasanaa.');
}

export const authConfig: NextAuthConfig = {
  secret: process.env.NEXTAUTH_SECRET,
  ...(COOKIE_DOMAIN
    ? {
        cookies: {
          sessionToken: {
            name: '__Secure-pitva.session-token',
            options: { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: true, domain: COOKIE_DOMAIN },
          },
          csrfToken: {
            name: '__Host-pitva.csrf-token',
            options: { httpOnly: true, sameSite: 'lax' as const, path: '/', secure: true },
          },
        },
      }
    : {}),
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID ?? '',
      clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
      // `hd` only hints Google's account chooser toward the troop domain; it is
      // not a fence. kolo authorises on group membership, not on this claim.
      ...(WORKSPACE_DOMAIN ? { authorization: { params: { hd: WORKSPACE_DOMAIN } } } : {}),
    }),
    ...(devLoginEnabled() ? [devLogin] : []),
  ],
  callbacks: {
    async jwt({ token, profile }) {
      if (profile && 'hd' in profile) {
        token.hd = typeof profile.hd === 'string' ? profile.hd.trim().toLowerCase() : null;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) session.user.hd = (token.hd as string | null | undefined) ?? null;
      return session;
    },
  },
  session: { strategy: 'jwt' },
  pages: { signIn: '/login', error: '/login' },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);
