/**
 * Turns stored ring events into calendar-dated daily metrics.
 *
 * Ring timestamps are a per-boot decisecond counter; `time_sync` (0x42) and
 * `rtc_beacon` (0x85) events carry the wall-clock time at a known counter value.
 * Each event is dated from its nearest anchor. This is a simplified form of
 * open_health's `ring_time.rs`, which additionally detects reboot epochs, stalled
 * and accelerated counters; until that is ported, rare reboot edge cases can be
 * misdated.
 */
import type { StoredEvent, SyncState } from './db';

export const TAG = {
  TIME_SYNC: 0x42,
  TEMP: 0x46,
  ACTIVITY: 0x50,
  HRV: 0x5d,
  IBI_AMP: 0x60,
  DEBUG_DATA: 0x61,
  TEMP_PERIOD: 0x69,
  SLEEP_PERIOD: 0x6a,
  SLEEP_PHASE_INFO: 0x4b,
  SLEEP_PHASE_DETAILS: 0x4e,
  SLEEP_PHASE_DATA: 0x5a,
  SPO2: 0x6f,
  SLEEP_TEMP: 0x75,
  BEDTIME: 0x76,
  GREEN_IBI: 0x80,
  RTC_BEACON: 0x85,
  SPO2_R_PI: 0x8b,
} as const;

export interface Anchor {
  ts: number;
  unix: number;
}

const FUTURE_SLACK_S = 6 * 3600;
const MIN_PLAUSIBLE_UNIX = 1_500_000_000;

export class RingClock {
  private anchors: Anchor[];

  constructor(
    anchors: Anchor[],
    private fallback?: Anchor,
    private now = Date.now() / 1000,
  ) {
    this.anchors = anchors
      .filter((a) => a.unix > MIN_PLAUSIBLE_UNIX && a.unix < now + FUTURE_SLACK_S)
      .sort((a, b) => a.ts - b.ts);
  }

  static fromEvents(anchorEvents: StoredEvent[], sync?: SyncState, now?: number): RingClock {
    const anchors: Anchor[] = [];
    for (const e of anchorEvents) {
      const unix = (e.decoded as { unix_time?: number } | null)?.unix_time;
      if ((e.tag === TAG.TIME_SYNC || e.tag === TAG.RTC_BEACON) && typeof unix === 'number') {
        anchors.push({ ts: e.ts, unix });
      }
    }
    const fallback =
      sync?.newestTs !== undefined && sync.lastSyncUnix !== undefined
        ? { ts: sync.newestTs, unix: sync.lastSyncUnix }
        : undefined;
    return new RingClock(anchors, fallback, now);
  }

  get anchored(): boolean {
    return this.anchors.length > 0;
  }

  /** Unix seconds for a ring timestamp, or null when it cannot be dated. */
  toUnix(ts: number): number | null {
    const a = this.nearest(ts) ?? this.fallback;
    if (!a) return null;
    const unix = a.unix + (ts - a.ts) / 10;
    return unix > this.now + FUTURE_SLACK_S || unix < MIN_PLAUSIBLE_UNIX ? null : unix;
  }

  private nearest(ts: number): Anchor | undefined {
    const xs = this.anchors;
    if (!xs.length) return undefined;
    let lo = 0;
    let hi = xs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (xs[mid].ts < ts) lo = mid + 1;
      else hi = mid;
    }
    const prev = xs[lo - 1];
    return prev && ts - prev.ts <= xs[lo].ts - ts ? prev : xs[lo];
  }
}

