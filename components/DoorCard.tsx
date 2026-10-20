'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { Lock, LockOpen, DoorOpen, BatteryLow } from 'lucide-react';
import { fetcher, post } from '@/lib/fetcher';
import { cn } from '@/lib/cn';

type Status = {
  known: boolean;
  stale?: boolean;
  locked?: boolean;
  doorOpen?: boolean;
  battery?: number;
  updatedAt?: string;
};

export default function DoorCard() {
  const { data, error, mutate } = useSWR<Status>('/api/status', fetcher, { refreshInterval: 15_000 });
  const [busy, setBusy] = useState<null | 'unlock' | 'lock'>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function op(action: 'unlock' | 'lock') {
    setBusy(action);
    setMsg(null);
    try {
      const r = await post<{ message: string }>(`/api/${action}`);
      setMsg({ ok: true, text: r.message });
      mutate();
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : 'Virhe' });
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted">Etuovi</h2>

      <button
        onClick={() => op('unlock')}
        disabled={busy !== null}
        className={cn(
          'flex w-full items-center justify-center gap-3 rounded-xl bg-accent px-6 py-6 text-lg font-semibold text-accent-fg',
          'transition active:scale-[0.99] disabled:opacity-60',
        )}
      >
        <LockOpen size={24} />
        {busy === 'unlock' ? 'Avataan…' : 'Avaa ovi'}
      </button>

      <div className="mt-3 flex items-center justify-between text-sm text-muted">
        <StatusLine data={data} error={error} />
        <button onClick={() => op('lock')} disabled={busy !== null} className="hover:text-text">
          {busy === 'lock' ? 'Lukitaan…' : 'Lukitse'}
        </button>
      </div>

      {msg && (
        <p className={cn('mt-3 text-sm', msg.ok ? 'text-accent' : 'text-danger')}>{msg.text}</p>
      )}
    </section>
  );
}

function StatusLine({ data, error }: { data?: Status; error?: Error }) {
  if (error) return <span className="text-danger">{error.message}</span>;
  if (!data) return <span>Haetaan tilaa…</span>;
  if (!data.known) return <span>Ei vielä tilatietoa laitteelta</span>;

  return (
    <span className="flex items-center gap-2">
      {data.locked ? <Lock size={15} /> : <LockOpen size={15} />}
      {data.locked ? 'Lukossa' : 'Auki'}
      {data.doorOpen && (
        <>
          <DoorOpen size={15} /> ovi raollaan
        </>
      )}
      {typeof data.battery === 'number' && data.battery < 20 && (
        <>
          <BatteryLow size={15} /> {data.battery}%
        </>
      )}
      {data.stale && <span className="text-danger">· ei yhteyttä</span>}
    </span>
  );
}
