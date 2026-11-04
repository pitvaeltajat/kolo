'use client';

import useSWR from 'swr';
import { useState } from 'react';
import { Lock, LockOpen, DoorOpen, BatteryLow, Loader2, WifiOff } from 'lucide-react';
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

  // One button, one action. If the lock reports open we offer to lock; otherwise
  // (locked, or state not yet known) we offer to open — the door is normally
  // locked and opening is the common need. Both commands are idempotent, so a
  // wrong guess from a stale reading is harmless.
  const unlocked = data?.locked === false;
  const action: 'unlock' | 'lock' = unlocked ? 'lock' : 'unlock';
  const haveState = !!data || !!error;

  async function op() {
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

  const stateWord = !data?.known ? 'Tila tuntematon' : unlocked ? 'Auki' : 'Lukossa';
  const actionHint = busy
    ? action === 'unlock'
      ? 'Avataan…'
      : 'Lukitaan…'
    : action === 'unlock'
      ? 'Paina avataksesi'
      : 'Paina lukitaksesi';

  const StateIcon = busy ? Loader2 : unlocked ? LockOpen : Lock;

  return (
    <section className="service-card border border-border bg-surface p-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted">Etuovi</h2>

      <button
        onClick={op}
        disabled={busy !== null || !haveState}
        aria-label={action === 'unlock' ? 'Avaa ovi' : 'Lukitse ovi'}
        className={cn(
          'flex w-full items-center gap-4 rounded-xl px-6 py-6 text-left transition active:scale-[0.99] disabled:opacity-60',
          unlocked ? 'bg-brand text-bg' : 'bg-accent text-accent-fg',
        )}
      >
        <StateIcon size={40} className={cn('shrink-0', busy && 'animate-spin')} />
        <span className="flex flex-col">
          <span className="text-2xl font-semibold leading-tight">
            {haveState ? stateWord : 'Haetaan tilaa…'}
          </span>
          {haveState && <span className="text-sm opacity-80">{actionHint}</span>}
        </span>
      </button>

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
        {data?.doorOpen && (
          <span className="flex items-center gap-1 text-danger">
            <DoorOpen size={15} /> Ovi raollaan
          </span>
        )}
        {data?.stale && (
          <span className="flex items-center gap-1 text-danger">
            <WifiOff size={15} /> Ei yhteyttä lukkoon
          </span>
        )}
        {typeof data?.battery === 'number' && data.battery < 20 && (
          <span className="flex items-center gap-1 text-danger">
            <BatteryLow size={15} /> Akku {data.battery}%
          </span>
        )}
        {error ? (
          <span className="text-danger">{error.message}</span>
        ) : (
          data?.updatedAt && (
            <span>
              Päivitetty{' '}
              {new Date(data.updatedAt).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' })}
            </span>
          )
        )}
      </div>

      {msg && <p className={cn('mt-2 text-sm', msg.ok ? 'text-success' : 'text-danger')}>{msg.text}</p>}
    </section>
  );
}
