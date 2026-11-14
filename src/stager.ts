/**
 * Estimated sleep stages for rings that don't store their own hypnogram (e.g.
 * Ring 4, where Oura stages on the phone with a proprietary model). A transparent
 * heuristic, not a port:
 *
 * 1. Wake from movement (Cole-Kripke style weighted window), cleaned with the
 *    Webster rescoring rules so isolated blips don't fragment the night.
 * 2. Deep / REM / light from heart rate level, its variability and RMSSD,
 *    smoothed over minutes and normalised within the night (as wearable stagers
 *    such as Oura's and Walch et al. 2019 do), with an early-deep / late-REM prior.
 * 3. Physiological limits: per-night caps on deep and REM share, minimum bout
 *    lengths, and merging of short interruptions, so stages form blocks.
 */
import type { Stage } from './timeline';

// Local copy: timeline.ts imports this module, so its exports aren't initialised yet here.
const EPOCH_S = 30;

export interface StagerInput {
  start: number;
  end: number;
  /**
   * Seconds of movement per 30 s window (`motion_event`). The ring only emits
   * these when it moves, so a missing window means still.
   */
  motion: { unix: number; sec: number }[];
  /** Accelerometer MAD per 30 s during sleep (`sleep_acm_period`), when available. */
  acm?: { unix: number; mad: number }[];
  hr: { unix: number; bpm: number }[];
  rmssd?: { unix: number; ms: number }[];
}

const MIN = 60 / EPOCH_S;
const ONSET_EPOCHS = 10 * MIN;
const NO_REM_AFTER_ONSET = 45 * MIN;
const WAKE_HALF = 5;
/** Mean motion seconds per 30 s over ~5 min; tuned against a Fitbit-scored Ring 4 night. */
const WAKE_ACTIVITY = 3.5;
const HR_SURGE = 15;
const STRONG_ACTIVITY = 10;
const MIN_WAKE_IN_SLEEP = 2 * MIN;
const MIN_DEEP = 10 * MIN;
const MIN_REM = 5 * MIN;
const MERGE_GAP = 3 * MIN;
const DEEP_MAX_SHARE = 0.25;
const REM_MAX_SHARE = 0.25;
const STAGE_CUT = 0.5;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const std = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
};
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return Infinity;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * s.length)))];
};

/** Robust z-scores (median / MAD), with a floor on the spread. */
function zscores(xs: (number | undefined)[], minSpread: number): number[] {
  const present = xs.filter((x): x is number => x !== undefined);
  if (present.length < 3) return xs.map(() => 0);
  const med = median(present);
  const spread = Math.max(median(present.map((x) => Math.abs(x - med))) * 1.4826, minSpread);
  return xs.map((x) => (x === undefined ? 0 : (x - med) / spread));
}

const rollingMean = (xs: number[], half: number) =>
  xs.map((_, i) => {
    const w = xs.slice(Math.max(0, i - half), i + half + 1);
    return w.reduce((a, b) => a + b, 0) / w.length;
  });

/** Subtract a rolling median trend; gaps stay undefined. */
function detrend(xs: (number | undefined)[], half: number): (number | undefined)[] {
  return xs.map((x, i) => {
    if (x === undefined) return undefined;
    const w = xs.slice(Math.max(0, i - half), i + half + 1).filter((v): v is number => v !== undefined);
    return x - median(w);
  });
}

function windowed<T extends { unix: number }>(points: T[], center: number, half: number): T[] {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (points[m].unix < center - half) lo = m + 1;
    else hi = m;
  }
  const out: T[] = [];
  for (let i = lo; i < points.length && points[i].unix <= center + half; i++) out.push(points[i]);
  return out;
}

type Run<T> = { v: T; from: number; to: number };
function runs<T>(xs: T[]): Run<T>[] {
  const out: Run<T>[] = [];
  xs.forEach((v, i) => {
    const last = out.at(-1);
    if (last && last.v === v) last.to = i + 1;
    else out.push({ v, from: i, to: i + 1 });
  });
  return out;
}

