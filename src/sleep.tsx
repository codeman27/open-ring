import { useEffect, useMemo, useState } from 'preact/hooks';
import { AreaChart } from './charts';
import { ChevronIcon, HeartIcon, MoonIcon, WaveIcon } from './icons';
import { sleepScore, tier } from './scores';
import { EPOCH_S, dayKey, type Night, type Stage, type Summary } from './timeline';

const STAGES: { key: Stage; label: string; color: string; row: number }[] = [
  { key: 'awake', label: 'Awake', color: 'var(--st-awake)', row: 0 },
  { key: 'rem', label: 'REM', color: 'var(--st-rem)', row: 1 },
  { key: 'light', label: 'Light', color: 'var(--st-light)', row: 2 },
  { key: 'deep', label: 'Deep', color: 'var(--st-deep)', row: 3 },
];
const STAGE = Object.fromEntries(STAGES.map((s) => [s.key, s])) as Record<Stage, (typeof STAGES)[number]>;
const PAST_NIGHTS = 14;

const fmtClock = (unix?: number) => (unix ? new Date(unix * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–');
const fmtMin = (m?: number) => (m === undefined ? '–' : `${Math.floor(m / 60)}h ${String(Math.round(m % 60)).padStart(2, '0')}m`);

const minutesOf = (n: Night, s: Stage) =>
  n.stageStats ? { deep: n.stageStats.deepMin, light: n.stageStats.lightMin, rem: n.stageStats.remMin, awake: n.stageStats.awakeMin }[s] : 0;
const asleepMin = (n: Night) => n.stageStats?.sleepMin ?? (n.sleepHours !== undefined ? n.sleepHours * 60 : undefined);

function nightLabel(key: string, long = false) {
  if (key === dayKey(Date.now() / 1000)) return 'Last night';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], long ? { weekday: 'long', month: 'long', day: 'numeric' } : { weekday: 'short', month: 'short', day: 'numeric' });
}

function hourTicks(from: number, to: number) {
  const out: { x: number; label: string }[] = [];
  const step = to - from > 9 * 3600 ? 3 : 2;
  const d = new Date(from * 1000);
  d.setMinutes(0, 0, 0);
  d.setHours(Math.ceil((d.getHours() + 1) / step) * step);
  for (let t = d.getTime() / 1000; t < to; t += step * 3600) out.push({ x: t, label: new Date(t * 1000).toLocaleTimeString([], { hour: 'numeric' }) });
  return out;
}

