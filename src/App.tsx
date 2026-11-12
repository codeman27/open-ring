import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
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
  FEATURE_ROWS,
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
import { RingClock, SUMMARY_TAGS, dayKey, summarize, type Summary } from './timeline';
import { Bars, LineChart } from './charts';
import { versionLabel } from './version';

const session = new RingSession();

type Tab = 'today' | 'trends' | 'ring';

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
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

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
  const abort = useRef<AbortController | null>(null);
  const support = bluetoothSupport();
  const [radio, setRadio] = useState<boolean | undefined>(undefined);

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
        setError(`${errText(e)}. Use "Pair a factory-reset ring" under the Ring tab.`);
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
      setNotice(`Synced ${r.eventsSynced.toLocaleString()} events in ${r.seconds.toFixed(0)} s.`);
      await refresh();
    });

  if (ring === undefined) return <div class="app" />;

  return (
    <div class="app">
      <div class="sticky">
      <header class="top">
        <div class="brand">
          <span class="logo" aria-hidden="true" />
          <div>
            <h1>Open Ring</h1>
            <p class="small muted">
              {ring ? `${ring.deviceName ?? 'Oura ring'} · ${connected ? 'connected' : `synced ${fmtAgo(sync?.lastSyncUnix)}`}` : 'Not paired'}
              {battery !== undefined && ring ? ` · ${battery}%` : ''}
            </p>
          </div>
        </div>
        {ring && (
          <button class="primary" disabled={!!busy || !!support} onClick={doSync}>
            Sync
          </button>
        )}
      </header>

      {support && <div class="banner error">{support}</div>}
      {!support && radio === false && (
        <div class="banner error">
          Chrome reports no usable Bluetooth. Turn Bluetooth on, and make sure Chrome has the "Nearby devices" permission (Android Settings → Apps → Chrome → Permissions).
        </div>
      )}
      {busy && (
        <div class="banner busy">
          <span class="spinner" /> {busy}
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
        <div class="banner warn">
          Back up your ring key (Ring tab). Without it, clearing this browser's data means factory-resetting the ring to pair again.
        </div>
      )}
      </div>

      <main>
        {!ring && <Onboarding run={run} disabled={!!busy || !!support} onPaired={refresh} />}
        {ring && tab === 'today' && <Today summary={summary} sync={sync} ring={ring} run={run} disabled={!!busy || !!support} />}
        {ring && tab === 'trends' && <Trends summary={summary} />}
        {ring && tab === 'ring' && <RingTab ring={ring} sync={sync} run={run} disabled={!!busy || !!support} onChange={refresh} />}
        <p class="version small muted center">Open Ring {versionLabel()}</p>
      </main>

      {ring && (
        <nav class="tabs">
          {(['today', 'trends', 'ring'] as Tab[]).map((t) => (
            <button key={t} class={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
              {t === 'today' ? 'Today' : t === 'trends' ? 'Trends' : 'Ring'}
            </button>
          ))}
        </nav>
      )}
    </div>
  );
}

type Run = <T>(label: string, fn: (step: (m: string) => void) => Promise<T>) => Promise<T | undefined>;

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
        .join('\n') || 'Nothing yet. Tap Check connection, then come back here.'}
    </pre>
  );
}

function Troubleshoot() {
  const [all, setAll] = useState(session.showAllDevices);
  const [showLog, setShowLog] = useState(false);
  return (
    <details class="card trouble">
      <summary>Ring not showing up?</summary>
      <ol class="steps small">
        <li>
          The ring lists as <strong>"Oura"</strong> followed by a long number (for example <span class="mono">Oura 4016…</span>), not "Oura Ring 4".
        </li>
        <li>Bluetooth on. On Android 11 or older, Location must be on too.</li>
        <li>Chrome needs the "Nearby devices" permission: Android Settings → Apps → Chrome → Permissions → Nearby devices → Allow.</li>
        <li>
          Stop the Oura app so it can't grab the ring: long-press its icon → App info → Force stop (or uninstall it). A ring can only talk to one app at a time.
        </li>
        <li>In Android Bluetooth settings, forget every "Oura" entry, including under "Previously connected devices". A leftover bond from the Oura app causes "GATT operations failed".</li>
        <li>Lift the ring off the charger and set it back on: it advertises most reliably right after that.</li>
      </ol>
      <label class="check">
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => {
            session.showAllDevices = (e.target as HTMLInputElement).checked;
            setAll(session.showAllDevices);
          }}
        />
        Show all nearby Bluetooth devices in the picker (use this if the ring still isn't listed)
      </label>
      <button onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide' : 'Show'} Bluetooth log</button>
      {showLog && <LogView />}
    </details>
  );
}

