'use client';

import { signIn } from 'next-auth/react';
import { useState } from 'react';

/**
 * Finnish sign-in page (Auth.js points its errors here too). Google is the real
 * entry; the dev-login field only renders outside production and only works when
 * ENABLE_DEV_LOGIN=true server-side.
 */
export default function Login() {
  const isDev = process.env.NODE_ENV !== 'production';
  const [email, setEmail] = useState('');

  return (
    <div className="mx-auto mt-16 flex max-w-sm flex-col gap-6 text-center">
      <h1 className="text-2xl font-semibold">Kolo</h1>
      <p className="text-muted">Kirjaudu PitVan tilillä avataksesi oven ja säätääksesi lämmitystä.</p>

      <button
        onClick={() => signIn('google', { callbackUrl: '/' })}
        className="rounded-xl bg-accent px-6 py-3 font-semibold text-accent-fg"
      >
        Kirjaudu Google-tilillä
      </button>

      {isDev && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            signIn('dev-login', { email, callbackUrl: '/' });
          }}
          className="flex flex-col gap-2 border-t border-border pt-4"
        >
          <span className="text-xs uppercase tracking-wide text-muted">Kehityskirjautuminen</span>
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="sähköposti"
            className="rounded-lg border border-border bg-bg px-3 py-2"
          />
          <button type="submit" className="rounded-lg border border-border px-4 py-2">
            Kirjaudu kehitystilassa
          </button>
        </form>
      )}
    </div>
  );
}
