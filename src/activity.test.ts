import { describe, expect, it } from 'vitest';
import { learnedGuess, ruleGuess, suggest, tagFor } from './activity';
import type { ActivityTag, Features } from './activity';

const f = (o: Partial<Features> = {}): Features => ({ avgMet: 3.8, metCv: 0.1, vigorousFrac: 0, minutes: 40, hrPerMet: 25, hour: 9, ...o });
const tag = (start: number, end: number, label: string, fo?: Partial<Features>): ActivityTag => ({ start, end, label, f: f(fo) });

describe('tagFor', () => {
  it('matches a tag overlapping at least half of the shorter span', () => {
    const t = tag(1000, 2000, 'Walking');
    expect(tagFor({ start: 1100, end: 2100 }, [t])).toBe(t);
  });

  it('ignores a tag with less than half overlap', () => {
    expect(tagFor({ start: 1100, end: 2100 }, [tag(1800, 3000, 'Walking')])).toBeUndefined();
  });

  it('returns the tag with the larger overlap when two qualify', () => {
    const a = tag(1000, 2000, 'Walking');
    const b = tag(1400, 2600, 'Hiking');
    expect(tagFor({ start: 1100, end: 2100 }, [a, b])).toBe(a);
  });
});

describe('ruleGuess', () => {
  const types = ['Pickleball', 'Walking', 'Weights', 'Running', 'Hiking'];

  it('flags high heart rate per MET as weights', () => {
    expect(ruleGuess(f({ hrPerMet: 34, avgMet: 3.5 }), types)).toEqual({ label: 'Weights', confidence: 0.4, source: 'rule' });
  });

  it('flags spiky movement (high metCv) as pickleball', () => {
    expect(ruleGuess(f({ metCv: 0.45 }), types)?.label).toBe('Pickleball');
  });

  it('flags sustained high MET as running', () => {
    expect(ruleGuess(f({ avgMet: 7, metCv: 0.1, hrPerMet: 22 }), types)?.label).toBe('Running');
  });

  it('calls long low-MET sessions hiking and short ones walking', () => {
    expect(ruleGuess(f({ avgMet: 3.8, minutes: 100 }), types)?.label).toBe('Hiking');
    expect(ruleGuess(f({ avgMet: 3.8, minutes: 30 }), types)?.label).toBe('Walking');
  });

  it('marks every guess with source rule', () => {
    const guesses = [f({ hrPerMet: 34, avgMet: 3.5 }), f({ metCv: 0.45 }), f({ avgMet: 7, metCv: 0.1, hrPerMet: 22 }), f({ minutes: 100 }), f()].map((fo) => ruleGuess(fo, types));
    for (const g of guesses) expect(g?.source).toBe('rule');
  });

  it('skips labels missing from the user list', () => {
    expect(ruleGuess(f({ metCv: 0.45 }), ['Walking', 'Tennis'])?.label).toBe('Tennis');
  });

  it('returns undefined when no rule label is in the user list', () => {
    expect(ruleGuess(f({ avgMet: 3.8 }), ['Running'])).toBeUndefined();
  });
});

describe('learnedGuess', () => {
  it('votes for the nearest labeled workouts', () => {
    const pb = Array.from({ length: 3 }, (_, i) => tag(i * 1000, i * 1000 + 900, 'Pickleball', { avgMet: 5, metCv: 0.3, hrPerMet: 24 }));
    const walk = Array.from({ length: 3 }, (_, i) => tag(i * 1000, i * 1000 + 900, 'Walking', { avgMet: 3.6, metCv: 0.08, hrPerMet: 26 }));
    const g = learnedGuess(f({ avgMet: 5.1, metCv: 0.28, hrPerMet: 24 }), [...pb, ...walk], ['Pickleball', 'Walking']);
    expect(g?.label).toBe('Pickleball');
    expect(g?.source).toBe('learned');
    expect(g?.confidence ?? 0).toBeGreaterThan(0.5);
  });

  it('returns undefined with no tags or only very different ones', () => {
    expect(learnedGuess(f(), [], ['Running'])).toBeUndefined();
    const odd = [tag(0, 900, 'Running', { avgMet: 9, metCv: 0.6, vigorousFrac: 0.9, minutes: 200 })];
    expect(learnedGuess(f(), odd, ['Running'])).toBeUndefined();
  });

  it('ignores tags whose label is not in the user list', () => {
    const yoga = [tag(0, 900, 'Yoga', { avgMet: 5, metCv: 0.3, hrPerMet: 24 })];
    expect(learnedGuess(f({ avgMet: 5, metCv: 0.3, hrPerMet: 24 }), yoga, ['Pickleball'])).toBeUndefined();
  });
});

describe('suggest', () => {
  it('prefers a learned guess over the rule guess', () => {
    const tags = Array.from({ length: 3 }, (_, i) => tag(i * 1000, i * 1000 + 900, 'Chores'));
    expect(suggest(f(), tags, ['Chores', 'Walking'])?.label).toBe('Chores');
  });

  it('falls back to the rules with no tags', () => {
    expect(suggest(f(), [], ['Chores', 'Walking'])?.label).toBe('Walking');
  });

  it("doesn't let one tag of a different activity relabel an unrelated workout", () => {
    const weights = tag(0, 2700, 'Chores', { avgMet: 3.3, metCv: 0.05, minutes: 45, hrPerMet: 34.5, hour: 12 });
    const walk = f({ avgMet: 3.7, metCv: 0.05, minutes: 24, hrPerMet: 25.7, hour: 8 });
    expect(suggest(walk, [weights], ['Chores', 'Walking'])).toMatchObject({ label: 'Walking', source: 'rule' });
  });
});