function Onboarding({ run, disabled, onPaired }: { run: Run; disabled: boolean; onPaired: () => void }) {
  const [probeResult, setProbe] = useState<ProbeResult | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [keyHex, setKeyHex] = useState('');

  return (
    <>
      <Troubleshoot />
      <section class="card">
        <h2>1. Check the connection</h2>
        <p class="muted">
          Reads the ring's firmware, serial and capabilities. Nothing on the ring changes. Works on a freshly reset ring too.
        </p>
        <button disabled={disabled} onClick={() => run('Checking…', async (step) => setProbe(await probe(session, step)))}>
          Check connection
        </button>
        {probeResult && (
          <dl class="kv">
            <dt>Device</dt>
            <dd>{probeResult.deviceName ?? '–'}</dd>
            <dt>Serial</dt>
            <dd>{probeResult.serial ?? '–'}</dd>
            <dt>Hardware</dt>
            <dd>{probeResult.hardwareId ?? '–'}</dd>
            <dt>Firmware</dt>
            <dd>{probeResult.firmware?.firmware_version ?? '–'}</dd>
            <dt>Capabilities</dt>
            <dd class="mono small">{probeResult.capabilities.map((c) => `${c.feature}:${c.value}`).join(' ') || '–'}</dd>
            {probeResult.errors.length > 0 && (
              <>
                <dt>Errors</dt>
                <dd class="small">{probeResult.errors.join('; ')}</dd>
              </>
            )}
          </dl>
        )}
      </section>

      <section class="card">
        <h2>2. Pair a factory-reset ring</h2>
        <ol class="steps">
          <li>In the Oura app, sync, then Menu → Settings → Back up all data.</li>
          <li>Oura app → My Devices → Factory reset. Do not tap "Continue" or set the ring up again in the Oura app afterwards: that installs Oura's key and locks this app out.</li>
          <li>In Android Bluetooth settings, forget the Oura ring. Consider uninstalling the Oura app so it won't reclaim the ring.</li>
          <li>Keep the ring on its charger nearby, then pair below. Android may ask to confirm Bluetooth pairing; accept it.</li>
        </ol>
        <label class="check">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed((e.target as HTMLInputElement).checked)} />
          My data is backed up and the ring has been factory reset.
        </label>
        <button
          class="primary"
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

      <section class="card">
        <h2>Already have a key?</h2>
        <p class="muted small">
          Paste a 32-character key from an earlier pairing, such as a backup from this app or <code>oura pair</code> on Linux.
        </p>
        <input class="mono" placeholder="32 hex characters" value={keyHex} onInput={(e) => setKeyHex((e.target as HTMLInputElement).value)} />
        <button
          disabled={disabled || keyHex.trim().length !== 32}
          onClick={() =>
            run('Verifying key…', async (step) => {
              await importKey(session, step, keyHex.trim());
              onPaired();
            })
          }
        >
          Connect with key
        </button>
      </section>
    </>
  );
}

function Stat({ label, value, unit, hint }: { label: string; value?: number | string; unit?: string; hint?: string }) {
  return (
    <div class="stat">
      <span class="stat-label">{label}</span>
      <span class="stat-value">
        {value ?? '–'}
        {value !== undefined && unit ? <small>{unit}</small> : null}
      </span>
      {hint && <span class="small muted">{hint}</span>}
    </div>
  );
}

