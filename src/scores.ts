/**
 * On-device score estimates. Weights follow open_oura's recovered combiners
 * (docs/algorithms/score-weights.md). Sleep uses Oura's seven contributors when
 * the ring's hypnogram is available; otherwise, and for contributors without a
 * matured personal baseline, they are approximated or left out and the
 * remaining weights renormalized.
 */
import { baseline, type Day, type Night } from './timeline';

export interface Contributor {
  label: string;
  weight: number;
  score: number;
}

export interface ScoreResult {
  score: number;
  contributors: Contributor[];
  provisional: boolean;
}

export type Tier = 'good' | 'fair' | 'low';

export const tier = (score: number): Tier => (score >= 75 ? 'good' : score >= 60 ? 'fair' : 'low');

/** Piecewise-linear interpolation through `pts` (ascending x), clamped at both ends. */
export function curve(x: number, pts: [number, number][]): number {
  if (x <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    const [x1, y1] = pts[i];
    if (x <= x1) {
      const [x0, y0] = pts[i - 1];
      return y0 + ((x - x0) / (x1 - x0)) * (y1 - y0);
    }
  }
  return pts[pts.length - 1][1];
}

function combine(contributors: Contributor[], provisional: boolean): ScoreResult | undefined {
  if (!contributors.length) return undefined;
  const rounded = contributors.map((c) => ({ ...c, score: Math.round(c.score) }));
  const w = rounded.reduce((a, c) => a + c.weight, 0);
  const score = Math.round(rounded.reduce((a, c) => a + c.weight * c.score, 0) / w);
  return { score, contributors: rounded, provisional };
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

const localHour = (unix: number) => {
  const d = new Date(unix * 1000);
  return d.getHours() + d.getMinutes() / 60;
};

/** Evening bedtimes stay continuous with after-midnight ones (22:00 → 22, 01:00 → 25). */
const bedHour = (unix: number) => {
  const h = localHour(unix);
  return h < 12 ? h + 24 : h;
};

const prevDayKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number);
  const p = new Date(y, m - 1, d - 1);
  return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}-${String(p.getDate()).padStart(2, '0')}`;
};

const timingScore = (n: Night) => {
  if (n.bedtimeStart === undefined || n.bedtimeEnd === undefined) return undefined;
  const off = Math.abs(localHour((n.bedtimeStart + n.bedtimeEnd) / 2) - 3);
  return curve(Math.min(off, 24 - off), [[1, 100], [2.5, 70], [4, 40], [6, 15]]);
};

/** Oura's seven Sleep Score contributors, from the ring's hypnogram. */
function stagedSleepScore(night: Night): ScoreResult | undefined {
  const st = night.stageStats;
  if (!st) return undefined;
  const out: Contributor[] = [
    { label: 'Total sleep', weight: 35, score: curve(st.sleepMin / 60, [[4, 20], [5, 40], [6, 60], [7, 85], [8, 100]]) },
    { label: 'Restfulness', weight: 15, score: curve(st.wakeAfterOnset, [[0.05, 100], [0.1, 85], [0.2, 55], [0.3, 25]]) },
    { label: 'Efficiency', weight: 10, score: curve(st.efficiency * 100, [[65, 20], [75, 50], [85, 85], [90, 100]]) },
    { label: 'REM sleep', weight: 10, score: curve(st.remMin, [[30, 20], [60, 55], [90, 85], [105, 100]]) },
    { label: 'Deep sleep', weight: 10, score: curve(st.deepMin, [[20, 20], [45, 60], [60, 85], [75, 100]]) },
    { label: 'Latency', weight: 10, score: curve(st.latencyMin, [[0, 60], [5, 85], [10, 100], [20, 100], [30, 80], [60, 40]]) },
  ];
  const timing = timingScore(night);
  if (timing !== undefined) out.push({ label: 'Timing', weight: 10, score: timing });
  return combine(out, false);
}

export function sleepScore(nights: Night[]): ScoreResult | undefined {
  const night = nights.at(-1);
  if (!night) return undefined;
  const staged = stagedSleepScore(night);
  if (staged) return staged;
  if (night.sleepHours === undefined) return undefined;
  const out: Contributor[] = [
    { label: 'Total sleep', weight: 50, score: curve(night.sleepHours, [[3, 10], [5, 45], [6, 65], [7, 85], [8, 100]]) },
  ];
  const timing = timingScore(night);
  if (timing !== undefined) out.push({ label: 'Timing', weight: 20, score: timing });
  const prior = nights
    .slice(0, -1)
    .slice(-14)
    .flatMap((n) => (n.bedtimeStart === undefined ? [] : [bedHour(n.bedtimeStart)]));
  const regular = night.bedtimeStart !== undefined && prior.length >= 3;
  if (regular) {
    const diff = Math.abs(bedHour(night.bedtimeStart!) - mean(prior));
    out.push({ label: 'Regularity', weight: 15, score: curve(diff, [[0.5, 100], [1, 85], [2, 55], [3, 30]]) });
  }
  if (night.spo2 !== undefined) {
    out.push({ label: 'Blood oxygen', weight: 15, score: curve(night.spo2, [[88, 30], [92, 70], [95, 100]]) });
  }
  return combine(out, !regular);
}

export function readinessScore(nights: Night[], days: Day[], goalHours = 8): ScoreResult | undefined {
  const night = nights.at(-1);
  if (!night) return undefined;
  const out: Contributor[] = [];
  let provisional = false;

  const rhrBase = baseline(nights, (n) => n.lowestHr);
  if (night.lowestHr !== undefined && rhrBase) {
    out.push({ label: 'Resting heart rate', weight: 17, score: curve(night.lowestHr - rhrBase.avg, [[-2, 100], [0, 95], [2, 80], [4, 60], [7, 30], [10, 10]]) });
  } else provisional = true;

  const sleep = sleepScore(nights);
  if (sleep) out.push({ label: 'Previous night', weight: 15, score: sleep.score });

  const hrvBase = baseline(nights, (n) => n.avgHrv);
  if (night.avgHrv !== undefined && hrvBase) {
    out.push({ label: 'HRV balance', weight: 15, score: curve(night.avgHrv / hrvBase.avg, [[0.6, 15], [0.8, 55], [0.9, 75], [1, 92], [1.1, 100]]) });
  } else provisional = true;

  const tempBase = baseline(nights, (n) => n.skinTemp);
  if (night.skinTemp !== undefined && tempBase) {
    out.push({ label: 'Body temperature', weight: 13, score: curve(Math.abs(night.skinTemp - tempBase.avg), [[0.1, 100], [0.3, 85], [0.6, 55], [1, 25]]) });
  } else provisional = true;

  const recent = nights
    .slice(-7)
    .map((n) => n.sleepHours)
    .filter((h): h is number => h !== undefined);
  if (recent.length >= 3) {
    out.push({ label: 'Sleep balance', weight: 12, score: curve(mean(recent) / goalHours, [[0.6, 20], [0.75, 55], [0.875, 80], [1, 100]]) });
  }

  const met = days.find((d) => d.key === prevDayKey(night.key))?.avgMet;
  if (met !== undefined) {
    out.push({ label: 'Previous day activity', weight: 10, score: curve(met, [[1, 50], [1.2, 75], [1.4, 95], [2, 100], [2.6, 85], [3.2, 60]]) });
  }

  return combine(out, provisional);
}

const metScore = (met: number) => curve(met, [[1, 20], [1.2, 45], [1.4, 70], [1.6, 85], [1.8, 95], [2, 100]]);

export function activityScore(days: Day[], todayKey: string): ScoreResult | undefined {
  const met = days.find((d) => d.key === todayKey)?.avgMet;
  if (met === undefined) return undefined;
  const out: Contributor[] = [{ label: 'Intensity today', weight: 60, score: metScore(met) }];
  const prior = days
    .filter((d) => d.key < todayKey)
    .slice(-7)
    .flatMap((d) => (d.avgMet === undefined ? [] : [d.avgMet]));
  if (prior.length >= 2) out.push({ label: 'Activity balance', weight: 40, score: metScore(mean(prior)) });
  return combine(out, prior.length < 2);
}
