import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { bluetoothAvailable, bluetoothSupport, explainBluetoothError, protocolLog, type LogEntry } from './ble';
import { AuthError } from './client';
import {
  activeRing,
  eventCounts,
  eventsByTag,
  exportAll,
  forgetRing,
  latestReading,
  resetCursor,
  saveRing,
  syncState,
  type RingRecord,
  type SyncState,
} from './db';
import {
  RingSession,
  importKey,
  liveHeartRate,
  pairFreshRing,
  probe,
  readFeatures,
  setFeature,
  syncRing,
  type ProbeResult,
} from './session';
import { RingClock, SUMMARY_TAGS, baseline, dayKey, summarize, type Baseline, type Night, type Summary } from './timeline';
import { AreaChart, Gauge, RangeBar } from './charts';
import { ReadinessHero, type ScoreBubble } from './readiness';
import { ExerciseTab } from './exercises';
import { SleepTab } from './sleep';
import { activityScore, readinessScore, sleepScore } from './scores';
import {
  BatteryIcon,
  BluetoothIcon,
  BoltIcon,
  ChevronIcon,
  DropIcon,
  ExerciseIcon,
  HeartIcon,
  KeyIcon,
  LungsIcon,
  MoonIcon,
  RingIcon,
  SyncIcon,
  ThermometerIcon,
  TodayIcon,
  TrendsIcon,
  WaveIcon,
} from './icons';
import { versionLabel } from './version';

const session = new RingSession();

type Tab = 'today' | 'sleep' | 'exercise' | 'trends' | 'ring';
type Run = <T>(label: string, fn: (step: (m: string) => void) => Promise<T>) => Promise<T | undefined>;

const SLEEP_GOAL_H = 8;

