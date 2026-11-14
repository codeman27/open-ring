import { describe, expect, it } from 'vitest';
import { activityScore, curve, readinessScore, sleepScore, tier } from './scores';
import type { Day, Night, StageStats } from './timeline';

const at = (d: number, h: number) => new Date(2026, 0, d, h).getTime() / 1000;

const night = (key: string, fields: Partial<Night> = {}): Night => ({ key, hrvSamples: 0, ...fields });

describe('curve', () => {
  it('interpolates between points and clamps at both ends', () => {
    const pts: [number, number][] = [[0, 0], [10, 100]];
    expect(curve(5, pts)).toBe(50);
    expect(curve(-3, pts)).toBe(0);
    expect(curve(42, pts)).toBe(100);
  });
});

describe('sleepScore', () => {
  const n8 = night('2026-01-02', { sleepHours: 8, bedtimeStart: at(1, 23), bedtimeEnd: at(2, 7), spo2: 96 });

  it('scores a regular 8h night at 100 and is provisional without prior nights', () => {
    const s = sleepScore([n8]);
    expect(s?.score).toBe(100);
    expect(s?.provisional).toBe(true);
  });

  it('scores a short night lower than the same regular 8h night', () => {
    const n5 = night('2026-01-03', { sleepHours: 5, bedtimeStart: at(1, 23), bedtimeEnd: at(2, 4), spo2: 96 });
    expect(sleepScore([n5])?.score).toBeLessThan(sleepScore([n8])!.score);
  });
});

describe('readinessScore', () => {
  const priorNights = [1, 2, 3, 4, 5].map((d) =>
    night(`2026-01-${String(d).padStart(2, '0')}`, {
      lowestHr: 50, avgHrv: 60, skinTemp: 35, sleepHours: 8,
      bedtimeStart: at(d - 1, 23), bedtimeEnd: at(d, 7), spo2: 96,
    }),
  );

  it('returns undefined with no nights', () => {
    expect(readinessScore([], [])).toBeUndefined();
  });

  it('scores a consistent week >= 85 and not provisional once baselines mature', () => {
    const last = night('2026-01-06', { lowestHr: 50, avgHrv: 60, skinTemp: 35, sleepHours: 8, bedtimeStart: at(5, 23), bedtimeEnd: at(6, 7), spo2: 96 });
    const s = readinessScore([...priorNights, last], []);
    expect(s?.score ?? -1).toBeGreaterThanOrEqual(85);
    expect(s?.provisional).toBe(false);
  });

  it('scores a rough night < 60 (low tier)', () => {
    const last = night('2026-01-06', { lowestHr: 60, avgHrv: 30, skinTemp: 36, sleepHours: 4, bedtimeStart: at(5, 23), bedtimeEnd: at(6, 7), spo2: 96 });
    const s = readinessScore([...priorNights, last], []);
    expect(s?.score ?? Infinity).toBeLessThan(60);
    expect(tier(s!.score)).toBe('low');
  });
});

describe('activityScore', () => {
  const today: Day = { key: '2026-01-03', hrSamples: 0, avgMet: 2 };
  const earlier: Day[] = [
    { key: '2026-01-01', hrSamples: 0, avgMet: 1 },
    { key: '2026-01-02', hrSamples: 0, avgMet: 1 },
  ];

  it('returns undefined when no day matches todayKey', () => {
    expect(activityScore([earlier[0]], '2026-01-03')).toBeUndefined();
  });

  it('is provisional with one contributor for today only, and lower once prior days count', () => {
    const solo = activityScore([today], '2026-01-03');
    expect(solo?.provisional).toBe(true);
    expect(solo?.contributors).toHaveLength(1);
    const withPrior = activityScore([...earlier, today], '2026-01-03');
    expect(withPrior?.score ?? Infinity).toBeLessThan(solo!.score);
  });
});

describe('tier', () => {
  it('maps scores to good/fair/low bands', () => {
    expect(tier(75)).toBe('good');
    expect(tier(74)).toBe('fair');
    expect(tier(60)).toBe('fair');
    expect(tier(59)).toBe('low');
  });
});

describe('sleepScore with the ring hypnogram', () => {
  const staged = (fields: Partial<StageStats> = {}): StageStats => ({
    sleepMin: 450, deepMin: 80, remMin: 110, lightMin: 260, awakeMin: 20,
    latencyMin: 12, efficiency: 0.95, wakeAfterOnset: 0.03, ...fields,
  });

  const good = night('2026-01-02', { sleepHours: 7.5, bedtimeStart: at(1, 23), bedtimeEnd: at(2, 7), stageStats: staged() });

  it('scores a strong staged night >= 90, not provisional, with the hypnogram contributors', () => {
    const s = sleepScore([good]);
    expect(s?.score).toBeGreaterThanOrEqual(90);
    expect(s?.provisional).toBe(false);
    const labels = s!.contributors.map((c) => c.label);
    for (const want of ['Deep sleep', 'REM sleep', 'Restfulness']) expect(labels).toContain(want);
  });

  it('scores the same night lower when deep and REM drop', () => {
    const weak = night('2026-01-03', { ...good, stageStats: staged({ deepMin: 15, remMin: 25 }) });
    expect(sleepScore([weak])?.score).toBeLessThan(sleepScore([good])!.score);
  });
});