/** Webster et al. (1982) rescoring, scaled from 1-minute to 30-second epochs. */
function webster(wake: boolean[], activity: number[]): boolean[] {
  const w = [...wake];
  // Short sleep right after a long wake stretch is still wake.
  for (const r of runs(wake)) {
    if (!r.v) continue;
    const len = r.to - r.from;
    const n = len >= 15 * MIN ? 4 * MIN : len >= 10 * MIN ? 3 * MIN : len >= 4 * MIN ? 1 * MIN : 0;
    for (let i = r.to; i < Math.min(w.length, r.to + n) && !wake[i]; i++) w[i] = true;
  }
  // Short sleep surrounded by long wake is wake.
  const rs = runs(w);
  rs.forEach((r, k) => {
    if (r.v) return;
    const len = r.to - r.from;
    const before = rs[k - 1]?.v ? rs[k - 1].to - rs[k - 1].from : 0;
    const after = rs[k + 1]?.v ? rs[k + 1].to - rs[k + 1].from : 0;
    if ((len <= 6 * MIN && before >= 10 * MIN && after >= 10 * MIN) || (len <= 10 * MIN && before >= 20 * MIN && after >= 20 * MIN)) {
      for (let i = r.from; i < r.to; i++) w[i] = true;
    }
  });
  // Brief wake blips inside sleep without strong movement are sleep.
  for (const r of runs(w)) {
    if (!r.v || r.from === 0 || r.to === w.length) continue;
    const peak = Math.max(...activity.slice(r.from, r.to));
    if (r.to - r.from < MIN_WAKE_IN_SLEEP && peak < STRONG_ACTIVITY) for (let i = r.from; i < r.to; i++) w[i] = false;
  }
  return w;
}

/** Fill short `light` gaps between two bouts of the same stage, then drop short bouts. */
function consolidate(epochs: Stage[], stage: Stage, minBout: number) {
  const rs = runs(epochs);
  rs.forEach((r, k) => {
    if (r.v !== 'light' || r.to - r.from > MERGE_GAP) return;
    if (rs[k - 1]?.v === stage && rs[k + 1]?.v === stage) for (let i = r.from; i < r.to; i++) epochs[i] = stage;
  });
  for (const r of runs(epochs)) if (r.v === stage && r.to - r.from < minBout) for (let i = r.from; i < r.to; i++) epochs[i] = 'light';
}

