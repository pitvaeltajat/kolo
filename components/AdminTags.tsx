'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { Trash2, RefreshCw, Nfc, Search, UserRound } from 'lucide-react';
import { fetcher, post } from '@/lib/fetcher';

type Tag = {
  id: string;
  uid: string;
  memberEmail: string;
  memberName: string | null;
  label: string | null;
  active: boolean;
  createdAt: string;
};
type User = { email: string; name: string | null; key: Tag | null; previousKeys: Tag[] };

export default function AdminTags() {
  const { data, error, mutate } = useSWR<{ users: User[]; tags: Tag[] }>('/api/tags', fetcher);
  const [email, setEmail] = useState('');
  const [uid, setUid] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [moveTo, setMoveTo] = useState<Record<string, string>>({});
  const [search, setSearch] = useState('');

  async function run(fn: () => Promise<unknown>) {
    setMsg(null);
    try {
      await fn();
      mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Virhe');
    }
  }

  if (error) return <p className="text-danger">{error.message}</p>;

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-2xl border border-border bg-surface p-5">
        <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted">Lisää tunniste</h2>
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="jäsenen sähköposti"
          className="mb-2 w-full rounded-lg border border-border bg-bg px-3 py-2"
        />
        <div className="flex gap-2">
          <button
            onClick={() => run(() => post('/api/tags/enroll', { memberEmail: email }))}
            className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-accent px-4 py-2 font-semibold text-accent-fg"
          >
            <Nfc size={16} /> Lue lukijalta
          </button>
        </div>
        <div className="mt-3 flex gap-2">
          <input
            value={uid}
            onChange={(e) => setUid(e.target.value)}
            placeholder="tai UID käsin"
            className="flex-1 rounded-lg border border-border bg-bg px-3 py-2 font-mono text-sm"
          />
          <button
            onClick={() => run(async () => { await post('/api/tags', { uid, memberEmail: email }); setUid(''); })}
            className="rounded-lg border border-border px-4 py-2"
          >
            Lisää
          </button>
        </div>
        {msg && <p className="mt-2 text-sm text-danger">{msg}</p>}
      </section>

      <section className="rounded-2xl border border-border bg-surface p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Käyttäjät</h2>
            <p className="mt-1 text-xs text-muted">{data?.users.length ?? 0} käyttäjää · yksi aktiivinen avain per henkilö</p>
          </div>
          <button
            onClick={() => run(() => post('/api/allowlist'))}
            className="flex items-center gap-1 text-sm text-muted hover:text-text"
            title="Lähetä sallittujen lista lukijalle"
          >
            <RefreshCw size={14} /> Päivitä lukija
          </button>
        </div>
        <label className="mb-3 flex items-center gap-2 rounded-lg border border-border bg-bg px-3 py-2 text-sm text-muted">
          <Search size={15} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Hae käyttäjiä" className="min-w-0 flex-1 bg-transparent outline-none" />
        </label>
        <ul className="flex flex-col divide-y divide-border">
          {(data?.users ?? []).filter((u) => `${u.name ?? ''} ${u.email}`.toLowerCase().includes(search.toLowerCase())).map((u) => {
            const t = u.key;
            return <li key={u.email} className="flex flex-col gap-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <span className="flex min-w-0 items-center gap-2">
                <UserRound size={16} className="shrink-0 text-muted" />
                <span className="min-w-0"><span className="block truncate font-medium">{u.name ?? u.email}</span>{u.name && <span className="block truncate text-xs text-muted">{u.email}</span>}</span>
              </span>
              {t ? <div className="flex flex-wrap items-center gap-2">
                <span className="rounded bg-bg px-2 py-1 font-mono text-xs">{t.uid}</span>
                <div className="flex items-center gap-2">
                  <input
                    value={moveTo[t.id] ?? ''}
                    onChange={(e) => setMoveTo((v) => ({ ...v, [t.id]: e.target.value }))}
                    placeholder="siirrä sähköpostiin"
                    className="w-44 rounded border border-border bg-bg px-2 py-1 text-xs"
                  />
                  <button
                    onClick={() => run(async () => {
                      await fetch(`/api/tags/${t.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberEmail: moveTo[t.id] }) }).then(async (r) => {
                        if (!r.ok) throw new Error((await r.json()).message ?? 'Siirto epäonnistui');
                      });
                      setMoveTo((v) => ({ ...v, [t.id]: '' }));
                    })}
                    className="rounded border border-border px-2 py-1 text-xs"
                  >Siirrä</button>
                  <button
                    onClick={() => run(() => fetch(`/api/tags/${t.id}`, { method: 'DELETE' }).then((r) => {
                      if (!r.ok) throw new Error('Mitätöinti epäonnistui');
                    }))}
                    className="text-muted hover:text-danger"
                    title="Mitätöi avain"
                  >
                    <Trash2 size={15} />
                  </button>
                </div>
              </div> : <button onClick={() => run(() => post('/api/tags/enroll', { memberEmail: u.email }))} className="rounded border border-border px-3 py-1 text-xs"><Nfc size={13} className="mr-1 inline" /> Lisää avain</button>}
            </li>;
          })}
          {data && data.users.length === 0 && <li className="py-2 text-muted">Ei käyttäjiä.</li>}
        </ul>
      </section>
    </div>
  );
}
