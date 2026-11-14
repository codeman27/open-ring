/**
 * On-device workout detection. The ring doesn't label workouts (Oura classifies
 * them in its cloud), so a session is a stretch of sustained moderate-or-harder
 * MET outside bedtime, paired with the heart-rate samples recorded during it.
 */
import type { Night } from './timeline';

export type Intensity = 'light' | 'moderate' | 'vigorous';

export interface Exercise {
  id: string;
  start: number;
  end: number;
  minutes: number;
  avgMet: number;
  peakMet: number;
  /** Coefficient of variation of MET: high for stop-start sports. */
  metCv: number;
  /** Share of bins at vigorous (≥ 6 MET) effort. */
  vigorousFrac: number;
  intensity: Intensity;
  hr: { unix: number; bpm: number }[];
  avgHr?: number;
  peakHr?: number;
}

export const ACTIVE_MET = 3;
const MAX_GAP_S = 3 * 60;
const MIN_DURATION_S = 10 * 60;

export const intensityOf = (met: number): Intensity => (met >= 6 ? 'vigorous' : met >= 4 ? 'moderate' : 'light');

export const INTENSITY_LABEL: Record<Intensity, string> = {
  light: 'Light activity',
  moderate: 'Moderate workout',
  vigorous: 'Vigorous workout',
};

function binLength(points: { unix: number }[]): number {
  const gaps = points
    .slice(1)
    .map((p, i) => p.unix - points[i].unix)
    .filter((g) => g > 0)
    .sort((a, b) => a - b);
  const g = gaps[gaps.length >> 1];
  return g !== undefined && g >= 20 && g <= 300 ? g : 60;
}

export function detectExercises(
  met: { unix: number; met: number }[],
  hr: { unix: number; bpm: number }[],
  nights: Night[] = [],
): Exercise[] {
  const beds = nights.flatMap((n) => (n.bedtimeStart !== undefined && n.bedtimeEnd !== undefined ? [[n.bedtimeStart, n.bedtimeEnd]] : []));
  const awake = met.filter((p) => !beds.some(([s, e]) => p.unix >= s && p.unix <= e)).sort((a, b) => a.unix - b.unix);
  const bin = binLength(awake);

  const spans: { first: number; last: number }[] = [];
  for (const p of awake) {
    if (p.met < ACTIVE_MET) continue;
    const cur = spans.at(-1);
    if (cur && p.unix - cur.last <= MAX_GAP_S + bin) cur.last = p.unix;
    else spans.push({ first: p.unix, last: p.unix });
  }

  const out: Exercise[] = [];
  for (const { first, last } of spans) {
    const start = first - bin;
    const end = last;
    if (end - start < MIN_DURATION_S) continue;
    const mets = awake.filter((p) => p.unix >= first && p.unix <= last).map((p) => p.met);
    const avgMet = mets.reduce((a, b) => a + b, 0) / mets.length;
    const sd = Math.sqrt(mets.reduce((a, m) => a + (m - avgMet) ** 2, 0) / mets.length);
    const beats = hr.filter((p) => p.unix >= start - 60 && p.unix <= end + 60);
    const bpm = beats.map((p) => p.bpm);
    out.push({
      id: String(Math.round(start)),
      start,
      end,
      minutes: Math.round((end - start) / 60),
      avgMet: Math.round(avgMet * 10) / 10,
      peakMet: Math.max(...mets),
      metCv: Math.round((sd / avgMet) * 100) / 100,
      vigorousFrac: Math.round((mets.filter((m) => m >= 6).length / mets.length) * 100) / 100,
      intensity: intensityOf(avgMet),
      hr: beats,
      avgHr: bpm.length ? Math.round(bpm.reduce((a, b) => a + b, 0) / bpm.length) : undefined,
      peakHr: bpm.length ? Math.max(...bpm) : undefined,
    });
  }
  return out.reverse();
}
