/**
 * Activity labels for detected workouts: the user's own tags, plus suggestions
 * learned from them (nearest past workouts by movement/heart-rate shape), with
 * simple rules as a starting guess before anything has been tagged.
 */
import type { Exercise } from './exercise';

export const DEFAULT_TYPES = ['Pickleball', 'Walking', 'Weights', 'Running', 'Cycling', 'Hiking', 'Chores'];

export interface Features {
  avgMet: number;
  metCv: number;
  vigorousFrac: number;
  minutes: number;
  /** Heart rate per unit of movement: high for strength work. */
  hrPerMet?: number;
  hour: number;
}

export interface ActivityTag {
  start: number;
  end: number;
  label: string;
  f: Features;
}

export interface Suggestion {
  label: string;
  confidence: number;
  source: 'learned' | 'rule';
}

export function features(ex: Exercise): Features {
  const d = new Date(ex.start * 1000);
  return {
    avgMet: ex.avgMet,
    metCv: ex.metCv,
    vigorousFrac: ex.vigorousFrac,
    minutes: ex.minutes,
    hrPerMet: ex.avgHr !== undefined ? ex.avgHr / ex.avgMet : undefined,
    hour: d.getHours() + d.getMinutes() / 60,
  };
}

/** The tag covering most of this workout (re-syncs can shift detected edges slightly). */
export function tagFor(ex: { start: number; end: number }, tags: ActivityTag[]): ActivityTag | undefined {
  let best: ActivityTag | undefined;
  let bestOverlap = 0;
  for (const t of tags) {
    const overlap = Math.min(ex.end, t.end) - Math.max(ex.start, t.start);
    const shorter = Math.min(ex.end - ex.start, t.end - t.start);
    if (shorter > 0 && overlap / shorter >= 0.5 && overlap > bestOverlap) {
      best = t;
      bestOverlap = overlap;
    }
  }
  return best;
}

export function distance(a: Features, b: Features): number {
  const terms: [number, number][] = [
    [(a.avgMet - b.avgMet) / 1.5, 1],
    [(a.metCv - b.metCv) / 0.15, 1],
    [(a.vigorousFrac - b.vigorousFrac) / 0.25, 1],
    [Math.log(a.minutes / b.minutes) / 0.6, 1],
  ];
  if (a.hrPerMet !== undefined && b.hrPerMet !== undefined) terms.push([(a.hrPerMet - b.hrPerMet) / 6, 1]);
  const dh = Math.abs(a.hour - b.hour);
  terms.push([Math.min(dh, 24 - dh) / 4, 0.5]);
  const w = terms.reduce((s, [, wi]) => s + wi, 0);
  return Math.sqrt(terms.reduce((s, [x, wi]) => s + wi * x * x, 0) / w);
}

const K = 5;
/**
 * Beyond this distance the nearest tagged workout isn't considered similar and the
 * starter rules decide instead. Repeats of one activity land around 0.3-0.5.
 */
const MAX_LEARNED_DISTANCE = 0.6;

export function learnedGuess(f: Features, tags: ActivityTag[], types: string[]): Suggestion | undefined {
  const near = tags
    .filter((t) => types.includes(t.label))
    .map((t) => ({ label: t.label, d: distance(f, t.f) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, K);
  if (!near.length || near[0].d > MAX_LEARNED_DISTANCE) return undefined;
  const votes = new Map<string, number>();
  for (const n of near) votes.set(n.label, (votes.get(n.label) ?? 0) + 1 / (n.d + 0.25));
  const total = [...votes.values()].reduce((a, b) => a + b, 0);
  const [label, v] = [...votes].sort((a, b) => b[1] - a[1])[0];
  return { label, confidence: Math.round((v / total) * 100) / 100, source: 'learned' };
}

const RULES: { when: (f: Features) => boolean; labels: string[] }[] = [
  { when: (f) => f.hrPerMet !== undefined && f.hrPerMet >= 30 && f.avgMet < 4.5, labels: ['Weights', 'Strength training'] },
  { when: (f) => f.metCv >= 0.35, labels: ['Pickleball', 'Tennis', 'Padel', 'Badminton'] },
  { when: (f) => f.avgMet >= 6 && f.metCv < 0.25, labels: ['Running'] },
  { when: (f) => f.avgMet < 5 && f.minutes >= 75, labels: ['Hiking', 'Walking'] },
  { when: (f) => f.avgMet < 5, labels: ['Walking'] },
];

export function ruleGuess(f: Features, types: string[]): Suggestion | undefined {
  const byName = new Map(types.map((t) => [t.toLowerCase(), t]));
  for (const r of RULES) {
    if (!r.when(f)) continue;
    const label = r.labels.map((l) => byName.get(l.toLowerCase())).find((l) => l !== undefined);
    if (label) return { label, confidence: 0.4, source: 'rule' };
  }
  return undefined;
}

export const suggest = (f: Features, tags: ActivityTag[], types: string[]): Suggestion | undefined =>
  learnedGuess(f, tags, types) ?? ruleGuess(f, types);
