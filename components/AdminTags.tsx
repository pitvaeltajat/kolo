'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { Trash2, RefreshCw, Nfc } from 'lucide-react';
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

export default function AdminTags() {
  const { data, error, mutate } = useSWR<{ tags: Tag[] }>('/api/tags', fetcher);
  const [email, setEmail] = useState('');
  const [uid, setUid] = useState('');
  const [msg, setMsg] = useState<string | null>(null);

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
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted">Tunnisteet</h2>
          <button
            onClick={() => run(() => post('/api/allowlist'))}
            className="flex items-center gap-1 text-sm text-muted hover:text-text"
            title="Lähetä sallittujen lista lukijalle"
          >
            <RefreshCw size={14} /> Päivitä lukija
          </button>
        </div>
        <ul className="flex flex-col divide-y divide-border">
          {(data?.tags ?? []).map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-2 py-2 text-sm">
              <span className={t.active ? '' : 'text-muted line-through'}>
                <span className="font-mono">{t.uid}</span> · {t.memberName ?? t.memberEmail}
              </span>
              {t.active && (
                <button
                  onClick={() => run(() => fetch(`/api/tags/${t.id}`, { method: 'DELETE' }).then((r) => {
                    if (!r.ok) throw new Error('Poisto epäonnistui');
                  }))}
                  className="text-muted hover:text-danger"
                  title="Mitätöi"
                >
                  <Trash2 size={15} />
                </button>
              )}
            </li>
          ))}
          {data && data.tags.length === 0 && <li className="py-2 text-muted">Ei tunnisteita.</li>}
        </ul>
      </section>
    </div>
  );
}
