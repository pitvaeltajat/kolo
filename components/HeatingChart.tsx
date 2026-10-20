'use client';

type Reading = { at: string; controlGroup: string; tempC: number; targetC: number | null };
type Period = { start: string; end: string; setpointC: number };

const W = 960;
const H = 260;
const PAD = { top: 18, right: 48, bottom: 32, left: 48 };
const MIN_C = 5;
const MAX_C = 25;

function timeLabel(ms: number) {
  return new Date(ms).toLocaleString('fi-FI', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
}

export default function HeatingChart({ group, readings, plan, areaSetpoint, boostUntil }: {
  group: string;
  readings: Reading[];
  plan: Period[];
  areaSetpoint: number;
  boostUntil: string | null;
}) {
  const now = Date.now();
  const end = Math.max(now + 48 * 3_600_000, ...plan.map((p) => Date.parse(p.end)));
  const start = now - 24 * 3_600_000;
  const x = (ms: number) => PAD.left + ((ms - start) / (end - start)) * (W - PAD.left - PAD.right);
  const y = (temp: number) => PAD.top + ((MAX_C - temp) / (MAX_C - MIN_C)) * (H - PAD.top - PAD.bottom);
  const points = (count: number) => Array.from({ length: count }, (_, i) => start + ((end - start) * i) / (count - 1));
  const target = points(100).map((ms) => {
    const boost = boostUntil && ms < Date.parse(boostUntil) && ms >= now;
    const scheduled = plan.find((p) => ms >= Date.parse(p.start) && ms < Date.parse(p.end));
    return `${x(ms)},${y(boost ? 20 : scheduled?.setpointC ?? areaSetpoint)}`;
  }).join(' ');
  const actual = readings.filter((r) => r.controlGroup === group && Date.parse(r.at) >= start).map((r) => `${x(Date.parse(r.at))},${y(r.tempC)}`).join(' ');
  const ticks = [5, 10, 15, 20, 25];
  const latest = readings.filter((r) => r.controlGroup === group).at(-1);

  return (
    <div className="rounded-lg border border-border p-3">
      <div className="mb-2 flex items-center justify-between text-xs">
        <span className="font-medium">{group === 'downstairs' ? 'Alakerta' : 'Yläkerta'}</span>
        <span className="text-muted">tavoite · lämpötila{latest ? ` · nyt ${latest.tempC.toFixed(1)}°C` : ''}</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={`${group} lämpötilakaavio`}>
        {ticks.map((tick) => <g key={tick}><line x1={PAD.left} x2={W - PAD.right} y1={y(tick)} y2={y(tick)} stroke="var(--border)" strokeDasharray="3 4" /><text x={PAD.left - 8} y={y(tick) + 4} textAnchor="end" fontSize="11" fill="var(--muted)">{tick}°</text><text x={W - PAD.right + 8} y={y(tick) + 4} fontSize="11" fill="var(--muted)">{tick}°</text></g>)}
        <polyline points={target} fill="none" stroke="var(--accent)" strokeWidth="3" />
        {actual && <polyline points={actual} fill="none" stroke="var(--success)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />}
        <text x={PAD.left} y={H - 8} fontSize="11" fill="var(--muted)">{timeLabel(start)}</text>
        <text x={W - PAD.right} y={H - 8} textAnchor="end" fontSize="11" fill="var(--muted)">{timeLabel(end)}</text>
      </svg>
      <div className="mt-1 flex gap-4 text-xs text-muted"><span><i className="mr-1 inline-block h-2 w-5 rounded bg-accent" />tavoitelämpötila</span><span><i className="mr-1 inline-block h-2 w-5 rounded bg-success" />mitattu lämpötila</span></div>
    </div>
  );
}
