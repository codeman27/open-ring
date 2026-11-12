import { describe, expect, it } from 'vitest';
import { RingClock, baseline, nightKey, spo2FromR, summarize, TAG } from './timeline';
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