const fmtTime = (unix?: number) =>
  unix ? new Date(unix * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : '–';
const fmtAgo = (unix?: number) => {
  if (!unix) return 'never';
  const s = Date.now() / 1000 - unix;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
};
const fmtDuration = (hours?: number) => {
  if (hours === undefined) return '–';
  const m = Math.round(hours * 60);
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const greeting = () => {
  const h = new Date().getHours();
  return h < 5 ? 'Good night' : h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
};
const shortDay = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString([], { weekday: 'short' });
};

function download(name: string, blob: Blob) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function withWakeLock<T>(fn: () => Promise<T>): Promise<T> {
  const lock = await navigator.wakeLock?.request('screen').catch(() => undefined);
  try {
    return await fn();
  } finally {
    await lock?.release().catch(() => undefined);
  }
}

export function App() {
  const [ring, setRing] = useState<RingRecord | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('today');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [sync, setSync] = useState<SyncState | null>(null);
  const [battery, setBattery] = useState<number | undefined>();
  const [connected, setConnected] = useState(false);
  const [applyUpdate, setApplyUpdate] = useState<(() => void) | null>(null);
  const abort = useRef<AbortController | null>(null);
  const support = bluetoothSupport();
  const [radio, setRadio] = useState<boolean | undefined>(undefined);

  useEffect(() => {
    const onUpdate = (e: Event) => setApplyUpdate(() => (e as CustomEvent<() => void>).detail);
    window.addEventListener('open-ring:update', onUpdate);
    return () => window.removeEventListener('open-ring:update', onUpdate);
  }, []);

  useEffect(() => {
    if (support) return;
    bluetoothAvailable().then(setRadio);
    const bt = navigator.bluetooth as Bluetooth & EventTarget;
    const onChange = (e: Event) => setRadio((e as Event & { value?: boolean }).value);
    bt.addEventListener?.('availabilitychanged', onChange);
    return () => bt.removeEventListener?.('availabilitychanged', onChange);
  }, [support]);

  const refresh = useCallback(async () => {
    const r = await activeRing();
    setRing(r ?? null);
    if (!r) return;
    const [events, s, b] = await Promise.all([eventsByTag(r.serial, SUMMARY_TAGS), syncState(r.serial), latestReading(r.serial, 'battery')]);
    setSync(s);
    setBattery(b?.value);
    setSummary(summarize(events, RingClock.fromEvents(events, s)));
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(() => setConnected(session.connected), 1000);
    return () => clearInterval(t);
  }, [refresh]);

  /** Run a ring operation with a shared busy/error state. */
  const run = useCallback(async <T,>(label: string, fn: (step: (m: string) => void) => Promise<T>): Promise<T | undefined> => {
    setError(null);
    setNotice(null);
    setBusy(label);
    try {
      return await fn((m) => {
        setBusy(m);
        protocolLog.push('info', m);
      });
    } catch (e) {
      if (e instanceof AuthError && e.code === 2) {
        setError(`${errText(e)}. Pair it from the setup screen.`);
      } else if (e instanceof DOMException) {
        setError(explainBluetoothError(e));
      } else {
        setError(errText(e));
      }
      protocolLog.push('info', `error: ${e instanceof DOMException ? `${e.name}: ` : ''}${errText(e)}`);
      return undefined;
    } finally {
      setBusy(null);
      setConnected(session.connected);
    }
  }, []);

  const doSync = () =>
    ring &&
    run('Syncing…', async (step) => {
      abort.current = new AbortController();
      const r = await withWakeLock(() => syncRing(session, ring, step, abort.current!.signal));
      setNotice(`Synced ${r.eventsSynced.toLocaleString()} new readings in ${r.seconds.toFixed(0)} s`);
      await refresh();
    });

  if (ring === undefined) return <div class="app" />;
  const disabled = !!busy || !!support;
  const syncing = !!busy && !!ring;

  return (
    <div class="app">
      <div class="sticky">
        <header class="top">
          <div>
            <p class="eyebrow">{new Date().toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })}</p>
            <h1>{ring ? (tab === 'today' ? greeting() : tab === 'sleep' ? 'Sleep' : tab === 'exercise' ? 'Exercise' : tab === 'trends' ? 'Trends' : 'Your ring') : 'Open Ring'}</h1>
          </div>
          {ring && (
            <div class="top-actions">
              <button
                class={`pill ${connected ? 'pill-live' : ''} ${tab === 'ring' ? 'active' : ''}`}
                title={`Ring settings · synced ${fmtAgo(sync?.lastSyncUnix)}`}
                aria-label="Ring settings"
                onClick={() => setTab('ring')}
              >
                <RingIcon size={16} />
                {battery !== undefined && <span>{battery}%</span>}
              </button>
              <button class={`icon-btn ${syncing ? 'spin' : ''}`} disabled={disabled} onClick={doSync} aria-label="Sync now">
                <SyncIcon size={20} />
              </button>
            </div>
          )}
        </header>

        {applyUpdate && (
          <button class="banner update" disabled={!!busy} onClick={() => applyUpdate()}>
            A new version is ready. <strong>Tap to update</strong>
          </button>
        )}
        {support && <div class="banner error">{support}</div>}
        {!support && radio === false && (
          <div class="banner error">Bluetooth is unavailable. Turn it on and allow Chrome the "Nearby devices" permission.</div>
        )}
        {busy && (
          <div class="banner busy">
            <span class="spinner" /> <span class="grow">{busy}</span>
            {abort.current && busy.startsWith('Downloading') && (
              <button class="link" onClick={() => abort.current?.abort()}>
                Cancel
              </button>
            )}
          </div>
        )}
        {error && (
          <div class="banner error" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {notice && (
          <div class="banner ok" onClick={() => setNotice(null)}>
            {notice}
          </div>
        )}
        {ring && !ring.keyBackedUp && (
          <button class="banner warn" onClick={() => setTab('ring')}>
            <KeyIcon size={18} /> <span class="grow">Back up your ring key so you never have to reset the ring again.</span> <ChevronIcon size={16} />
          </button>
        )}
      </div>

      <main>
        {!ring && <Onboarding run={run} disabled={disabled} onPaired={refresh} />}
        {ring && tab === 'today' && <Today summary={summary} sync={sync} ring={ring} run={run} disabled={disabled} onSync={doSync} onOpenSleep={() => setTab('sleep')} />}
        {ring && tab === 'sleep' && <SleepTab summary={summary} />}
        {ring && tab === 'exercise' && <ExerciseTab summary={summary} />}
        {ring && tab === 'trends' && <Trends summary={summary} />}
        {ring && tab === 'ring' && (
          <RingTab ring={ring} sync={sync} battery={battery} connected={connected} run={run} disabled={disabled} onChange={refresh} />
        )}
        <p class="version">Open Ring {versionLabel()}</p>
      </main>

      {ring && (
        <nav class="tabs">
          {(
            [
              ['today', 'Today', TodayIcon],
              ['sleep', 'Sleep', MoonIcon],
              ['exercise', 'Exercise', ExerciseIcon],
              ['trends', 'Trends', TrendsIcon],
            ] as const
          ).map(([t, label, Icon]) => (
            <button key={t} class={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              <Icon size={22} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ setup */

function LogView() {
  const [log, setLog] = useState<readonly LogEntry[]>([]);
  useEffect(() => {
    const update = () => setLog([...protocolLog.entries()]);
    update();
    return protocolLog.subscribe(update);
  }, []);
  return (
    <pre class="log">
      {log
        .slice(-200)
        .map((l) => `${new Date(l.t).toLocaleTimeString()} ${l.dir === 'tx' ? '→' : l.dir === 'rx' ? '←' : '•'} ${l.text}`)
        .join('\n') || 'Nothing yet.'}
    </pre>
  );
}

function Troubleshoot() {
  const [all, setAll] = useState(session.showAllDevices);
  const [showLog, setShowLog] = useState(false);
  return (
    <details class="card trouble">
      <summary>
        <span>Having trouble connecting?</span>
        <ChevronIcon size={16} class="chev" />
      </summary>
      <ul class="tips">
        <li>
          The ring is listed as <strong>"Oura"</strong> and a long number, not "Oura Ring 4".
        </li>
        <li>Use Google Chrome. Brave and Samsung Internet can't reach Bluetooth devices.</li>
        <li>Give Chrome the "Nearby devices" permission: Settings → Apps → Chrome → Permissions.</li>
        <li>Force-stop or uninstall the Oura app, and forget every "Oura" entry in Bluetooth settings.</li>
        <li>If Android asks to pair, tap Pair (it can appear as a notification).</li>
        <li>Lift the ring off the charger and set it back: it advertises best right after.</li>
      </ul>
      <label class="check">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => {
            session.showAllDevices = (e.target as HTMLInputElement).checked;
            setAll(session.showAllDevices);
          }}
        />
        Show every nearby Bluetooth device in the picker
      </label>
      <button class="ghost" onClick={() => setShowLog(!showLog)}>
        {showLog ? 'Hide' : 'Show'} Bluetooth log
      </button>
      {showLog && <LogView />}
    </details>
  );
}

function Onboarding({ run, disabled, onPaired }: { run: Run; disabled: boolean; onPaired: () => void }) {
  const [probeResult, setProbe] = useState<ProbeResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [keyHex, setKeyHex] = useState('');
  const [showKey, setShowKey] = useState(false);
  const found = !!probeResult?.serial;

  return (
    <>
      <section class="hero-setup">
        <div class="ring-art" aria-hidden="true">
          <span />
        </div>
        <h2>Your ring, your data</h2>
        <p class="muted">Sync your Oura Ring straight to this phone over Bluetooth. No account, no cloud.</p>
      </section>

      <section class={`card step ${found ? 'done' : ''}`}>
        <div class="step-head">
          <span class="step-num">{found ? '✓' : '1'}</span>
          <div>
            <h3>Find your ring</h3>
            <p class="muted small">Read-only. Nothing on the ring changes.</p>
          </div>
        </div>
        {found ? (
          <div class="found">
            <p>
              <strong>{probeResult!.deviceName ?? 'Oura ring'}</strong>
            </p>
            <p class="muted small">
              {probeResult!.hardwareId ?? '?'} · firmware {probeResult!.firmware?.firmware_version ?? '?'}
            </p>
          </div>
        ) : (
          <button class="primary wide" disabled={disabled} onClick={() => run('Looking for your ring…', async (step) => setProbe(await probe(session, step)))}>
            <BluetoothIcon size={18} /> Find ring
          </button>
        )}
        {probeResult && probeResult.errors.length > 0 && <p class="small muted">{probeResult.errors.join('; ')}</p>}
      </section>

      <section class={`card step ${found ? '' : 'dim'}`}>
        <div class="step-head">
          <span class="step-num">2</span>
          <div>
            <h3>Pair</h3>
            <p class="muted small">Installs this phone's private key on the ring.</p>
          </div>
        </div>
        <ul class="tips">
          <li>The ring must be factory-reset (Oura app → My Devices → Factory reset), after backing up your data in the Oura app.</li>
          <li>Afterwards, don't set the ring up in the Oura app again. That would replace this app's key.</li>
        </ul>
        <label class="check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed((e.target as HTMLInputElement).checked)} />
          My data is backed up and the ring has been factory reset
        </label>
        <button
          class="primary wide"
          disabled={disabled || !confirmed}
          onClick={() =>
            run('Pairing…', async (step) => {
              await pairFreshRing(session, step);
            }).finally(onPaired)
          }
        >
          Pair ring
        </button>
      </section>

      <Troubleshoot />

      <details class="card trouble" open={showKey} onToggle={(e) => setShowKey((e.target as HTMLDetailsElement).open)}>
        <summary>
          <span>I already have a ring key</span>
          <ChevronIcon size={16} class="chev" />
        </summary>
        <p class="muted small">Paste a 32-character key from a backup, or from `oura pair` on a computer.</p>
        <input class="mono" placeholder="32 hex characters" value={keyHex} onInput={(e) => setKeyHex((e.target as HTMLInputElement).value)} />
        <button
          class="wide"
          disabled={disabled || keyHex.trim().length !== 32}
          onClick={() =>
            run('Verifying key…', async (step) => {
              await importKey(session, step, keyHex.trim());
            }).finally(onPaired)
          }
        >
          Connect with key
        </button>
      </details>
    </>
  );
}

/* ------------------------------------------------------------------ today */

interface MetricDef {
  key: string;
  label: string;
  Icon: (p: { size?: number }) => preact.JSX.Element;
  color: string;
  unit: string;
  digits: number;
  pick: (n: Night) => number | undefined;
  /** Whether a higher value is the better direction (for delta coloring). */
  higherIsBetter?: boolean;
  /** Show the value as a signed difference from baseline instead of absolute. */
  relative?: boolean;
}

const METRICS: MetricDef[] = [
  { key: 'hrv', label: 'Heart rate variability', Icon: WaveIcon, color: 'var(--hrv)', unit: 'ms', digits: 0, pick: (n) => n.avgHrv, higherIsBetter: true },
  { key: 'rhr', label: 'Lowest heart rate', Icon: HeartIcon, color: 'var(--hr)', unit: 'bpm', digits: 0, pick: (n) => n.lowestHr, higherIsBetter: false },
  { key: 'spo2', label: 'Blood oxygen', Icon: DropIcon, color: 'var(--o2)', unit: '%', digits: 0, pick: (n) => n.spo2, higherIsBetter: true },
  { key: 'breath', label: 'Respiratory rate', Icon: LungsIcon, color: 'var(--breath)', unit: '/min', digits: 1, pick: (n) => n.breathRate },
  { key: 'temp', label: 'Skin temperature', Icon: ThermometerIcon, color: 'var(--temp)', unit: '°C', digits: 1, pick: (n) => n.skinTemp, relative: true },
];

function Delta({ value, base, digits, unit, higherIsBetter }: { value?: number; base?: Baseline; digits: number; unit: string; higherIsBetter?: boolean }) {
  if (value === undefined || !base) return <span class="delta">building baseline</span>;
  const d = value - base.avg;
  const threshold = Math.max(10 ** -digits, Math.abs(base.avg) * 0.03);
  if (Math.abs(d) < threshold) return <span class="delta">typical for you</span>;
  const good = higherIsBetter === undefined ? undefined : d > 0 === higherIsBetter;
  return (
    <span class={`delta ${good === undefined ? '' : good ? 'up' : 'down'}`}>
      {d > 0 ? '▲' : '▼'} {Math.abs(d).toFixed(digits)}
      {unit === '%' ? ' pts' : ` ${unit}`} vs usual
    </span>
  );
}

function MetricRow({ m, night, nights }: { m: MetricDef; night: Night; nights: Night[] }) {
  const value = m.pick(night);
  const base = baseline(nights, m.pick);
  const shown =
    value === undefined ? '–' : m.relative && base ? `${value - base.avg >= 0 ? '+' : '−'}${Math.abs(value - base.avg).toFixed(m.digits)}` : value.toFixed(m.digits);
  return (
    <div class="metric">
      <span class="metric-icon" style={{ color: m.color }}>
        <m.Icon size={20} />
      </span>
      <div class="metric-body">
        <div class="metric-top">
          <span class="metric-label">{m.label}</span>
          <span class="metric-value">
            {shown}
            {value !== undefined && <small>{m.unit}</small>}
          </span>
        </div>
        <RangeBar value={value} min={base && Math.min(base.min, value ?? base.min)} max={base && Math.max(base.max, value ?? base.max)} color={m.color} />
        {m.relative && !base ? <span class="delta">building baseline</span> : !m.relative && <Delta value={value} base={base} digits={m.digits} unit={m.unit} higherIsBetter={m.higherIsBetter} />}
        {m.relative && base && <span class="delta">vs your usual {base.avg.toFixed(1)} °C</span>}
      </div>
    </div>
  );
}

function Card({ title, Icon, color, right, children, class: cls = '' }: { title: string; Icon?: MetricDef['Icon']; color?: string; right?: ComponentChildren; children: ComponentChildren; class?: string }) {
  return (
    <section class={`card ${cls}`}>
      <div class="card-head">
        <h2>
          {Icon && (
            <span class="card-icon" style={{ color }}>
              <Icon size={18} />
            </span>
          )}
          {title}
        </h2>
        {right}
      </div>
      {children}
    </section>
  );
}

function Today({
  summary,
  sync,
  ring,
  run,
  disabled,
  onSync,
  onOpenSleep,
}: {
  summary: Summary | null;
  sync: SyncState | null;
  ring: RingRecord;
  run: Run;
  disabled: boolean;
  onSync: () => void;
  onOpenSleep: () => void;
}) {
  const [live, setLive] = useState<number | null>(null);
  const [measuring, setMeasuring] = useState(false);
  const liveAbort = useRef<AbortController | null>(null);
  const nights = summary?.nights ?? [];
  const night = nights.at(-1);
  const today = dayKey(Date.now() / 1000);
  const day = summary?.days.find((d) => d.key === today);
  const sleepBase = baseline(nights, (n) => n.sleepHours);
  const scores = useMemo(
    () => ({
      readiness: readinessScore(nights, summary?.days ?? [], SLEEP_GOAL_H),
      sleep: sleepScore(nights),
      activity: activityScore(summary?.days ?? [], today),
    }),
    [summary, today],
  );
  const bubbles: ScoreBubble[] = [
    { label: 'Readiness', value: scores.readiness?.score, Icon: TodayIcon, crown: (scores.readiness?.score ?? 0) >= 85 },
    { label: 'Sleep', value: scores.sleep?.score, Icon: MoonIcon, crown: (scores.sleep?.score ?? 0) >= 85 },
    { label: 'Activity', value: scores.activity?.score, Icon: BoltIcon, crown: (scores.activity?.score ?? 0) >= 85 },
    { label: 'HRV', value: night?.avgHrv, unit: 'ms', Icon: WaveIcon },
    { label: 'Resting HR', value: night?.lowestHr, unit: 'bpm', Icon: HeartIcon },
    { label: 'Blood O₂', value: night?.spo2, unit: '%', Icon: DropIcon },
  ];

  if (!sync?.lastSyncUnix) {
    return (
      <section class="card empty">
        <div class="ring-art small" aria-hidden="true">
          <span />
        </div>
        <h2>Ready for your first sync</h2>
        <p class="muted">The ring stores several days of readings. The first sync can take a few minutes; keep this screen open.</p>
        <button class="primary wide" disabled={disabled} onClick={onSync}>
          <SyncIcon size={18} /> Sync now
        </button>
      </section>
    );
  }

  return (
    <>
      <ReadinessHero readiness={scores.readiness} bubbles={bubbles} seed={night?.key ?? today} />

      <section class="card hero tappable" role="button" tabIndex={0} onClick={onOpenSleep} onKeyDown={(e) => e.key === 'Enter' && onOpenSleep()}>
        <div class="hero-label">
          <MoonIcon size={16} /> Last night <ChevronIcon size={14} />
        </div>
        {night ? (
          <>
            <Gauge value={(night.sleepHours ?? 0) / SLEEP_GOAL_H} from="#8f7dff" to="#62d0ff">
              <span class="gauge-value">{night.sleepHours !== undefined ? fmtDuration(night.sleepHours) : '–'}</span>
              <span class="gauge-label">in bed</span>
            </Gauge>
            {night.bedtimeStart ? (
              <p class="hero-sub">
                {fmtTime(night.bedtimeStart)} <span class="arrow">→</span> {fmtTime(night.bedtimeEnd)}
              </p>
            ) : (
              <p class="hero-sub muted">Bedtime appears after the ring finishes its sleep analysis.</p>
            )}
            {sleepBase && night.sleepHours !== undefined && (
              <p class="hero-note">
                {night.sleepHours >= sleepBase.avg ? 'More' : 'Less'} than your {fmtDuration(sleepBase.avg)} average
              </p>
            )}
          </>
        ) : (
          <p class="muted center">Wear the ring tonight and sync in the morning to see your sleep.</p>
        )}
      </section>

      {night && (
        <section class="card">
          <div class="card-head">
            <h2>Overnight signals</h2>
            <span class="muted small">{shortDay(night.key)}, {night.key.slice(5).replace('-', '/')}</span>
          </div>
          <div class="metrics">
            {METRICS.map((m) => (
              <MetricRow key={m.key} m={m} night={night} nights={nights} />
            ))}
          </div>
        </section>
      )}

      <Card
        title="Heart rate"
        class="compact"
        Icon={HeartIcon}
        color="var(--hr)"
        right={
          <span class="big-inline">
            {live ?? day?.medianHr ?? '–'}
            <small>{live ? 'bpm live' : 'bpm today'}</small>
          </span>
        }
      >
        {measuring ? (
          <button class="wide live-btn active" onClick={() => liveAbort.current?.abort()}>
            <span class="pulse" /> Measuring… tap to stop
          </button>
        ) : (
          <button
            class="wide live-btn"
            disabled={disabled}
            onClick={() =>
              run('Measuring heart rate…', async (step) => {
                liveAbort.current = new AbortController();
                setMeasuring(true);
                try {
                  await liveHeartRate(session, ring, step, 60, setLive, liveAbort.current.signal);
                } finally {
                  liveAbort.current = null;
                  setMeasuring(false);
                }
              })
            }
          >
            <HeartIcon size={18} /> Measure now
          </button>
        )}
      </Card>

      <Card title="Activity" Icon={BoltIcon} color="var(--activity)">
        <div class="activity">
          <Gauge value={Math.min(1, ((day?.avgMet ?? 1) - 1) / 2)} size={92} stroke={9} from="#5be3a0" to="#d6f56b">
            <span class="gauge-value small">{day?.avgMet?.toFixed(1) ?? '–'}</span>
          </Gauge>
          <div>
            <p class="activity-title">Average intensity today</p>
            <p class="muted small">In METs: 1 is resting, around 3 is a brisk walk.</p>
          </div>
        </div>
      </Card>

      {summary && !summary.anchored && <p class="footnote">Times are estimated until the ring records a clock reference.</p>}
      <p class="footnote">Synced {fmtAgo(sync.lastSyncUnix)}</p>
    </>
  );
}

/* ----------------------------------------------------------------- trends */

const TREND_DEFS: { title: string; Icon: MetricDef['Icon']; color: string; hex: string; unit: string; digits: number; pick: (n: Night) => number | undefined }[] = [
  { title: 'Heart rate variability', Icon: WaveIcon, color: 'var(--hrv)', hex: '#5fd4c4', unit: 'ms', digits: 0, pick: (n) => n.avgHrv },
  { title: 'Lowest heart rate', Icon: HeartIcon, color: 'var(--hr)', hex: '#ff7a8a', unit: 'bpm', digits: 0, pick: (n) => n.lowestHr },
  { title: 'Time in bed', Icon: MoonIcon, color: 'var(--sleep)', hex: '#a89cff', unit: 'h', digits: 1, pick: (n) => n.sleepHours },
  { title: 'Blood oxygen', Icon: DropIcon, color: 'var(--o2)', hex: '#6cb8ff', unit: '%', digits: 0, pick: (n) => n.spo2 },
  { title: 'Respiratory rate', Icon: LungsIcon, color: 'var(--breath)', hex: '#9be7ff', unit: '/min', digits: 1, pick: (n) => n.breathRate },
  { title: 'Skin temperature', Icon: ThermometerIcon, color: 'var(--temp)', hex: '#ffb86b', unit: '°C', digits: 2, pick: (n) => n.skinTemp },
];

function Trends({ summary }: { summary: Summary | null }) {
  const [range, setRange] = useState<7 | 14 | 30>(14);
  const nights = (summary?.nights ?? []).slice(-range);
  if (nights.length < 2) {
    return (
      <section class="card empty">
        <h2>Trends are on their way</h2>
        <p class="muted">After a couple of nights with the ring you'll see how your signals change over time.</p>
      </section>
    );
  }
  const toX = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d).getTime() / 1000;
  };
  const step = Math.max(1, Math.ceil(nights.length / 6));
  const xLabels = nights.filter((_, i) => i % step === 0).map((n) => ({ x: toX(n.key), label: range === 7 ? shortDay(n.key) : n.key.slice(5).replace('-', '/') }));

  return (
    <>
      <div class="segmented">
        {([7, 14, 30] as const).map((r) => (
          <button key={r} class={range === r ? 'active' : ''} onClick={() => setRange(r)}>
            {r} days
          </button>
        ))}
      </div>
      {TREND_DEFS.map((t) => {
        const pts = nights.map((n) => ({ x: toX(n.key), y: t.pick(n) })).filter((p): p is { x: number; y: number } => p.y !== undefined);
        const avg = pts.length ? pts.reduce((a, p) => a + p.y, 0) / pts.length : undefined;
        const latest = pts.at(-1)?.y;
        return (
          <Card
            key={t.title}
            title={t.title}
            Icon={t.Icon}
            color={t.color}
            right={
              <span class="big-inline">
                {latest?.toFixed(t.digits) ?? '–'}
                <small>{t.unit}</small>
              </span>
            }
          >
            <AreaChart points={pts} color={t.hex} height={110} xLabels={xLabels} />
            {avg !== undefined && (
              <p class="muted small">
                Average {avg.toFixed(t.digits)} {t.unit} over {pts.length} nights
              </p>
            )}
          </Card>
        );
      })}
    </>
  );
}

/* ------------------------------------------------------------------- ring */

function Row({ Icon, label, value, onClick, children }: { Icon?: MetricDef['Icon']; label: string; value?: ComponentChildren; onClick?: () => void; children?: ComponentChildren }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag class={`row-item ${onClick ? 'tappable' : ''}`} onClick={onClick}>
      {Icon && (
        <span class="row-icon">
          <Icon size={18} />
        </span>
      )}
      <span class="row-label">{label}</span>
      <span class="row-value">{value}</span>
      {children}
      {onClick && <ChevronIcon size={16} class="row-chev" />}
    </Tag>
  );
}

function RingTab({
  ring,
  sync,
  battery,
  connected,
  run,
  disabled,
  onChange,
}: {
  ring: RingRecord;
  sync: SyncState | null;
  battery?: number;
  connected: boolean;
  run: Run;
  disabled: boolean;
  onChange: () => void;
}) {
  const [features, setFeatures] = useState<Awaited<ReturnType<typeof readFeatures>> | null>(null);
  const [counts, setCounts] = useState<[string, number][] | null>(null);
  const [showKey, setShowKey] = useState(false);
  const [showLog, setShowLog] = useState(false);

  const markBackedUp = async () => {
    await saveRing({ ...ring, keyBackedUp: true });
    onChange();
  };

  return (
    <>
      <section class="card device">
        <div class="ring-art" aria-hidden="true">
          <span />
        </div>
        <div>
          <h2>{ring.deviceName ?? 'Oura ring'}</h2>
          <p class="muted small">
            {connected ? 'Connected' : `Synced ${fmtAgo(sync?.lastSyncUnix)}`} · {ring.hardwareId ?? 'ring'}
          </p>
          {battery !== undefined && (
            <p class="battery">
              <BatteryIcon level={battery} size={22} /> {battery}%
            </p>
          )}
        </div>
      </section>

      <h3 class="section-title">Measurements</h3>
      <section class="card list-card">
        {features ? (
          features.map((f) => (
            <Row key={f.id} label={f.label}>
              {f.status ? (
                <label class="switch">
                  <input
                    type="checkbox"
                    checked={f.status.mode !== 0}
                    disabled={disabled}
                    onChange={(e) =>
                      run('Updating…', async (step) => {
                        await setFeature(session, ring, step, f.id, (e.target as HTMLInputElement).checked);
                        setFeatures(await readFeatures(session, ring, step));
                      })
                    }
                  />
                  <span />
                </label>
              ) : (
                <span class="small muted">{f.error ?? 'unavailable'}</span>
              )}
            </Row>
          ))
        ) : (
          <Row Icon={RingIcon} label="Read measurement settings" onClick={() => !disabled && run('Reading settings…', async (step) => setFeatures(await readFeatures(session, ring, step)))} />
        )}
      </section>
      {features && <p class="footnote left">Steps must be on before workout heart rate can be enabled.</p>}

      <h3 class="section-title">Ring key</h3>
      <section class="card">
        <p class="muted small">
          This private key is how this phone proves it owns the ring. Keep a copy in a password manager; it also works with the open_oura CLI's <code>--key-file</code>.
        </p>
        {showKey && <p class="mono keybox">{ring.keyHex}</p>}
        <div class="btn-row">
          <button onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide' : 'Show'}</button>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(ring.keyHex);
              await markBackedUp();
            }}
          >
            Copy
          </button>
          <button
            class="primary"
            onClick={async () => {
              download(`oura-${ring.serial}.key`, new Blob([`${ring.keyHex}\n`], { type: 'text/plain' }));
              await markBackedUp();
            }}
          >
            Download
          </button>
        </div>
      </section>

      <h3 class="section-title">Data</h3>
      <section class="card list-card">
        <Row label="Export all data" onClick={async () => download(`open-ring-${ring.serial}-${dayKey(Date.now() / 1000)}.json`, await exportAll(ring.serial))} />
        <Row label="Stored readings by type" onClick={async () => setCounts([...(await eventCounts(ring.serial)).entries()].sort((a, b) => b[1] - a[1]))} />
        <Row
          label="Re-download from the ring"
          onClick={async () => {
            if (disabled) return;
            if (!confirm('Re-download everything still stored on the ring on the next sync? Existing data is kept; duplicates are ignored.')) return;
            await resetCursor(ring.serial);
            onChange();
          }}
        />
        {counts &&
          counts.map(([name, n]) => (
            <Row key={name} label={name} value={n.toLocaleString()} />
          ))}
      </section>

      <h3 class="section-title">Device</h3>
      <section class="card list-card">
        <Row label="Serial" value={<span class="mono small">{ring.serial}</span>} />
        <Row label="Firmware" value={ring.firmware?.firmware_version ?? '–'} />
        <Row label="Paired" value={new Date(ring.pairedAt * 1000).toLocaleDateString()} />
        <Row label={showLog ? 'Hide Bluetooth log' : 'Bluetooth log'} onClick={() => setShowLog(!showLog)} />
        {showLog && <LogView />}
        {connected && <Row label="Disconnect" onClick={() => session.disconnect()} />}
        <button
          class="row-item tappable danger-text"
          onClick={async () => {
            if (!confirm('Remove this ring and all its data from this phone? Back up the key first, or you will need to factory-reset the ring to pair again.')) return;
            await forgetRing(ring.serial);
            session.disconnect();
            onChange();
          }}
        >
          <span class="row-label">Forget ring</span>
        </button>
      </section>
    </>
  );
}
