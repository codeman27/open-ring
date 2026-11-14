import { describe, expect, it } from 'vitest';
import { estimateStages } from './stager';
import type { Stage } from './timeline';

const START = 1_800_000_000;
const END = START + 8 * 3600;

/** Deterministic synthetic night: awake for the first 15 min, then a repeating 90-min light/deep/light/REM cycle. */
function buildNight() {
  let seed = 3;
  const r = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const truth: Stage[] = [];
  const motion: { unix: number; sec: number }[] = [];
  const hr: { unix: number; bpm: number }[] = [];
  const rmssd: { unix: number; ms: number }[] = [];
  for (let u = START + 30; u <= END; u += 30) {
    const minute = (u - START) / 60;
    const awake = minute < 15;
    let stage: Stage;
    if (awake) stage = 'awake';
    else {
      const c = ((minute - 15) % 90) / 90;
      const late = minute / 480;
      stage = c < 0.1 ? 'light' : c < 0.1 + 0.4 * (1 - late) ? 'deep' : c < 0.72 ? 'light' : 'rem';
    }
    truth.push(stage);
    motion.push({ unix: u, sec: awake ? 12 : 0 });
    if ((u - START) % 60 === 0) {
      const base = stage === 'deep' ? 50 : stage === 'light' ? 55 : stage === 'rem' ? 60 : 66;
      const jitter = stage === 'deep' ? 1 : stage === 'light' ? 2 : stage === 'rem' ? 5 : 4;
      hr.push({ unix: u, bpm: base + (r() - 0.5) * 2 * jitter });
    }
    if ((u - START) % 300 === 0) {
      const ms = stage === 'deep' ? 75 : stage === 'light' ? 60 : stage === 'rem' ? 45 : 40;
      rmssd.push({ unix: u, ms });
    }
  }
  return { start: START, end: END, motion, hr, rmssd, truth };
}

const count = (xs: Stage[], stage: Stage) => xs.filter((s) => s === stage).length;

describe('estimateStages', () => {
  it('estimates a full-length hypnogram that agrees with the synthetic truth', () => {
    const night = buildNight();
    const out = estimateStages({ start: night.start, end: night.end, motion: night.motion, hr: night.hr, rmssd: night.rmssd });
    expect(out).toBeDefined();
    const epochs = out!;
    expect(epochs).toHaveLength(960);
    expect(epochs[0]).toBe('awake');
    for (const stage of ['deep', 'rem', 'light'] as Stage[]) expect(count(epochs, stage)).toBeGreaterThan(0);
    const agree = epochs.filter((s, i) => s === night.truth[i]).length / epochs.length;
    expect(agree).toBeGreaterThanOrEqual(0.75);
  });

  it('front-loads deep sleep and back-loads REM within the night', () => {
    const { start, end, motion, hr, rmssd } = buildNight();
    const epochs = estimateStages({ start, end, motion, hr, rmssd })!;
    expect(epochs).toHaveLength(960);
    const half = Math.floor(epochs.length / 2);
    const firstHalf = epochs.slice(0, half);
    const secondHalf = epochs.slice(half);
    expect(count(firstHalf, 'deep')).toBeGreaterThan(count(secondHalf, 'deep'));
    expect(count(secondHalf, 'rem')).toBeGreaterThan(count(firstHalf, 'rem'));
  });

  it('never scores REM in the first 90 epochs after the first non-awake epoch', () => {
    const night = buildNight();
    const epochs = estimateStages({ start: night.start, end: night.end, motion: night.motion, hr: night.hr, rmssd: night.rmssd })!;
    const onset = epochs.findIndex((s) => s !== 'awake');
    expect(onset).toBeGreaterThanOrEqual(0);
    expect(epochs.slice(onset, onset + 90)).not.toContain('rem');
  });

  it('returns undefined without heart rate or for a window shorter than 10 minutes', () => {
    const night = buildNight();
    expect(estimateStages({ start: night.start, end: night.end, motion: night.motion, hr: [], rmssd: night.rmssd })).toBeUndefined();
    expect(estimateStages({ start: night.start, end: night.start + 9 * 60, motion: night.motion, hr: night.hr, rmssd: night.rmssd })).toBeUndefined();
  });

  it('still estimates stages when motion is sampled only every other epoch', () => {
    const night = buildNight();
    const out = estimateStages({ start: night.start, end: night.end, motion: night.motion.filter((_, i) => i % 2 === 0), hr: night.hr, rmssd: night.rmssd });
    expect(out).toBeDefined();
    expect(out!).toHaveLength(960);
  });

  it('returns all awake when motion is high throughout the night', () => {
    const { start, end, hr, rmssd } = buildNight();
    const motion = Array.from({ length: (end - start) / 30 }, (_, i) => ({ unix: start + (i + 1) * 30, sec: 20 }));
    const out = estimateStages({ start, end, motion, hr, rmssd });
    expect(out).toBeDefined();
    expect(out!.every((s) => s === 'awake')).toBe(true);
  });
});
