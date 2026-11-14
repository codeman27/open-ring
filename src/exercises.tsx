import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import { DEFAULT_TYPES, features, suggest, tagFor, type ActivityTag, type Suggestion } from './activity';
import { AreaChart } from './charts';
import { getKv, setKv } from './db';
import { INTENSITY_LABEL, detectExercises, type Exercise, type Intensity } from './exercise';
import { BoltIcon, ChevronIcon, ExerciseIcon, HeartIcon } from './icons';
import { dayKey, type Summary } from './timeline';

const WINDOW_DAYS = 30;

const INTENSITY_COLOR: Record<Intensity, string> = {
  light: '#5be3a0',
  moderate: '#ffb86b',
  vigorous: '#ff7a8a',
};

const fmtClock = (unix: number) => new Date(unix * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const fmtMinutes = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`);

function dayHeading(key: string) {
  const now = Date.now() / 1000;
  if (key === dayKey(now)) return 'Today';
  if (key === dayKey(now - 86400)) return 'Yesterday';
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
}

function minuteTicks(from: number, to: number) {
  const span = (to - from) / 60;
  const step = [5, 10, 15, 30, 60, 120].find((s) => span / s <= 4) ?? 240;
  const out: { x: number; label: string }[] = [];
  for (let t = Math.ceil(from / (step * 60)) * step * 60; t <= to; t += step * 60) out.push({ x: t, label: fmtClock(t) });
  return out;
}

interface Labeled {
  ex: Exercise;
  tag?: ActivityTag;
  guess?: Suggestion;
}

const titleOf = ({ ex, tag, guess }: Labeled) => tag?.label ?? guess?.label ?? INTENSITY_LABEL[ex.intensity];

function useActivityLabels() {
  const [types, setTypes] = useState<string[]>(DEFAULT_TYPES);
  const [tags, setTags] = useState<ActivityTag[]>([]);
  useEffect(() => {
    getKv<string[]>('activityTypes').then((t) => t && setTypes(t));
    getKv<ActivityTag[]>('activityTags').then((t) => t && setTags(t));
  }, []);
  const tag = useCallback(
    (ex: Exercise, label: string | null) => {
      const old = tagFor(ex, tags);
      const next = tags.filter((t) => t !== old);
      if (label) next.push({ start: ex.start, end: ex.end, label, f: features(ex) });
      setTags(next);
      setKv('activityTags', next);
    },
    [tags],
  );
  const addType = useCallback(
    (name: string) => {
      if (types.some((t) => t.toLowerCase() === name.toLowerCase())) return;
      const next = [...types, name];
      setTypes(next);
      setKv('activityTypes', next);
    },
    [types],
  );
  return { types, tags, tag, addType };
}

function ActivityPicker({ item, types, onTag, onAddType }: { item: Labeled; types: string[]; onTag: (label: string | null) => void; onAddType: (name: string) => void }) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const { tag, guess } = item;
  const current = tag?.label;
  return (
    <section class="card">
      <div class="card-head">
        <h2>What was this?</h2>
      </div>
      <p class="muted small">
        {current
          ? 'Tagged. Similar workouts will be labelled the same way.'
          : guess?.source === 'learned'
            ? `Looks like ${guess.label}, based on workouts you've tagged. Tap it to confirm.`
            : guess
              ? `Best guess from movement and heart rate. Tag it and the app learns your activities.`
              : 'Tag it and the app will start recognising similar workouts.'}
      </p>
      <div class="chips">
        {types.map((t) => (
          <button
            key={t}
            class={`chip ${current === t ? 'active' : ''} ${!current && guess?.label === t ? 'suggested' : ''}`}
            onClick={() => onTag(current === t ? null : t)}
          >
            {t}
          </button>
        ))}
        {!adding && (
          <button class="chip add" onClick={() => setAdding(true)}>
            + Add
          </button>
        )}
      </div>
      {adding && (
        <form
          class="chip-form"
          onSubmit={(e) => {
            e.preventDefault();
            const n = name.trim();
            if (n) {
              onAddType(n);
              onTag(n);
            }
            setName('');
            setAdding(false);
          }}
        >
          <input autoFocus placeholder="Activity name, e.g. Tennis" value={name} onInput={(e) => setName((e.target as HTMLInputElement).value)} />
          <button type="submit" class="primary">
            Add
          </button>
        </form>
      )}
    </section>
  );
}

