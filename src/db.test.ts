import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { commitBatch, eventsByTag } from './db';
import type { DecodedEvent } from './wasm';

const ev = (tag: number, ts: number): DecodedEvent => ({ tag, name: 'meditation', timestamp: ts, body_hex: `${tag}-${ts}`, decoded: null });

/** More events than one engine call-argument limit, so a spread-push would blow the stack. */
const MANY = 130_000;

describe('eventsByTag', () => {
  it('returns every accumulated event for a tag without exhausting the call stack', async () => {
    const events = Array.from({ length: MANY }, (_, i) => ev(25, i * 300));
    await commitBatch('bulk', events, 999);
    const got = await eventsByTag('bulk', [25]);
    expect(got.length).toBe(MANY);
    expect(got[0].ts).toBe(0);
    expect(got[MANY - 1].ts).toBe((MANY - 1) * 300);
  }, 60_000);

  it('keeps index order and stays idempotent across tags', async () => {
    await commitBatch('S', [ev(25, 20), ev(24, 10), ev(25, 10)], 1);
    await commitBatch('S', [ev(25, 20)], 1);
    const got = await eventsByTag('S', [24, 25]);
    expect(got.map((e) => `${e.tag}-${e.ts}`)).toEqual(['24-10', '25-10', '25-20']);
  });
});
