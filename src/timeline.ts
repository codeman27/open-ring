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
  battery?: { pct: number; unix: number };
  undated: number;
  anchored: boolean;
}

type Num = number[] | undefined;
const nums = (e: StoredEvent, field: string): number[] => ((e.decoded?.[field] as Num) ?? []).filter((x) => typeof x === 'number');

export function summarize(events: StoredEvent[], clock: RingClock): Summary {
  const nights = new Map<string, Night & { _hr: number[]; _hrv: number[]; _shr: number[]; _br: number[]; _t: number[]; _o2: number[] }>();
  const days = new Map<string, { hr: number[]; met: number[] }>();
  const hrSeries: { unix: number; bpm: number }[] = [];
  let battery: Summary['battery'];
  let undated = 0;

  const night = (key: string) => {
    let n = nights.get(key);
    if (!n) {
      n = { key, hrvSamples: 0, _hr: [], _hrv: [], _shr: [], _br: [], _t: [], _o2: [] };
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
        break;
      }
      case TAG.SLEEP_PERIOD: {
        const n = night(nightKey(unix));
        const d = e.decoded as { average_hr?: number; breath?: number };
        if (d.average_hr) n._shr.push(d.average_hr);
        if (d.breath) n._br.push(d.breath);
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
      case TAG.ACTIVITY:
        day(dayKey(unix)).met.push(...nums(e, 'met'));
        break;
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
      .map(({ _hr, _hrv, _shr, _br, _t, _o2, ...n }) => ({
        ...n,
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
    battery,
    undated,
    anchored: clock.anchored,
  };
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
  TAG.SLEEP_TEMP,
  TAG.SPO2_R_PI,
  TAG.SPO2,
  TAG.BEDTIME,
  TAG.GREEN_IBI,
  TAG.IBI_AMP,
  TAG.ACTIVITY,
  TAG.DEBUG_DATA,
];