function Today({ summary, sync, ring, run, disabled }: { summary: Summary | null; sync: SyncState | null; ring: RingRecord; run: Run; disabled: boolean }) {
  const [live, setLive] = useState<number | null>(null);
  const liveAbort = useRef<AbortController | null>(null);
  const night = summary?.nights.at(-1);
  const today = dayKey(Date.now() / 1000);
  const day = summary?.days.find((d) => d.key === today);
  const temps = summary?.nights.map((n) => n.skinTemp).filter((t): t is number => t !== undefined) ?? [];
  const tempBaseline = temps.length > 2 ? [...temps].sort((a, b) => a - b)[temps.length >> 1] : undefined;
  const hrToday = useMemo(
    () => (summary?.hrSeries ?? []).filter((p) => p.unix > Date.now() / 1000 - 86400).map((p) => ({ x: p.unix, y: p.bpm })),
    [summary],
  );

  if (!sync?.lastSyncUnix) {
    return (
      <section class="card">
        <h2>Ready to sync</h2>
        <p class="muted">Tap Sync to download what the ring has stored. The first sync can take a few minutes; keep this screen open.</p>
      </section>
    );
  }

  return (
    <>
      <section class="card">
        <h2>
          Last night <span class="small muted">{night?.key ?? ''}</span>
        </h2>
        {night ? (
          <>
            {night.bedtimeStart && (
              <p class="muted small">
                In bed {fmtTime(night.bedtimeStart)} – {fmtTime(night.bedtimeEnd)}
              </p>
            )}
            <div class="stats">
              <Stat label="Time in bed" value={night.sleepHours?.toFixed(1)} unit="h" />
              <Stat label="Lowest HR" value={night.lowestHr} unit="bpm" />
              <Stat label="HRV" value={night.avgHrv} unit="ms" />
              <Stat label="SpO2" value={night.spo2} unit="%" />
              <Stat label="Breathing" value={night.breathRate} unit="/min" />
              <Stat
                label="Skin temp"
                value={night.skinTemp !== undefined && tempBaseline !== undefined ? `${night.skinTemp - tempBaseline >= 0 ? '+' : ''}${(night.skinTemp - tempBaseline).toFixed(1)}` : night.skinTemp?.toFixed(1)}
                unit="°C"
                hint={tempBaseline !== undefined ? 'vs your median' : undefined}
              />
            </div>
          </>
        ) : (
          <p class="muted">No sleep recorded yet. Wear the ring overnight and sync in the morning.</p>
        )}
      </section>

      <section class="card">
        <h2>Heart rate, last 24 h</h2>
        <LineChart points={hrToday} unit=" bpm" color="var(--hr)" />
        <div class="row">
          <Stat label="Today's median" value={day?.medianHr} unit="bpm" />
          <Stat label="Live" value={live ?? undefined} unit="bpm" />
        </div>
        {liveAbort.current ? (
          <button onClick={() => liveAbort.current?.abort()}>Stop</button>
        ) : (
          <button
            disabled={disabled}
            onClick={() =>
              run('Live heart rate…', async (step) => {
                liveAbort.current = new AbortController();
                try {
                  await liveHeartRate(session, ring, step, 60, setLive, liveAbort.current.signal);
                } finally {
                  liveAbort.current = null;
                }
              })
            }
          >
            Measure live heart rate (60 s)
          </button>
        )}
      </section>

      <section class="card">
        <h2>Activity today</h2>
        <div class="stats">
          <Stat label="Average MET" value={day?.avgMet} hint="1 = resting" />
        </div>
      </section>

      {summary && !summary.anchored && (
        <p class="small muted center">Times are estimated from your last sync until the ring records a clock anchor.</p>
      )}
    </>
  );
}

function Trends({ summary }: { summary: Summary | null }) {
  const nights = (summary?.nights ?? []).slice(-14);
  const days = (summary?.days ?? []).slice(-14);
  if (!nights.length && !days.length) {
    return (
      <section class="card">
        <p class="muted">Trends appear after a few nights of data.</p>
      </section>
    );
  }
  return (
    <>
      <section class="card">
        <h2>HRV (nightly average)</h2>
        <Bars items={nights.map((n) => ({ label: n.key, value: n.avgHrv }))} unit=" ms" color="var(--accent)" />
      </section>
      <section class="card">
        <h2>Lowest heart rate</h2>
        <Bars items={nights.map((n) => ({ label: n.key, value: n.lowestHr }))} unit=" bpm" color="var(--hr)" />
      </section>
      <section class="card">
        <h2>Time in bed</h2>
        <Bars items={nights.map((n) => ({ label: n.key, value: n.sleepHours }))} unit=" h" digits={1} color="var(--sleep)" />
      </section>
      <section class="card">
        <h2>Blood oxygen</h2>
        <Bars items={nights.map((n) => ({ label: n.key, value: n.spo2 }))} unit="%" color="var(--o2)" />
      </section>
      <section class="card">
        <h2>Skin temperature</h2>
        <Bars items={nights.map((n) => ({ label: n.key, value: n.skinTemp }))} unit=" °C" digits={2} color="var(--temp)" />
      </section>
      <section class="card">
        <h2>Daytime median heart rate</h2>
        <Bars items={days.map((d) => ({ label: d.key, value: d.medianHr }))} unit=" bpm" color="var(--hr)" />
      </section>
    </>
  );
}

