import { describe, expect, it } from 'vitest';
import { detectExercises, intensityOf } from './exercise';
import { metSeries } from './timeline';
import type { Night } from './timeline';

const T = 1_800_000_000;
const minutes = (startMin: number, mets: number[]) => mets.map((met, i) => ({ unix: T + (startMin + i) * 60, met }));
const beats = (startMin: number, bpms: number[]) => bpms.map((bpm, i) => ({ unix: T + (startMin + i) * 60, bpm }));
const constMets = (n: number, v: number) => Array.from({ length: n }, () => v);

describe('detectExercises', () => {
  it('detects a single sustained moderate session with correct duration and intensity', () => {
    const met = [...minutes(0, constMets(20, 1.2)), ...minutes(20, constMets(25, 5)), ...minutes(45, constMets(20, 1.2))];
    const exs = detectExercises(met, []);
    expect(exs).toHaveLength(1);
    expect(exs[0].minutes).toBe(25);
    expect(exs[0].intensity).toBe('moderate');
    expect(exs[0].avgMet).toBe(5);
  });

  it('does not detect a burst shorter than 10 minutes', () => {
    const met = [...minutes(0, constMets(20, 1.2)), ...minutes(20, constMets(6, 5)), ...minutes(26, constMets(20, 1.2))];
    expect(detectExercises(met, [])).toHaveLength(0);
  });

  it('merges two blocks separated by a short dip below the active threshold', () => {
    const met = [...minutes(0, constMets(12, 5)), ...minutes(12, [2, 2]), ...minutes(14, constMets(12, 5))];
    expect(detectExercises(met, [])).toHaveLength(1);
  });

  it('splits two blocks separated by a long dip and returns newest first', () => {
    const met = [...minutes(0, constMets(12, 5)), ...minutes(12, constMets(10, 2)), ...minutes(22, constMets(12, 5))];
    const exs = detectExercises(met, []);
    expect(exs).toHaveLength(2);
    expect(exs[0].start).toBeGreaterThan(exs[1].start);
  });

  it('ignores bins inside a night bedtime window', () => {
    const met = minutes(0, constMets(25, 5));
    const night: Night = { key: 'x', hrvSamples: 0, bedtimeStart: T - 3600, bedtimeEnd: T + 3600 };
    expect(detectExercises(met, [], [night])).toHaveLength(0);
  });

  it('attaches heart-rate samples inside the session and computes avg/peak hr', () => {
    const met = [...minutes(0, constMets(20, 1.2)), ...minutes(20, constMets(25, 5)), ...minutes(45, constMets(20, 1.2))];
    const inSession = beats(20, Array.from({ length: 25 }, (_, i) => 100 + i));
    const hr = [{ unix: T + 20 * 60 - 3600, bpm: 999 }, ...inSession];
    const exs = detectExercises(met, hr);
    expect(exs).toHaveLength(1);
    expect(exs[0].hr).toHaveLength(25);
    expect(exs[0].hr[0]).toEqual({ unix: T + 20 * 60, bpm: 100 });
    expect(exs[0].hr.at(-1)).toEqual({ unix: T + 44 * 60, bpm: 124 });
    expect(exs[0].avgHr).toBe(112);
    expect(exs[0].peakHr).toBe(124);
  });
});

describe('intensityOf', () => {
  it('maps MET to light/moderate/vigorous at the 4 and 6 thresholds', () => {
    expect(intensityOf(3.5)).toBe('light');
    expect(intensityOf(4)).toBe('moderate');
    expect(intensityOf(6)).toBe('vigorous');
  });
});

describe('metSeries', () => {
  it('bins from the event gap when plausible, falling back to one minute otherwise', () => {
    const out = metSeries([
      { unix: 1000, met: [1, 2] },
      { unix: 1240, met: [3, 4] },
    ]);
    expect(out).toEqual([
      { unix: 940, met: 1 },
      { unix: 1000, met: 2 },
      { unix: 1120, met: 3 },
      { unix: 1240, met: 4 },
    ]);
  });
});