/** Local calendar day `YYYY-MM-DD`. */
export function dayKey(unix: number): string {
  const d = new Date(unix * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Nights are filed under the morning you woke up (sleep shifted forward 6 h). */
export const nightKey = (unix: number) => dayKey(unix + 6 * 3600);

/** Oura's in-app "SpO2 simple" curve for gen4 hardware (docs/spo2-calibration.md). */
export function spo2FromR(r: number): number {
  const v = -13.4 * r * r - 5.1 * r + 105.2;
  return Math.min(100, Math.max(85, v));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined);
const median = (xs: number[]) => {
  if (!xs.length) return undefined;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

export type Stage = 'deep' | 'light' | 'rem' | 'awake';

export const EPOCH_S = 30;

export interface StageStats {
  deepMin: number;
  lightMin: number;
  remMin: number;
  awakeMin: number;
  sleepMin: number;
  /** Minutes in bed before the first sleep epoch. */
  latencyMin: number;
  /** Asleep share of time in bed, 0..1. */
  efficiency: number;
  /** Awake share of the time after first falling asleep, 0..1. */
  wakeAfterOnset: number;
}

export function stageStats(epochs: Stage[]): StageStats | undefined {
  if (!epochs.length) return undefined;
  const min = (n: number) => Math.round((n * EPOCH_S) / 60);
  const count = (st: Stage) => epochs.filter((e) => e === st).length;
  const onset = epochs.findIndex((e) => e !== 'awake');
  const asleep = epochs.length - count('awake');
  const afterOnset = onset < 0 ? [] : epochs.slice(onset);
  return {
    deepMin: min(count('deep')),
    lightMin: min(count('light')),
    remMin: min(count('rem')),
    awakeMin: min(count('awake')),
    sleepMin: min(asleep),
    latencyMin: min(onset < 0 ? epochs.length : onset),
    efficiency: Math.round((asleep / epochs.length) * 100) / 100,
    wakeAfterOnset: afterOnset.length ? Math.round((afterOnset.filter((e) => e === 'awake').length / afterOnset.length) * 100) / 100 : 1,
  };
}

export interface Night {
  key: string;
  bedtimeStart?: number;
  bedtimeEnd?: number;
  sleepHours?: number;
  lowestHr?: number;
  avgHrv?: number;
  hrvSamples: number;
  avgSleepHr?: number;
  breathRate?: number;
  skinTemp?: number;
  spo2?: number;
  /** The ring's own 30 s hypnogram, starting at `start`. */
  stages?: { start: number; epochs: Stage[] };
  stageStats?: StageStats;
  hrSeries?: { unix: number; bpm: number }[];
  hrvSeries?: { unix: number; ms: number }[];
}

export interface Day {
  key: string;
  medianHr?: number;
  hrSamples: number;
  avgMet?: number;
}

export interface Summary {
  nights: Night[];
  days: Day[];
  hrSeries: { unix: number; bpm: number }[];
  /** One point per MET bin, at the bin's end time. */
  metSeries: { unix: number; met: number }[];
  battery?: { pct: number; unix: number };
  undated: number;
  anchored: boolean;
}

type Num = number[] | undefined;
const nums = (e: StoredEvent, field: string): number[] => ((e.decoded?.[field] as Num) ?? []).filter((x) => typeof x === 'number');

export function summarize(events: StoredEvent[], clock: RingClock): Summary {
  type Phases = { tag: number; unix: number; page: number; phases: Stage[] };
  type Building = Night & Required<Pick<Night, 'hrSeries' | 'hrvSeries'>>;
  const nights = new Map<string, Building & { _hr: number[]; _hrv: number[]; _shr: number[]; _br: number[]; _t: number[]; _o2: number[]; _ph: Phases[] }>();
  const days = new Map<string, { hr: number[]; met: number[] }>();
  const hrSeries: { unix: number; bpm: number }[] = [];
  const activity: { unix: number; met: number[] }[] = [];
  let battery: Summary['battery'];
  let undated = 0;

  const night = (key: string) => {
    let n = nights.get(key);
    if (!n) {
      n = { key, hrvSamples: 0, hrSeries: [], hrvSeries: [], _hr: [], _hrv: [], _shr: [], _br: [], _t: [], _o2: [], _ph: [] };
      nights.set(key, n);
    }
    return n;
  };
  const day = (key: string) => {
    let d = days.get(key);
    if (!d) days.set(key, (d = { hr: [], met: [] }));
    return d;
  };

  for (const e of events) {
    if (!e.decoded) continue;
    const unix = clock.toUnix(e.ts);
    if (unix === null) {
      undated++;
      continue;
    }
    switch (e.tag) {
      case TAG.HRV: {
        const n = night(nightKey(unix));
        const hr = nums(e, 'hr_bpm').filter((x) => x > 0);
        const rmssd = nums(e, 'rmssd_ms').filter((x) => x > 0);
        n._hr.push(...hr);
        n._hrv.push(...rmssd);
        n.hrvSamples += rmssd.length;
        // One sample per 5 min, the last at the event time.
        nums(e, 'rmssd_ms').forEach((ms, i, all) => ms > 0 && n.hrvSeries.push({ unix: unix - (all.length - 1 - i) * 300, ms }));
        break;
      }
      case TAG.SLEEP_PERIOD: {
        const n = night(nightKey(unix));
        const d = e.decoded as { average_hr?: number; breath?: number };
        if (d.average_hr) {
          n._shr.push(d.average_hr);
          n.hrSeries.push({ unix, bpm: d.average_hr });
        }
        if (d.breath) n._br.push(d.breath);
        break;
      }
      case TAG.SLEEP_PHASE_INFO:
      case TAG.SLEEP_PHASE_DETAILS:
      case TAG.SLEEP_PHASE_DATA: {
        const d = e.decoded as { header?: number; phases?: Stage[] };
        if (d.phases?.length) night(nightKey(unix))._ph.push({ tag: e.tag, unix, page: d.header ?? 0, phases: d.phases });
        break;
      }
      case TAG.SLEEP_TEMP:
        night(nightKey(unix))._t.push(...nums(e, 'temps_c'));
        break;
      case TAG.SPO2_R_PI:
        night(nightKey(unix))._o2.push(...nums(e, 'r').filter((r) => r > 0.2 && r < 1.5).map(spo2FromR));
        break;
      case TAG.SPO2:
        night(nightKey(unix))._o2.push(...nums(e, 'spo2_percent').filter((x) => x >= 70 && x <= 100));
        break;
      case TAG.BEDTIME: {
        const d = e.decoded as { bedtime_start_ds?: number; bedtime_end_ds?: number };
        const s = d.bedtime_start_ds !== undefined ? clock.toUnix(d.bedtime_start_ds) : null;
        const en = d.bedtime_end_ds !== undefined ? clock.toUnix(d.bedtime_end_ds) : null;
        if (s !== null && en !== null && en > s && en - s < 20 * 3600) {
          const n = night(nightKey(en));
          if (!n.bedtimeEnd || en - s > (n.bedtimeEnd - (n.bedtimeStart ?? n.bedtimeEnd))) {
            n.bedtimeStart = s;
            n.bedtimeEnd = en;
            n.sleepHours = (en - s) / 3600;
          }
        }
        break;
      }
      case TAG.GREEN_IBI:
      case TAG.IBI_AMP: {
        const hr = nums(e, 'hr_bpm').filter((x) => x >= 30 && x <= 220);
        const m = median(hr);
        if (m !== undefined) {
          day(dayKey(unix)).hr.push(m);
          hrSeries.push({ unix, bpm: m });
        }
        break;
      }
      case TAG.ACTIVITY: {
        const met = nums(e, 'met');
        day(dayKey(unix)).met.push(...met);
        if (met.length) activity.push({ unix, met });
        break;
      }
      case TAG.DEBUG_DATA: {
        const d = e.decoded as { kind?: string; battery_pct?: number };
        if (d.kind === 'battery_level_changed' && typeof d.battery_pct === 'number' && (!battery || unix > battery.unix)) {
          battery = { pct: d.battery_pct, unix };
        }
        break;
      }
    }
  }

  const round = (x: number | undefined, p = 0) => (x === undefined ? undefined : Math.round(x * 10 ** p) / 10 ** p);
  return {
    nights: [...nights.values()]
      .map(({ _hr, _hrv, _shr, _br, _t, _o2, _ph, ...n }) => ({
        ...n,
        ...hypnogram(n, _ph),
        hrSeries: n.hrSeries.sort((a, b) => a.unix - b.unix),
        hrvSeries: n.hrvSeries.sort((a, b) => a.unix - b.unix),
        lowestHr: _hr.length ? Math.min(..._hr) : undefined,
        avgHrv: round(mean(_hrv)),
        avgSleepHr: round(mean(_shr)),
        breathRate: round(mean(_br), 1),
        skinTemp: round(mean(_t), 2),
        spo2: round(mean(_o2)),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    days: [...days.entries()]
      .map(([key, d]) => ({ key, medianHr: round(median(d.hr)), hrSamples: d.hr.length, avgMet: round(mean(d.met), 2) }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    hrSeries: hrSeries.sort((a, b) => a.unix - b.unix),
    metSeries: metSeries(activity),
    battery,
    undated,
    anchored: clock.anchored,
  };
}

/**
 * Assemble the ring's hypnogram for a night. Rings emit it under one of three
 * tags, in pages of 30 s epochs; the tag with the most epochs wins so pages
 * aren't double-counted. The pages carry no start time, so the hypnogram is
 * anchored at bedtime and trimmed to it (dropping zero padding, which decodes
 * as 'deep'); without a bedtime it is assumed to end at the last page.
 */
function hypnogram(n: Night, pages: { tag: number; unix: number; page: number; phases: Stage[] }[]): Pick<Night, 'stages' | 'stageStats'> {
  if (!pages.length) return {};
  const byTag = new Map<number, typeof pages>();
  for (const p of pages) byTag.set(p.tag, [...(byTag.get(p.tag) ?? []), p]);
  const total = (ps: typeof pages) => ps.reduce((a, p) => a + p.phases.length, 0);
  const best = [...byTag.values()].sort((a, b) => total(b) - total(a))[0].sort((a, b) => a.unix - b.unix || a.page - b.page);
  let epochs = best.flatMap((p) => p.phases);
  let start: number;
  if (n.bedtimeStart !== undefined && n.bedtimeEnd !== undefined) {
    start = n.bedtimeStart;
    epochs = epochs.slice(0, Math.round((n.bedtimeEnd - n.bedtimeStart) / EPOCH_S));
  } else {
    start = best[best.length - 1].unix - epochs.length * EPOCH_S;
  }
  return { stages: { start, epochs }, stageStats: stageStats(epochs) };
}

const DEFAULT_MET_BIN_S = 60;

/**
 * Spread each `activity_information` event's MET bins back in time from the
 * event. The bin length isn't documented, so it is inferred from the gap to the
 * previous event (falling back to one minute when the gap is implausible).
 */
export function metSeries(events: { unix: number; met: number[] }[]): { unix: number; met: number }[] {
  const sorted = [...events].sort((a, b) => a.unix - b.unix);
  const out: { unix: number; met: number }[] = [];
  sorted.forEach((e, i) => {
    const gap = i > 0 ? (e.unix - sorted[i - 1].unix) / e.met.length : DEFAULT_MET_BIN_S;
    const bin = gap >= 20 && gap <= 300 ? gap : DEFAULT_MET_BIN_S;
    e.met.forEach((met, j) => out.push({ unix: e.unix - (e.met.length - 1 - j) * bin, met }));
  });
  return out;
}

export interface Baseline {
  avg: number;
  min: number;
  max: number;
  n: number;
}

/**
 * The user's own recent norm for a nightly metric: mean and range over up to
 * `window` nights before the latest one. Needs at least 3 prior nights.
 */
export function baseline(nights: Night[], pick: (n: Night) => number | undefined, window = 14): Baseline | undefined {
  const prior = nights
    .slice(0, -1)
    .slice(-window)
    .map(pick)
    .filter((v): v is number => v !== undefined);
  if (prior.length < 3) return undefined;
  return {
    avg: prior.reduce((a, b) => a + b, 0) / prior.length,
    min: Math.min(...prior),
    max: Math.max(...prior),
    n: prior.length,
  };
}

/** Tags the dashboard reads; also the anchor tags the clock needs. */
export const SUMMARY_TAGS = [
  TAG.TIME_SYNC,
  TAG.RTC_BEACON,
  TAG.HRV,
  TAG.SLEEP_PERIOD,
  TAG.SLEEP_PHASE_INFO,
  TAG.SLEEP_PHASE_DETAILS,
  TAG.SLEEP_PHASE_DATA,
  TAG.SLEEP_TEMP,
  TAG.SPO2_R_PI,
  TAG.SPO2,
  TAG.BEDTIME,
  TAG.GREEN_IBI,
  TAG.IBI_AMP,
  TAG.ACTIVITY,
  TAG.DEBUG_DATA,
];
