'use client';

import useSWR from 'swr';
import { useEffect, useState } from 'react';
import { Flame, Thermometer } from 'lucide-react';
import { fetcher, post } from '@/lib/fetcher';
import { cn } from '@/lib/cn';

type Heater = { id: string; room: string | null; stale: boolean; relay?: boolean; tempC?: number; powerW?: number };
type Heating = { setpointC: number; source: string; overrideUntil: string | null; heaters: Heater[] };

const SOURCE_LABEL: Record<string, string> = {
  MANUAL: 'käsisäätö',
  CALENDAR: 'kalenteri',
  DEFAULT: 'perustila',
};

export default function HeatingCard() {
  const { data, error, mutate } = useSWR<Heating>('/api/heating', fetcher, { refreshInterval: 30_000 });
  const [draft, setDraft] = useState<number | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  // Follow the server value unless the user is mid-drag.
  useEffect(() => {
    if (data && draft === null) setDraft(data.setpointC);
  }, [data, draft]);

  const value = draft ?? data?.setpointC ?? 12;

  async function commit(v: number) {
    setMsg(null);
    try {
      await post('/api/heating/setpoint', { setpointC: v });
      mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Virhe');
    }
  }

  return (
    <section className="rounded-2xl border border-border bg-surface p-5">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted">Lämmitys</h2>

      {error ? (
        <p className="text-sm text-danger">{error.message}</p>
      ) : (
        <>
          <div className="flex items-end justify-between">
            <span className="text-4xl font-semibold tabular-nums">{value.toFixed(1)}°C</span>
            <span className="text-sm text-muted">{SOURCE_LABEL[data?.source ?? 'DEFAULT'] ?? data?.source}</span>
          </div>

          <input
            type="range"
            min={5}
            max={24}
            step={0.5}
            value={value}
            onChange={(e) => setDraft(Number(e.target.value))}
            onPointerUp={() => draft !== null && commit(draft)}
            onKeyUp={() => draft !== null && commit(draft)}
            className="mt-4 w-full accent-[var(--accent)]"
          />
          <div className="flex justify-between text-xs text-muted">
            <span>5°</span>
            <span>24°</span>
          </div>

          {msg && <p className="mt-2 text-sm text-danger">{msg}</p>}

          <div className="mt-4 flex flex-col gap-2">
            {(data?.heaters ?? []).map((h) => (
              <div key={h.id} className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm">
                <span className="flex items-center gap-2">
                  <Flame size={15} className={cn(h.relay ? 'text-accent' : 'text-muted')} />
                  {h.room ?? h.id}
                </span>
                <span className="flex items-center gap-3 text-muted tabular-nums">
                  {typeof h.tempC === 'number' && (
                    <span className="flex items-center gap-1">
                      <Thermometer size={14} />
                      {h.tempC.toFixed(1)}°
                    </span>
                  )}
                  {typeof h.powerW === 'number' && <span>{Math.round(h.powerW)} W</span>}
                  {h.stale && <span className="text-danger">ei yhteyttä</span>}
                </span>
              </div>
            ))}
            {data && data.heaters.length === 0 && (
              <p className="text-sm text-muted">Ei lämmityslaitteita vielä liitettynä.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
