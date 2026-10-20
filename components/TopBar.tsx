'use client';

import { signOut, useSession } from 'next-auth/react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { Moon, Sun, LogOut, LayoutGrid } from 'lucide-react';

/** Slim header: title, link back to the atk.pitva.fi hub, theme toggle, sign out. */
export default function TopBar() {
  const { data: session } = useSession();
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <header className="sticky top-0 z-10 border-b border-border bg-surface/80 backdrop-blur">
      <div className="mx-auto flex max-w-xl items-center gap-3 px-4 py-3">
        <Link href="/" className="font-semibold tracking-tight">
          Kolo
        </Link>
        <div className="flex-1" />
        <a
          href="https://atk.pitva.fi"
          className="rounded-md p-2 text-muted hover:text-text"
          title="PitVan palvelut"
        >
          <LayoutGrid size={18} />
        </a>
        <button
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          className="rounded-md p-2 text-muted hover:text-text"
          title="Vaihda teema"
        >
          {resolvedTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        {session?.user && (
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="rounded-md p-2 text-muted hover:text-text"
            title="Kirjaudu ulos"
          >
            <LogOut size={18} />
          </button>
        )}
      </div>
    </header>
  );
}