function ExerciseDetail({ item, types, onTag, onAddType, onBack }: { item: Labeled; types: string[]; onTag: (label: string | null) => void; onAddType: (name: string) => void; onBack: () => void }) {
  const { ex } = item;
  const color = INTENSITY_COLOR[ex.intensity];
  return (
    <>
      <button class="back-btn" onClick={onBack}>
        <ChevronIcon size={16} class="flip" /> All exercise
      </button>
      <section class="card ex-hero" style={{ '--ex': color }}>
        <span class="ex-badge">
          <ExerciseIcon size={22} />
        </span>
        <h2>
          {titleOf(item)}
          {!item.tag && item.guess && <span class="ex-guess">suggested</span>}
        </h2>
        <p class="muted">
          {item.tag || item.guess ? `${INTENSITY_LABEL[ex.intensity]} · ` : ''}
          {dayHeading(dayKey(ex.start))} · {fmtClock(ex.start)} – {fmtClock(ex.end)}
        </p>
        <div class="ex-stats">
          <div>
            <span class="ex-stat-value">{fmtMinutes(ex.minutes)}</span>
            <span class="ex-stat-label">Duration</span>
          </div>
          <div>
            <span class="ex-stat-value">{ex.avgHr ?? '–'}</span>
            <span class="ex-stat-label">Avg bpm</span>
          </div>
          <div>
            <span class="ex-stat-value">{ex.peakHr ?? '–'}</span>
            <span class="ex-stat-label">Peak bpm</span>
          </div>
          <div>
            <span class="ex-stat-value">{ex.avgMet.toFixed(1)}</span>
            <span class="ex-stat-label">Avg MET</span>
          </div>
        </div>
      </section>
      <ActivityPicker item={item} types={types} onTag={onTag} onAddType={onAddType} />
      <section class="card">
        <div class="card-head">
          <h2>
            <span class="card-icon" style={{ color: 'var(--hr)' }}>
              <HeartIcon size={18} />
            </span>
            Heart rate
          </h2>
        </div>
        <AreaChart
          points={ex.hr.map((p) => ({ x: p.unix, y: p.bpm }))}
          color="#ff7a8a"
          height={170}
          xLabels={minuteTicks(ex.start, ex.end)}
          emptyText="The ring didn't record enough heart rate during this session to draw a graph."
        />
      </section>
    </>
  );
}

export function ExerciseTab({ summary }: { summary: Summary | null }) {
  const [selected, setSelected] = useState<string | null>(null);
  const exercises = useMemo(() => {
    const since = Date.now() / 1000 - WINDOW_DAYS * 86400;
    return detectExercises(summary?.metSeries ?? [], summary?.hrSeries ?? [], summary?.nights ?? []).filter((e) => e.start >= since);
  }, [summary]);
  const { types, tags, tag, addType } = useActivityLabels();
  const items = useMemo<Labeled[]>(
    () =>
      exercises.map((ex) => {
        const t = tagFor(ex, tags);
        return { ex, tag: t, guess: t ? undefined : suggest(features(ex), tags, types) };
      }),
    [exercises, tags, types],
  );
  useEffect(() => window.scrollTo(0, 0), [selected]);

  const current = items.find((i) => i.ex.id === selected);
  if (current) {
    return <ExerciseDetail item={current} types={types} onTag={(l) => tag(current.ex, l)} onAddType={addType} onBack={() => setSelected(null)} />;
  }

  if (!exercises.length) {
    return (
      <section class="card empty">
        <span class="ex-badge" style={{ '--ex': INTENSITY_COLOR.light }}>
          <ExerciseIcon size={22} />
        </span>
        <h2>No workouts detected yet</h2>
        <p class="muted">
          Workouts show up here after the ring sees at least 10 minutes of brisk walking or harder. Sync after you exercise.
        </p>
      </section>
    );
  }

  const groups = new Map<string, Labeled[]>();
  for (const i of items) {
    const k = dayKey(i.ex.start);
    groups.set(k, [...(groups.get(k) ?? []), i]);
  }
  const totalMin = exercises.reduce((a, e) => a + e.minutes, 0);
  const withHr = exercises.filter((e) => e.avgHr !== undefined);
  const avgHr = withHr.length ? Math.round(withHr.reduce((a, e) => a + e.avgHr! * e.minutes, 0) / withHr.reduce((a, e) => a + e.minutes, 0)) : undefined;

  return (
    <>
      <section class="card ex-summary">
        <div>
          <span class="ex-stat-value">{exercises.length}</span>
          <span class="ex-stat-label">Workouts</span>
        </div>
        <div>
          <span class="ex-stat-value">{fmtMinutes(totalMin)}</span>
          <span class="ex-stat-label">Total time</span>
        </div>
        <div>
          <span class="ex-stat-value">{avgHr ?? '–'}</span>
          <span class="ex-stat-label">Avg bpm</span>
        </div>
      </section>
      {[...groups].map(([key, list]) => (
        <section key={key} class="card ex-day">
          <h3 class="ex-day-head">{dayHeading(key)}</h3>
          {list.map((item) => {
            const e = item.ex;
            return (
              <button key={e.id} class="ex-item" onClick={() => setSelected(e.id)} style={{ '--ex': INTENSITY_COLOR[e.intensity] }}>
                <span class="ex-badge small">
                  <ExerciseIcon size={18} />
                </span>
                <span class="ex-item-body">
                  <span class="ex-item-title">
                    {titleOf(item)}
                    {!item.tag && item.guess && <span class="ex-guess">suggested</span>}
                  </span>
                  <span class="ex-item-sub">
                    {fmtClock(e.start)} · {fmtMinutes(e.minutes)}
                    {e.avgHr !== undefined ? (
                      <>
                        {' · '}
                        <HeartIcon size={12} /> {e.avgHr} bpm
                      </>
                    ) : (
                      <>
                        {' · '}
                        <BoltIcon size={12} /> {e.avgMet.toFixed(1)} MET
                      </>
                    )}
                  </span>
                </span>
                <ChevronIcon size={16} />
              </button>
            );
          })}
        </section>
      ))}
      <p class="footnote">Last {WINDOW_DAYS} days. Detected on-device from movement intensity, so times are approximate. Tag a workout to teach the app your activities.</p>
    </>
  );
}
