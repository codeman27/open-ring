/**
 * Estimated sleep stages for rings that don't store their own hypnogram (e.g.
 * Ring 4, where Oura stages on the phone with a proprietary model). A transparent
 * heuristic, not a port: actigraphy-style wake detection from motion seconds,
 * then deep/REM/light from heart rate level and variability relative to the
 * night, with the usual early-deep / late-REM pattern as a prior.
 */
import { EPOCH_S, type Stage } from './timeline';

export interface StagerInput {
  start: number;
  end: number;
  /** Seconds of movement per ~30 s window (`motion_event`), stamped at window end. */
  motion: { unix: number; sec: number }[];
  hr: { unix: number; bpm: number }[];
  rmssd?: { unix: number; ms: number }[];
}

const HR_WINDOW_S = 5 * 60;
const ONSET_EPOCHS = 20;
const NO_REM_AFTER_ONSET = 90;
const MIN_BOUT = 6;
const MOTION_REACH_S = 90;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const std = (xs: number[]) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
};

/** Robust z-scores (median / MAD), with a floor on the spread. */
function zscores(xs: (number | undefined)[], minSpread: number): number[] {
  const present = xs.filter((x): x is number => x !== undefined);
  if (present.length < 3) return xs.map(() => 0);
  const med = median(present);
  const spread = Math.max(median(present.map((x) => Math.abs(x - med))) * 1.4826, minSpread);
  return xs.map((x) => (x === undefined ? 0 : (x - med) / spread));
}

function windowed<T extends { unix: number }>(points: T[], center: number, half: number): T[] {
  return points.filter((p) => p.unix >= center - half && p.unix <= center + half);
}

/** Replace bouts shorter than `min` epochs of the given stages with `to`. */
function dropShortBouts(epochs: Stage[], stages: Stage[], min: number, to: Stage) {
  let i = 0;
  while (i < epochs.length) {
    let j = i;
    while (j < epochs.length && epochs[j] === epochs[i]) j++;
    if (stages.includes(epochs[i]) && j - i < min) for (let k = i; k < j; k++) epochs[k] = to;
    i = j;
  }
}

export function estimateStages({ start, end, motion, hr, rmssd = [] }: StagerInput): Stage[] | undefined {
  const n = Math.round((end - start) / EPOCH_S);
  if (n < ONSET_EPOCHS) return undefined;
  const mid = (i: number) => start + (i + 0.5) * EPOCH_S;

  // Motion windows may be longer than an epoch, so epochs without their own
  // sample borrow the nearest one within MOTION_REACH_S.
  const mo: (number | undefined)[] = Array(n).fill(undefined);
  const sortedMotion = [...motion].sort((x, y) => x.unix - y.unix);
  let j = 0;
  for (let i = 0; i < n; i++) {
    const t = mid(i);
    while (j + 1 < sortedMotion.length && Math.abs(sortedMotion[j + 1].unix - t) <= Math.abs(sortedMotion[j].unix - t)) j++;
    const m = sortedMotion[j];
    if (m && Math.abs(m.unix - t) <= MOTION_REACH_S) mo[i] = m.sec;
  }
  const hrIn = hr.filter((p) => p.unix >= start - HR_WINDOW_S && p.unix <= end + HR_WINDOW_S);
  const covered = (xs: unknown[]) => xs.filter((x) => x !== undefined).length / n;
  const hrAt = mo.map((_, i) => {
    const w = windowed(hrIn, mid(i), HR_WINDOW_S / 2);
    if (w.length) return median(w.map((p) => p.bpm));
    const near = windowed(hrIn, mid(i), 2 * HR_WINDOW_S).sort((x, y) => Math.abs(x.unix - mid(i)) - Math.abs(y.unix - mid(i)))[0];
    return near?.bpm;
  });
  if (covered(mo) < 0.5 || covered(hrAt) < 0.5) return undefined;

  const hrVar = mo.map((_, i) => {
    const w = windowed(hrIn, mid(i), HR_WINDOW_S / 2);
    return w.length >= 3 ? std(w.map((p) => p.bpm)) : undefined;
  });
  const rmAt = mo.map((_, i) => {
    const w = windowed(rmssd, mid(i), HR_WINDOW_S);
    return w.length ? median(w.map((p) => p.ms)) : undefined;
  });

  // Wake: weighted motion around each epoch (Cole-Kripke style) or an HR arousal.
  const a = mo.map((x) => x ?? 0);
  const W = [0.15, 0.25, 0.4, 0.25, 0.15];
  const hrMed = median(hrAt.filter((x): x is number => x !== undefined));
  const awake = a.map((_, i) => {
    const act = W.reduce((s, w, k) => s + w * (a[i + k - 2] ?? 0), 0) / 1.2;
    return act >= 4 || (hrAt[i] ?? 0) > hrMed + 15;
  });

  const sustained = (i: number) => awake.slice(i, i + ONSET_EPOCHS).filter((w) => !w).length >= ONSET_EPOCHS * 0.9;
  const onset = awake.findIndex((_, i) => i + ONSET_EPOCHS <= n && sustained(i));
  if (onset < 0) return Array(n).fill('awake');
  let last = n - 1;
  while (last > onset && awake[last]) last--;

  const hrZ = zscores(hrAt, 1.5);
  const varZ = zscores(hrVar, 0.75);
  const rmZ = zscores(rmAt, 5);
  const span = Math.max(1, last - onset);

  const out: Stage[] = mo.map((_, i) => {
    if (i < onset || i > last || awake[i]) return 'awake';
    const t = (i - onset) / span;
    const still = a.slice(Math.max(0, i - 2), i + 3).every((x) => x === 0);
    const deep = -hrZ[i] - 0.8 * varZ[i] + 0.6 * rmZ[i] + 1.2 * (0.45 - t);
    const rem = 0.6 * hrZ[i] + 1.0 * varZ[i] - 0.3 * rmZ[i] + 1.2 * (t - 0.35);
    if (still && deep > 0.9 && deep >= rem) return 'deep';
    if (i - onset >= NO_REM_AFTER_ONSET && rem > 0.9) return 'rem';
    return 'light';
  });

  // Majority-smooth sleep epochs, then drop implausibly short deep/REM bouts.
  const smooth = out.map((st, i) => {
    if (st === 'awake') return st;
    const win = out.slice(Math.max(0, i - 2), i + 3).filter((s) => s !== 'awake');
    const counts = new Map<Stage, number>();
    for (const s of win) counts.set(s, (counts.get(s) ?? 0) + 1);
    return [...counts].sort((x, y) => y[1] - x[1])[0][0];
  });
  dropShortBouts(smooth, ['deep', 'rem'], MIN_BOUT, 'light');
  return smooth;
}
