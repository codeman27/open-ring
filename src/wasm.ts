import init, * as wasm from './wasm-pkg/oura_wasm.js';

let loaded: Promise<unknown> | null = null;

/** Load the Rust protocol bridge once. Every protocol call goes through it. */
export function ready(): Promise<unknown> {
  loaded ??= init();
  return loaded;
}

export { wasm };

export interface Packet {
  tag: number;
  ext: number | null;
  payload: number[];
}

export interface DeviceInfo {
  api_version: string;
  firmware_version: string;
  bootloader_version: string;
  bt_stack_version: string;
  mac: string;
}

export interface Battery {
  percent: number;
  charging_progress: number;
  charging_recommended: number;
}

export interface Capability {
  feature: number;
  value: number;
}

export interface DecodedEvent {
  tag: number;
  name: string;
  timestamp: number;
  body_hex: string;
  decoded: Record<string, unknown> | null;
}

export interface Batch {
  events: DecodedEvent[];
  bytes_left: number;
  next_cursor: number;
  rejected_events: number;
  replayed_events: number;
  progressed: boolean;
}

export const parseFrame = (frame: Uint8Array): Packet[] => wasm.parseFrame(frame);

/** Encode notification frames as `[u16 LE len][frame]...` for `decodeBatch`. */
export function frameBuffer(frames: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(frames.reduce((n, f) => n + 2 + f.length, 0));
  let o = 0;
  for (const f of frames) {
    out[o] = f.length & 0xff;
    out[o + 1] = f.length >> 8;
    out.set(f, o + 2);
    o += 2 + f.length;
  }
  return out;
}

export const decodeBatch = (frames: Uint8Array[], start: number): Batch =>
  wasm.decodeBatch(frameBuffer(frames), start);

export const hex = (bytes: Uint8Array | number[]): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export function unhex(text: string): Uint8Array {
  const clean = text.trim().toLowerCase();
  if (!/^([0-9a-f]{2})*$/.test(clean)) throw new Error('not valid hex');
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}