/** Stepped hypnogram: one row per stage, Awake on top and Deep at the bottom. */
function Hypnogram({ start, epochs }: { start: number; epochs: Stage[] }) {
  const W = 320;
  const ROW = 30;
  const H = ROW * 4;
  const end = start + epochs.length * EPOCH_S;
  const x = (i: number) => (i / epochs.length) * W;
  const runs: { stage: Stage; from: number; to: number }[] = [];
  epochs.forEach((st, i) => {
    const last = runs.at(-1);
    if (last && last.stage === st) last.to = i + 1;
    else runs.push({ stage: st, from: i, to: i + 1 });
  });
  const y = (st: Stage) => STAGE[st].row * ROW + ROW / 2;
  const path = runs.map((r, i) => `${i ? 'L' : 'M'}${x(r.from).toFixed(1)},${y(r.stage)} L${x(r.to).toFixed(1)},${y(r.stage)}`).join(' ');
  return (
    <div class="hypno">
      <div class="hypno-rows">
        {STAGES.map((s) => (
          <span key={s.key}>{s.label}</span>
        ))}
      </div>
      <div class="hypno-plot">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ height: H }}>
          {STAGES.map((s) => (
            <line key={s.key} x1="0" x2={W} y1={s.row * ROW + ROW / 2} y2={s.row * ROW + ROW / 2} stroke="rgba(255,255,255,0.06)" vector-effect="non-scaling-stroke" />
          ))}
          <path d={path} fill="none" stroke="rgba(255,255,255,0.22)" stroke-width="1" vector-effect="non-scaling-stroke" />
          {runs.map((r) => (
            <rect key={r.from} x={x(r.from)} y={y(r.stage) - 7} width={Math.max(x(r.to) - x(r.from), 0.8)} height="14" rx="3" fill={STAGE[r.stage].color} />
          ))}
        </svg>
        <div class="chart-x">
          {hourTicks(start, end).map((t) => (
            <span key={t.x} style={{ left: `${((t.x - start) / (end - start)) * 100}%` }}>
              {t.label}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function StageBar({ night }: { night: Night }) {
  const total = STAGES.reduce((a, s) => a + minutesOf(night, s.key), 0);
  if (!total) return <div class="stage-bar empty" />;
  return (
    <div class="stage-bar">
      {[...STAGES].reverse().map((s) => {
        const m = minutesOf(night, s.key);
        return m ? <span key={s.key} style={{ width: `${(m / total) * 100}%`, background: s.color }} /> : null;
      })}
    </div>
  );
}

function NightDetail({ night, nightsUpTo }: { night: Night; nightsUpTo: Night[] }) {
  const score = useMemo(() => sleepScore(nightsUpTo), [nightsUpTo]);
  const st = night.stageStats;
  const inBedMin = night.sleepHours !== undefined ? night.sleepHours * 60 : undefined;
  const hr = (night.hrSeries ?? []).map((p) => ({ x: p.unix, y: p.bpm }));
  const hrv = (night.hrvSeries ?? []).map((p) => ({ x: p.unix, y: p.ms }));
  const from = night.bedtimeStart ?? hr[0]?.x ?? 0;
  const to = night.bedtimeEnd ?? hr.at(-1)?.x ?? 0;
  const ticks = from && to ? hourTicks(from, to) : [];

  return (
    <>
      <section class={`card sleep-hero tier-${score ? tier(score.score) : 'fair'}`}>
        <div class="sleep-hero-score">
          <span class="sleep-score">{score?.score ?? '–'}</span>
          <span class="sleep-score-label">Sleep score</span>
        </div>
        <div class="sleep-hero-stats">
          <div>
            <span class="ex-stat-value">{fmtMin(asleepMin(night))}</span>
            <span class="ex-stat-label">{st ? 'Total sleep' : 'In bed'}</span>
          </div>
          <div>
            <span class="ex-stat-value">{st ? `${Math.round(st.efficiency * 100)}%` : '–'}</span>
            <span class="ex-stat-label">Efficiency</span>
          </div>
          <div>
            <span class="ex-stat-value">{fmtMin(inBedMin)}</span>
            <span class="ex-stat-label">Time in bed</span>
          </div>
          <div>
            <span class="ex-stat-value">{st ? `${st.latencyMin} min` : '–'}</span>
            <span class="ex-stat-label">Fell asleep in</span>
          </div>
        </div>
        <p class="muted small sleep-window">
          <MoonIcon size={14} /> {fmtClock(night.bedtimeStart)} → {fmtClock(night.bedtimeEnd)}
        </p>
      </section>

      <section class="card">
        <div class="card-head">
          <h2>Sleep stages</h2>
        </div>
        {night.stages && st ? (
          <>
            <Hypnogram start={night.stages.start} epochs={night.stages.epochs} />
            <div class="stage-legend">
              {STAGES.map((s) => {
                const m = minutesOf(night, s.key);
                const pct = Math.round((m / Math.max(1, st.sleepMin + st.awakeMin)) * 100);
                return (
                  <div key={s.key} class="stage-row">
                    <span class="stage-dot" style={{ background: s.color }} />
                    <span class="stage-name">{s.label}</span>
                    <span class="stage-pct">{pct}%</span>
                    <span class="stage-min">{fmtMin(m)}</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : (
          <p class="muted small">Sleep stages appear once the ring has finished its overnight analysis and you sync in the morning.</p>
        )}
      </section>

      {score && (
        <section class="card">
          <div class="card-head">
            <h2>Contributors</h2>
            {score.provisional && <span class="muted small">Estimated</span>}
          </div>
          <div class="contributors plain">
            {score.contributors.map((c) => (
              <div key={c.label} class="contributor">
                <div class="contributor-head">
                  <span>{c.label}</span>
                  <span>{c.score}</span>
                </div>
                <div class="contributor-bar">
                  <span style={{ width: `${c.score}%` }} class={`tier-${tier(c.score)}`} />
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <section class="card">
        <div class="card-head">
          <h2>
            <span class="card-icon" style={{ color: 'var(--hr)' }}>
              <HeartIcon size={18} />
            </span>
            Heart rate
          </h2>
          <span class="big-inline">
            {night.lowestHr ?? '–'}
            <small>bpm lowest</small>
          </span>
        </div>
        <AreaChart points={hr} color="#ff7a8a" height={120} xLabels={ticks} emptyText="No overnight heart rate recorded for this night." />
      </section>

      <section class="card">
        <div class="card-head">
          <h2>
            <span class="card-icon" style={{ color: 'var(--hrv)' }}>
              <WaveIcon size={18} />
            </span>
            HRV
          </h2>
          <span class="big-inline">
            {night.avgHrv ?? '–'}
            <small>ms average</small>
          </span>
        </div>
        <AreaChart points={hrv} color="#5fd4c4" height={120} xLabels={ticks} emptyText="No overnight HRV recorded for this night." />
      </section>
    </>
  );
}

export function SleepTab({ summary }: { summary: Summary | null }) {
  const nights = useMemo(() => (summary?.nights ?? []).filter((n) => n.sleepHours !== undefined || n.stageStats), [summary]);
  const [key, setKey] = useState<string | null>(null);
  const idx = key ? nights.findIndex((n) => n.key === key) : nights.length - 1;
  const night = nights[idx];
  const nightsUpTo = useMemo(() => nights.slice(0, idx + 1), [nights, idx]);
  useEffect(() => window.scrollTo(0, 0), [key]);

  if (!night) {
    return (
      <section class="card empty">
        <span class="ex-badge" style={{ '--ex': 'var(--sleep)' }}>
          <MoonIcon size={22} />
        </span>
        <h2>No sleep recorded yet</h2>
        <p class="muted">Wear your ring tonight and sync in the morning to see your sleep stages.</p>
      </section>
    );
  }

  const past = nights.slice(-PAST_NIGHTS).reverse();
  return (
    <>
      <div class="night-nav">
        <button class="icon-btn" disabled={idx <= 0} onClick={() => setKey(nights[idx - 1].key)} aria-label="Previous night">
          <ChevronIcon size={18} class="flip" />
        </button>
        <span class="night-title">{nightLabel(night.key, true)}</span>
        <button class="icon-btn" disabled={idx >= nights.length - 1} onClick={() => setKey(nights[idx + 1].key)} aria-label="Next night">
          <ChevronIcon size={18} />
        </button>
      </div>

      <NightDetail night={night} nightsUpTo={nightsUpTo} />

      <section class="card ex-day">
        <h3 class="ex-day-head">Past nights</h3>
        {past.map((n) => {
          const s = sleepScore(nights.slice(0, nights.indexOf(n) + 1));
          return (
            <button key={n.key} class={`night-item ${n.key === night.key ? 'active' : ''}`} onClick={() => setKey(n.key)}>
              <span class="night-item-top">
                <span class="night-item-date">{nightLabel(n.key)}</span>
                <span class="night-item-dur">{fmtMin(asleepMin(n))}</span>
                <span class={`night-item-score tier-${s ? tier(s.score) : 'fair'}`}>{s?.score ?? '–'}</span>
              </span>
              <StageBar night={n} />
            </button>
          );
        })}
      </section>
      <p class="footnote">Sleep stages come from the ring's own on-device staging; Oura's app refines them with a cloud-keyed model, so totals can differ a little.</p>
    </>
  );
}