export function estimateStages({ start, end, motion, hr, rmssd = [], acm = [] }: StagerInput): Stage[] | undefined {
  const n = Math.round((end - start) / EPOCH_S);
  if (n < 2 * ONSET_EPOCHS) return undefined;
  const mid = (i: number) => start + (i + 0.5) * EPOCH_S;

  const epochOf = (unix: number) => Math.floor((unix - 1 - start) / EPOCH_S);
  const a: number[] = Array(n).fill(0);
  for (const m of motion) {
    const i = epochOf(m.unix);
    if (i >= 0 && i < n) a[i] = Math.max(a[i], m.sec);
  }
  const restless: number[] = Array(n).fill(0);
  for (const m of acm) {
    const i = epochOf(m.unix);
    if (i >= 0 && i < n) restless[i] = Math.max(restless[i], m.mad);
  }

  const beats = hr.filter((p) => p.bpm >= 35 && p.bpm <= 120 && p.unix >= start - 600 && p.unix <= end + 600).sort((a, b) => a.unix - b.unix);
  const hrv = [...rmssd].sort((a, b) => a.unix - b.unix);
  const hrAt = a.map((_, i) => {
    const w = windowed(beats, mid(i), 150);
    if (w.length) return median(w.map((p) => p.bpm));
    const wide = windowed(beats, mid(i), 600);
    return wide.length ? median(wide.map((p) => p.bpm)) : undefined;
  });
  const covered = (xs: unknown[]) => xs.filter((x) => x !== undefined).length / n;
  if (covered(hrAt) < 0.5) return undefined;

  const hrVar = a.map((_, i) => {
    const w = windowed(beats, mid(i), 300);
    return w.length >= 4 ? std(w.map((p) => p.bpm)) : undefined;
  });
  const rmAt = a.map((_, i) => {
    const w = windowed(hrv, mid(i), 450);
    return w.length ? median(w.map((p) => p.ms)) : undefined;
  });

  // 1. Wake: sustained movement (mean motion seconds over a few minutes), or a
  // heart-rate surge with movement. Brief movement is restlessness, not wake.
  const activity = rollingMean(a, WAKE_HALF);
  const hrMed = median(hrAt.filter((x): x is number => x !== undefined));
  const movedNear = (i: number) => a.slice(Math.max(0, i - 2), i + 3).some((x) => x >= 4);
  const rawWake = activity.map((act, i) => act >= WAKE_ACTIVITY || ((hrAt[i] ?? 0) > hrMed + HR_SURGE && movedNear(i)));
  const wake = webster(rawWake, activity);

  const onset = wake.findIndex((_, i) => i + ONSET_EPOCHS <= n && wake.slice(i, i + ONSET_EPOCHS).every((w) => !w));
  if (onset < 0) return Array(n).fill('awake');
  let last = n - 1;
  while (last > onset && wake[last]) last--;
  const span = Math.max(1, last - onset);

  // 2. Deep / REM / light scores from smoothed, night-normalised features.
  // Heart rate and HRV drift across the night, so compare each moment with its
  // local trend rather than the whole night (otherwise "low" just means "late").
  const half = 5 * MIN;
  const trendHalf = 45 * MIN;
  const hrZ = rollingMean(zscores(detrend(hrAt, trendHalf), 1), half);
  const varZ = rollingMean(zscores(hrVar, 0.75), half);
  const rmZ = rollingMean(zscores(detrend(rmAt, trendHalf), 5), half);
  const t = (i: number) => (i - onset) / span;
  const PRIOR = 1.5;
  const deepS = hrZ.map((_, i) => -hrZ[i] - 0.8 * varZ[i] + 0.6 * rmZ[i] + PRIOR * (0.4 - t(i)));
  const remS = hrZ.map((_, i) => 0.6 * hrZ[i] + 1.0 * varZ[i] - 0.3 * rmZ[i] + PRIOR * (t(i) - 0.4));
  // Deep sleep is still: no motion events and low accelerometer MAD nearby.
  const restCut = acm.length ? quantile(restless.filter((x) => x > 0), 0.85) : Infinity;
  const quiet = (i: number) => a.slice(Math.max(0, i - 4), i + 5).reduce((s, x) => s + x, 0) <= 4 && restless.slice(Math.max(0, i - 2), i + 3).filter((x) => x > restCut).length <= 1;

  const asleep = (i: number) => i >= onset && i <= last && !wake[i];
  const sleepIdx = [...Array(n).keys()].filter(asleep);
  const deepCut = Math.max(STAGE_CUT, quantile(sleepIdx.map((i) => deepS[i]), 1 - DEEP_MAX_SHARE));
  const remPool = sleepIdx.filter((i) => i - onset >= NO_REM_AFTER_ONSET);
  const remCut = Math.max(STAGE_CUT, quantile(remPool.map((i) => remS[i]), 1 - REM_MAX_SHARE * (sleepIdx.length / Math.max(1, remPool.length))));

  const out: Stage[] = Array.from({ length: n }, (_, i) => {
    if (!asleep(i)) return 'awake';
    if (quiet(i) && deepS[i] >= deepCut && deepS[i] >= remS[i]) return 'deep';
    if (i - onset >= NO_REM_AFTER_ONSET && remS[i] >= remCut) return 'rem';
    return 'light';
  });

  // 3. Blocks, not flicker.
  consolidate(out, 'deep', MIN_DEEP);
  consolidate(out, 'rem', MIN_REM);
  return out;
}
