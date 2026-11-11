import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import init from './wasm-pkg/oura_wasm.js';
import { OuraClient } from './client';
import { hex, unhex } from './wasm';
import type { Transport } from './ble';

/** Scripted transport: maps request hex to canned notification frames. */
class MockTransport implements Transport {
  readonly disconnectListeners = new Set<() => void>();
  private listeners = new Set<(f: Uint8Array) => void>();
  readonly writes: string[] = [];
  constructor(private script: Record<string, string[]>) {}
  async write(data: Uint8Array) {
    const key = hex(data);
    this.writes.push(key);
    for (const f of this.script[key] ?? []) queueMicrotask(() => this.listeners.forEach((l) => l(unhex(f))));
  }
  subscribe(fn: (f: Uint8Array) => void) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
}

beforeAll(async () => {
  await init({ module_or_path: readFileSync(new URL('./wasm-pkg/oura_wasm_bg.wasm', import.meta.url)) });
});

describe('OuraClient over a mock link', () => {
  it('reads firmware', async () => {
    const c = new OuraClient(new MockTransport({ '0803000000': ['091202000003040301000105000cffeeddccbbaa'] }), 20);
    expect((await c.firmware()).firmware_version).toBe('3.4.3');
  });

  it('authenticates with the open_oura known-answer vector', async () => {
    const link = new MockTransport({
      '2f012b': ['2f102c0e2d6a0a08c99b4365f458e6e97382'],
      '2f112da38a8772d3acb6db5c2b516dd56987c8': ['2f022e00'],
    });
    await new OuraClient(link, 20).authenticate(unhex('4431967d8bacc2659743142b68391d9a'));
    expect(link.writes).toEqual(['2f012b', '2f112da38a8772d3acb6db5c2b516dd56987c8']);
  });

  it('surfaces a rejected key', async () => {
    const link = new MockTransport({
      '2f012b': ['2f102c0e2d6a0a08c99b4365f458e6e97382'],
      '2f112da38a8772d3acb6db5c2b516dd56987c8': ['2f022e01'],
    });
    await expect(new OuraClient(link, 20).authenticate(unhex('4431967d8bacc2659743142b68391d9a'))).rejects.toThrow(/rejected/);
  });

  it('falls back to legacy GetEvent and drains until the ring is empty', async () => {
    const link = new MockTransport({
      '280100': ['290100'],
      // ExtGetEvent from cursor 0 → "unsupported"
      [hex(new Uint8Array([0x2f, 0x0c, 0x41, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x10]))]: ['2f0100'],
      // GetEvent(0, 255, -1) → one temp event at ds 100, bytes_left 0
      '100900000000ffffffffff': ['4606640000001c0c', '110801000000000000'],
      // GetEvent(101, 255, -1) → empty, drained
      '100965000000ffffffffff': ['110800000000000000'],
    });
    const batches: number[] = [];
    const out = await new OuraClient(link, 20).drainEvents(0, async (events, p) => {
      batches.push(events.length);
      expect(p.nextCursor).toBe(101);
    });
    expect(out).toEqual({ eventsSynced: 1, nextCursor: 101 });
    expect(batches).toEqual([1, 0]);
    expect(link.writes.filter((w) => w.startsWith('2f0c'))).toHaveLength(1);
  });
});
