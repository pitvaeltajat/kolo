'use client';

import useSWR from 'swr';
import { useEffect, useState } from 'react';
import { CalendarDays, Flame, Thermometer, Zap } from 'lucide-react';
import { fetcher, post } from '@/lib/fetcher';
import { cn } from '@/lib/cn';
import HeatingChart from './HeatingChart';

type Heater = { id: string; kind: string; room: string | null; controlGroup: string | null; stale: boolean; relay?: boolean; tempC?: number; powerW?: number };
type Channel = { id: string | number; label?: string; relay?: boolean; powerW?: number };
type Group = { id: string; label: string; stale: boolean; relayOn: boolean; activeDevices: number; tempC: number | null; powerW: number | null; channels: Channel[] };
type HeatingEvent = { title?: string; start: string; end: string; location?: string };
type HeatingPeriod = { start: string; end: string; setpointC: number };
type Reading = { at: string; controlGroup: string; room: string | null; tempC: number; targetC: number | null };
type Heating = { setpointC: number; source: string; boostUntil: string | null; isAdmin: boolean; areaSetpoints: Record<string, number>; calendarEvents: HeatingEvent[]; plan: HeatingPeriod[]; readings: Reading[]; groups: Group[]; rooms: Heater[] };

const SOURCE_LABEL: Record<string, string> = {
  BOOST: '3 h tehostus',
  CALENDAR: 'kalenteri',
  DEFAULT: 'perustila',
};

export default function HeatingCard() {
  const { data, error, mutate } = useSWR<Heating>('/api/heating', fetcher, { refreshInterval: 30_000 });
  const [areaDraft, setAreaDraft] = useState<Record<string, number>>({});
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (data) setAreaDraft((current) => ({ ...data.areaSetpoints, ...current }));
  }, [data]);

  async function commitArea(area: string) {
    setMsg(null);
    try {
      await post('/api/heating/setpoint', { area, setpointC: areaDraft[area] });
      mutate();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Virhe');
    }
  }

  return (
    <section className="service-card border border-border bg-surface p-6">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wide text-muted">Lämmitys</h2>

      {error ? (
        <p className="text-sm text-danger">{error.message}</p>
      ) : (
        <>
          <div className="flex items-end justify-between">
            <span className="text-4xl font-semibold tabular-nums">{data?.setpointC?.toFixed(1) ?? '—'}°C</span>
            <span className="text-sm text-muted">{SOURCE_LABEL[data?.source ?? 'DEFAULT'] ?? data?.source}</span>
          </div>

          <button onClick={() => post('/api/heating/boost').then(() => mutate()).catch((e) => setMsg(e instanceof Error ? e.message : 'Virhe'))} className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-accent px-4 py-3 font-semibold text-accent-fg">
            <Zap size={17} /> Lämpö 3 tunniksi
          </button>
          {data?.boostUntil && <p className="mt-2 text-center text-xs text-muted">Tehostus päällä {new Date(data.boostUntil).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' })} asti</p>}

          {data?.isAdmin && (
            <div className="mt-4 rounded-lg border border-border p-3">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Ylläpitäjän alueasetukset</h3>
              <div className="grid gap-2 sm:grid-cols-2">
                {['downstairs', 'upstairs'].map((area) => (
                  <label key={area} className="flex items-center justify-between gap-2 text-sm">
                    {area === 'downstairs' ? 'Alakerta' : 'Yläkerta'}
                    <span className="flex items-center gap-1"><input type="number" min={5} max={24} step={0.5} value={areaDraft[area] ?? 20} onChange={(e) => setAreaDraft((v) => ({ ...v, [area]: Number(e.target.value) }))} className="w-20 rounded border border-border bg-bg px-2 py-1 text-right" />°C</span>
                    <button onClick={() => commitArea(area)} className="rounded border border-border px-2 py-1 text-xs">Tallenna</button>
                  </label>
                ))}
              </div>
            </div>
          )}

          {msg && <p className="mt-2 text-sm text-danger">{msg}</p>}

          <div className="mt-5 rounded-lg border border-border p-3 text-sm">
            <h3 className="mb-2 flex items-center gap-2 font-medium"><CalendarDays size={16} /> Kalenteri ja lämmityssuunnitelma</h3>
            <div className="grid gap-3">
              <HeatingChart group="downstairs" readings={data?.readings ?? []} plan={data?.plan ?? []} areaSetpoint={data?.areaSetpoints?.downstairs ?? 10} boostUntil={data?.boostUntil ?? null} />
              <HeatingChart group="upstairs" readings={data?.readings ?? []} plan={data?.plan ?? []} areaSetpoint={data?.areaSetpoints?.upstairs ?? 10} boostUntil={data?.boostUntil ?? null} />
            </div>
            <div className="flex flex-col gap-2 text-xs text-muted">
              {(data?.calendarEvents ?? []).map((event, i) => <div key={`${event.start}-${i}`}><span className="text-text">{event.title}</span> · {new Date(event.start).toLocaleString('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })}–{new Date(event.end).toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' })}</div>)}
              {(data?.plan ?? []).map((period) => <div key={period.start} className="text-success">Lämmitys alkaa {new Date(period.start).toLocaleString('fi-FI', { weekday: 'short', day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' })} · {period.setpointC}°C</div>)}
              {!data?.calendarEvents?.length && <span>Ei tulevia varauksia.</span>}
            </div>
          </div>

          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {(data?.groups ?? []).map((g) => (
              <div key={g.id} className="rounded-lg border border-border px-3 py-3 text-sm">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-2 font-medium">
                    <Flame size={15} className={cn(g.relayOn ? 'text-accent' : 'text-muted')} />
                    {g.label}
                  </span>
                  {g.stale && <span className="text-danger">ei yhteyttä</span>}
                </div>
                <div className="mt-2 flex items-center gap-3 text-muted tabular-nums">
                  {typeof g.tempC === 'number' && <span className="flex items-center gap-1"><Thermometer size={14} />{g.tempC.toFixed(1)}°C</span>}
                  <span>{g.activeDevices}/{g.channels.length || '—'} päällä</span>
                  {typeof g.powerW === 'number' && <span>{Math.round(g.powerW)} W</span>}
                </div>
              </div>
            ))}
          </div>
          {(data?.groups ?? []).some((g) => g.channels.length > 0) && (
            <div className="mt-3 grid gap-2 sm:grid-cols-3">
              {(data?.groups ?? []).flatMap((g) => g.channels.map((channel) => (
                <div key={`${g.id}-${channel.id}`} className="rounded-lg border border-border px-3 py-2 text-sm">
                  <div className="flex items-center justify-between">
                    <span>{channel.label ?? `O${Number(channel.id) + 1}`}</span>
                    <span className={channel.relay ? 'text-success' : 'text-muted'}>{channel.relay ? 'päällä' : 'pois'}</span>
                  </div>
                  {typeof channel.powerW === 'number' && <div className="mt-1 text-xs text-muted">{Math.round(channel.powerW)} W</div>}
                </div>
              ))) }
            </div>
          )}
          <div className="mt-3 flex flex-col gap-2">
            {(data?.rooms ?? []).map((h) => (
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
            {data && data.rooms.length === 0 && (
              <p className="text-sm text-muted">Ei lämmityslaitteita vielä liitettynä.</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
