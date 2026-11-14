import { describe, expect, it } from 'vitest';
import { RingClock, baseline, nightKey, spo2FromR, stageStats, summarize, TAG } from './timeline';
import type { Stage } from './timeline';
import type { StoredEvent } from './db';

const NOW = 1_794_000_000;
const ev = (tag: number, ts: number, decoded: Record<string, unknown>): StoredEvent => ({
  serial: 'S',
  tag,
  ts,
  body_hex: `${tag}-${ts}`,
  name: '',
  decoded,
  captured: NOW,
});

describe('RingClock', () => {
  it('dates events from the nearest anchor at 10 deciseconds per second', () => {
    const clock = RingClock.fromEvents([ev(TAG.TIME_SYNC, 1000, { unix_time: NOW - 3600 }), ev(TAG.RTC_BEACON, 37_000, { unix_time: NOW })], undefined, NOW);
    expect(clock.toUnix(1000)).toBe(NOW - 3600);
    expect(clock.toUnix(1600)).toBe(NOW - 3600 + 60);
    expect(clock.toUnix(36_400)).toBe(NOW - 60);
  });

  it('uses the last sync as a fallback anchor and rejects future times', () => {
    const clock = RingClock.fromEvents([], { serial: 'S', cursor: 0, newestTs: 5000, lastSyncUnix: NOW }, NOW);
    expect(clock.anchored).toBe(false);
    expect(clock.toUnix(4400)).toBe(NOW - 60);
    expect(clock.toUnix(5000 + 10 * 7 * 3600)).toBeNull();
  });
});

describe('baseline', () => {
  const night = (key: string, avgHrv?: number) => ({ key, hrvSamples: 0, avgHrv });

  it('averages prior nights only and needs three of them', () => {
    expect(baseline([night('a', 50), night('b', 60), night('c', 999)], (n) => n.avgHrv)).toBeUndefined();
    const b = baseline([night('a', 50), night('b', 60), night('c'), night('d', 70), night('e', 999)], (n) => n.avgHrv);
    expect(b).toEqual({ avg: 60, min: 50, max: 70, n: 3 });
  });
});

describe('summarize', () => {
  it('builds nightly HRV, lowest HR, SpO2 and bedtime from ring events', () => {
    const clock = new RingClock([{ ts: 0, unix: NOW }], undefined, NOW + 86400);
    const bedStart = 10 * 3600 * 10;
    const bedEnd = bedStart + 8 * 3600 * 10;
    const s = summarize(
      [
        ev(TAG.HRV, bedStart + 6000, { hr_bpm: [52, 48, 0], rmssd_ms: [60, 80, 0] }),
        ev(TAG.SPO2_R_PI, bedStart + 9000, { r: [0.6], perfusion_index: [0.01] }),
        ev(TAG.BEDTIME, bedEnd, { bedtime_start_ds: bedStart, bedtime_end_ds: bedEnd }),
        ev(TAG.GREEN_IBI, 100, { hr_bpm: [60, 62, 64] }),
      ],
      clock,
    );
    expect(s.nights).toHaveLength(1);
    const n = s.nights[0];
    expect(n.key).toBe(nightKey(NOW + bedEnd / 10));
    expect(n.lowestHr).toBe(48);
    expect(n.avgHrv).toBe(70);
    expect(n.sleepHours).toBe(8);
    expect(n.spo2).toBe(Math.round(spo2FromR(0.6)));
    expect(s.hrSeries).toEqual([{ unix: NOW + 10, bpm: 62 }]);
  });
});

describe('stageStats', () => {
  it('derives latency, sleep minutes, awake time and efficiency from 30 s epochs', () => {
    const st = stageStats(['awake', 'awake', 'light', 'deep', 'rem', 'awake', 'light', 'light']);
    expect(st?.latencyMin).toBe(1); // first sleep epoch is the third one: 2 x 30 s
    expect(st?.sleepMin).toBe(3); // 5 asleep epochs = 2.5 min, rounds to 3
    expect(st?.awakeMin).toBe(2); // 3 awake epochs = 1.5 min, rounds to 2
    expect(st?.efficiency).toBe(0.63); // 5 of 8 epochs asleep = 0.625, rounds to 0.63
    expect(st?.wakeAfterOnset).toBeCloseTo(0.17, 2); // 1 of the 6 post-onset epochs is awake
  });

  it('is undefined for an empty hypnogram', () => {
    expect(stageStats([])).toBeUndefined();
  });
});

describe('summarize hypnogram assembly', () => {
  const page = (phases: Stage[]) => ({ header: phases.length, phases });

  it('anchors the ring hypnogram at bedtime and trims it to the bedtime window', () => {
    const clock = new RingClock([{ ts: 0, unix: NOW }], undefined, NOW + 86400);
    const bedStartDs = 23 * 3600 * 10; // a 1-hour (120-epoch) window ending at ring counter NOW+24h

    const p0: Stage[] = ['awake', 'awake', 'light', 'deep', 'rem', ...new Array<Stage>(47).fill('deep')]; // 52 epochs
    const p1: Stage[] = new Array<Stage>(52).fill('deep');
    const p2: Stage[] = new Array<Stage>(30).fill('light'); // third page pushes the total past 120 epochs

    const s = summarize(
      [
        ev(TAG.SLEEP_PHASE_DATA, bedStartDs + 60 * 10, { header: 0, phases: p0 }),
        // One minute after the window end so the event dates inside it (not at local midnight).
        ev(TAG.BEDTIME, bedStartDs + (3600 + 60) * 10, { bedtime_start_ds: bedStartDs, bedtime_end_ds: bedStartDs + 3600 * 10 }),
        ev(TAG.SLEEP_PHASE_DATA, bedStartDs + 3000 * 10, { header: 1, phases: p1 }),
        ev(TAG.SLEEP_PHASE_DATA, bedStartDs + 3540 * 10, page(p2)),
      ],
      clock,
    );
    const n = s.nights.find((x) => x.stages);
    expect(n).toBeDefined();
    expect(n?.stages?.start).toBe(NOW + bedStartDs / 10);
    expect(n?.stages?.epochs.length).toBe(120); // trimmed to the 1-hour bedtime window
    expect(n?.stageStats).toBeDefined();
    expect(n?.sleepHours).toBe(1);
  });

  it('uses only the tag with the most epochs when a night carries two phase tags', () => {
    const clock = new RingClock([{ ts: 0, unix: NOW }], undefined, NOW + 86400);
    const t0 = 12 * 3600; // both events date to the same night
    const s = summarize(
      [
        ev(TAG.SLEEP_PHASE_INFO, t0, { header: 0, phases: new Array<Stage>(10).fill('light') }),
        ev(TAG.SLEEP_PHASE_DATA, t0 + 60, { header: 0, phases: new Array<Stage>(104).fill('deep') }),
      ],
      clock,
    );
    const n = s.nights[0];
    expect(n.stages?.epochs.length).toBe(104); // the smaller tag is dropped, not concatenated
    expect(n.stageStats).toEqual({
      deepMin: 52, lightMin: 0, remMin: 0, awakeMin: 0, sleepMin: 52,
      latencyMin: 0, efficiency: 1, wakeAfterOnset: 0, // no awake epochs at all
    });
  });
});
