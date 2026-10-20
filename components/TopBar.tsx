'use client';

import { signOut, useSession } from 'next-auth/react';
import { useTheme } from 'next-themes';
import Link from 'next/link';
import { Moon, Sun, LogOut, LayoutGrid, KeyRound } from 'lucide-react';

/** Slim header: title, link back to the atk.pitva.fi hub, theme toggle, sign out. */
export default function TopBar() {
  const { data: session } = useSession();
  const { resolvedTheme, setTheme } = useTheme();

  return (
    <header className="topbar">
      <div className="topbar-inner">
        <Link href="/" className="service-brand">
          Kolo
        </Link>
        <div className="flex-1" />
        <a
          href="https://atk.pitva.fi"
          className="topbar-link"
          title="PitVan palvelut"
        >
          <LayoutGrid size={15} />
          ATK
        </a>
        {session?.user && (
          <Link href="/admin" className="topbar-link" title="Avainten hallinta">
            <KeyRound size={15} />
            Avaimet
          </Link>
        )}
        <button
          onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
          className="topbar-icon"
          title="Vaihda teema"
        >
          {resolvedTheme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
        </button>
        {session?.user && (
          <button
            onClick={() => signOut({ callbackUrl: '/login' })}
            className="topbar-icon"
            title="Kirjaudu ulos"
          >
            <LogOut size={18} />
          </button>
        )}
      </div>
    </header>
  );
}
