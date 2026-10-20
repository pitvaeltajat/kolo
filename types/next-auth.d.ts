import 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      email: string;
      name?: string | null;
      image?: string | null;
      /** Google-verified hosted domain of the account, or null for a personal Gmail. */
      hd?: string | null;
    };
  }
}

// Augmented on `@auth/core/jwt`, not `next-auth/jwt` — the latter is a bare
// re-export TypeScript refuses to augment (see the long note in klapi/lib/auth.ts).
declare module '@auth/core/jwt' {
  interface JWT {
    hd?: string | null;
  }
}