function RingTab({ ring, sync, run, disabled, onChange }: { ring: RingRecord; sync: SyncState | null; run: Run; disabled: boolean; onChange: () => void }) {
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
      <section class="card">
        <h2>Ring</h2>
        <dl class="kv">
          <dt>Serial</dt>
          <dd>{ring.serial}</dd>
          <dt>Hardware</dt>
          <dd>{ring.hardwareId ?? '–'}</dd>
          <dt>Firmware</dt>
          <dd>{ring.firmware?.firmware_version ?? '–'}</dd>
          <dt>Paired</dt>
          <dd>{new Date(ring.pairedAt * 1000).toLocaleDateString()}</dd>
          <dt>Last sync</dt>
          <dd>{fmtAgo(sync?.lastSyncUnix)}</dd>
        </dl>
      </section>

      <section class="card">
        <h2>Measurements</h2>
        <p class="muted small">What the ring records automatically. Reading or changing these connects to the ring.</p>
        {features ? (
          <ul class="list">
            {features.map((f) => (
              <li key={f.id}>
                <span>{f.label}</span>
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
              </li>
            ))}
          </ul>
        ) : (
          <button disabled={disabled} onClick={() => run('Reading features…', async (step) => setFeatures(await readFeatures(session, ring, step)))}>
            Read measurement settings
          </button>
        )}
        {features && FEATURE_ROWS.length > 0 && <p class="small muted">Steps must be on before workout heart rate can be enabled.</p>}
      </section>

      <section class="card">
        <h2>Ring key</h2>
        <p class="muted small">
          This 16-byte key is what lets this app talk to your ring. Keep a copy somewhere safe (a password manager is ideal). It works with the open_oura CLI's
          <code>--key-file</code> too.
        </p>
        {showKey && <p class="mono keybox">{ring.keyHex}</p>}
        <div class="row wrap">
          <button onClick={() => setShowKey(!showKey)}>{showKey ? 'Hide key' : 'Show key'}</button>
          <button
            onClick={async () => {
              await navigator.clipboard.writeText(ring.keyHex);
              await markBackedUp();
            }}
          >
            Copy
          </button>
          <button
            onClick={async () => {
              download(`oura-${ring.serial}.key`, new Blob([`${ring.keyHex}\n`], { type: 'text/plain' }));
              await markBackedUp();
            }}
          >
            Download .key
          </button>
        </div>
      </section>

      <section class="card">
        <h2>Data</h2>
        <div class="row wrap">
          <button onClick={async () => download(`open-ring-${ring.serial}-${dayKey(Date.now() / 1000)}.json`, await exportAll(ring.serial))}>Export all data</button>
          <button onClick={async () => setCounts([...(await eventCounts(ring.serial)).entries()].sort((a, b) => b[1] - a[1]))}>Event counts</button>
          <button
            disabled={disabled}
            onClick={async () => {
              if (!confirm('Re-download everything still stored on the ring on the next sync? Existing data is kept; duplicates are ignored.')) return;
              await resetCursor(ring.serial);
              onChange();
            }}
          >
            Re-sync from start
          </button>
        </div>
        {counts && (
          <ul class="list small">
            {counts.map(([name, n]) => (
              <li key={name}>
                <span class="mono">{name}</span>
                <span>{n.toLocaleString()}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section class="card">
        <h2>Diagnostics</h2>
        <div class="row wrap">
          <button onClick={() => setShowLog(!showLog)}>{showLog ? 'Hide' : 'Show'} Bluetooth log</button>
          <button disabled={!session.connected} onClick={() => session.disconnect()}>
            Disconnect
          </button>
          <button
            class="danger"
            onClick={async () => {
              if (!confirm('Remove this ring and all its data from this phone? Back up the key first, or you will need to factory-reset the ring to pair again.')) return;
              await forgetRing(ring.serial);
              session.disconnect();
              onChange();
            }}
          >
            Forget ring
          </button>
        </div>
        {showLog && <LogView />}
      </section>
    </>
  );
}
