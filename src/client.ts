/**
 * `OuraClient` — TypeScript port of `oura-link::client::OuraClient` over Web
 * Bluetooth. Byte building/parsing/crypto all come from the Rust bridge; this file
 * only sequences requests and waits for the ring's responses, mirroring the Rust
 * client's terminators and timeouts.
 */
import { transactUntil, type Transport } from './ble';
import {
  wasm,
  parseFrame,
  decodeBatch,
  type Packet,
  type DeviceInfo,
  type Battery,
  type Capability,
  type DecodedEvent,
} from './wasm';

export const DEFAULT_QUIET_MS = 1500;
const DRAIN_QUIET_MS = 6000;
const EXT_BATCH_MAX_EVENTS = 4096;
const MAX_TAIL_PASSES = 3;
const TAIL_BATCH_EVENTS = 32;

export const FEATURE = {
  DAYTIME_HR: 0x02,
  EXERCISE_HR: 0x03,
  SPO2: 0x04,
  RESTING_HR: 0x08,
  REAL_STEPS: 0x0b,
} as const;

export const FEATURE_MODE = { OFF: 0, AUTOMATIC: 1, REQUESTED: 2, CONNECTED_LIVE: 3 } as const;

export const AUTH_RESULT: Record<number, string> = {
  0: 'success',
  1: 'authentication error: the ring rejected this key',
  2: 'the ring is factory-reset and has no key installed yet; pair it first',
  3: 'the ring is onboarded to a different key',
};

export class AuthError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export interface FeatureStatus {
  feature: number;
  mode: number;
  status: number;
  state: number;
  subscription: number;
}

export interface LatestValues {
  bpm?: number;
  spo2?: number;
}

export interface BatchProgress {
  nextCursor: number;
  bytesLeft: number;
  eventsSynced: number;
}

export class OuraClient {
  constructor(
    readonly link: Transport,
    private quietMs = DEFAULT_QUIET_MS,
  ) {}

  private async requestUntil(
    bytes: Uint8Array,
    terminal: (p: Packet) => boolean,
    quietMs = this.quietMs,
  ): Promise<Packet[]> {
    const frames = await transactUntil(this.link, bytes, quietMs, (f) => parseFrame(f).some(terminal));
    return frames.flatMap(parseFrame);
  }

  private request(bytes: Uint8Array) {
    return this.requestUntil(bytes, () => false);
  }
  private requestTag(bytes: Uint8Array, tag: number) {
    return this.requestUntil(bytes, (p) => p.tag === tag);
  }
  private requestExt(bytes: Uint8Array, ext: number) {
    return this.requestUntil(bytes, (p) => p.ext === ext);
  }

  // --- device info ---------------------------------------------------------

  async firmware(): Promise<DeviceInfo> {
    const p = (await this.requestTag(wasm.reqFirmware(), 0x09)).find((p) => p.tag === 0x09);
    const info = p && (wasm.parseDeviceInfo(p.tag, new Uint8Array(p.payload)) as DeviceInfo | null);
    if (!info) throw new Error('no firmware response');
    return info;
  }

  async battery(): Promise<Battery> {
    const p = (await this.requestTag(wasm.reqBattery(), 0x0d)).find((p) => p.tag === 0x0d);
    const b = p && (wasm.parseBattery(p.tag, new Uint8Array(p.payload)) as Battery | null);
    if (!b) throw new Error('no battery response (authentication required?)');
    return b;
  }

  private async product(req: Uint8Array, what: string): Promise<string> {
    const p = (await this.requestTag(req, 0x19)).find((p) => p.tag === 0x19);
    const s = p && wasm.parseProductAscii(p.tag, new Uint8Array(p.payload));
    if (!s) throw new Error(`no ${what} response`);
    return s;
  }

  serial(): Promise<string> {
    return this.product(wasm.reqSerial(), 'serial');
  }

  hardwareId(): Promise<string> {
    return this.product(wasm.reqHardware(), 'hardware id');
  }

  async capabilities(): Promise<Capability[]> {
    const caps: Capability[] = [];
    for (const page of [0, 1]) {
      const p = (await this.requestExt(wasm.reqCapabilities(page), 0x02)).find((p) => p.ext === 0x02);
      if (p) caps.push(...(wasm.parseCapabilities(p.tag, new Uint8Array(p.payload)) as Capability[]));
    }
    return caps;
  }

  // --- auth ----------------------------------------------------------------

  /** App-auth challenge; must be repeated on every connection once a key is set. */
  async authenticate(key: Uint8Array): Promise<void> {
    const n = (await this.requestExt(wasm.reqAuthNonce(), 0x2c)).find((p) => p.ext === 0x2c);
    if (!n || n.payload.length <= 1) throw new Error('no auth nonce response from the ring');
    const encrypted = wasm.encryptNonce(key, new Uint8Array(n.payload.slice(1)));
    const r = (await this.requestExt(wasm.reqAuthenticate(encrypted), 0x2e)).find((p) => p.ext === 0x2e);
    const state = r?.payload[1];
    if (state === undefined) throw new Error('no authenticate response from the ring');
    if (state !== 0) {
      throw new AuthError(state, `ring rejected auth (0x${state.toString(16)}): ${AUTH_RESULT[state] ?? 'unknown state'}`);
    }
  }

  /** Install a 16-byte key. Only accepted by a factory-reset ring. */
  async setAuthKey(key: Uint8Array): Promise<void> {
    const p = (await this.requestTag(wasm.reqSetAuthKey(key), 0x25)).find((p) => p.tag === 0x25);
    if (!p) throw new Error('no set-auth-key response');
    if (p.payload[0] !== 0) {
      throw new Error(`ring refused the new key (status 0x${p.payload[0]?.toString(16)}). Is it factory-reset?`);
    }
  }

  // --- session setup -------------------------------------------------------

  /** Official-app counter form, falling back to the older unix+timezone form. */
  async syncTime(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const token = ((now & 0xff) * 37 + 0xa5) & 0xff;
    try {
      await this.request(wasm.reqSyncTimeCounter(now, token));
    } catch {
      await this.request(wasm.reqSyncTime(now, 0));
    }
  }

  /** Ring 5 app-style stream registration; skipped on other hardware like the CLI. */
  async setupAppStream(hardwareId: string): Promise<void> {
    if (hardwareId.split('_').pop() !== '05') return;
    await this.requestTag(wasm.reqStreamSubscribe(0x02), 0x17);
    for (const [category, flags] of [
      [0x14, 0x1000],
      [0x18, 0x1000],
      [0x28, 0x0900],
      [0x34, 0x0400],
      [0x04, 0x1000],
      [0x08, 0x1000],
    ]) {
      await this.requestTag(wasm.reqEventSubscribe(category, flags), 0x19);
    }
    for (const [req, ext] of [
      [wasm.reqParamRead(0x02), 0x21],
      [wasm.reqParamRead(0x04), 0x21],
      [new Uint8Array([0x2f, 0x02, 0x03, 0x01]), 0x04],
      [wasm.reqParamRead(0x0b), 0x21],
      [wasm.reqParamRead(0x0d), 0x21],
      [wasm.reqParamRead(0x03), 0x21],
      [wasm.reqParamRead(0x0b), 0x21],
      [wasm.reqParamRead(0x10), 0x21],
    ] as const) {
      await this.requestExt(req, ext);
    }
  }

  async checkSleepAnalysis(force: boolean): Promise<number | undefined> {
    const p = (await this.requestTag(wasm.reqCheckSleepAnalysis(force), 0x29)).find((p) => p.tag === 0x29);
    return p?.payload[0];
  }

  // --- features ------------------------------------------------------------

  async featureStatus(feature: number): Promise<FeatureStatus> {
    const p = (await this.requestExt(wasm.reqFeatureStatus(feature), 0x21)).find(
      (p) => p.ext === 0x21 && p.payload.length >= 6,
    );
    if (!p) throw new Error('no feature-status response');
    const [, f, mode, status, state, subscription] = p.payload;
    return { feature: f, mode, status, state, subscription };
  }

  async setFeatureMode(feature: number, mode: number): Promise<void> {
    const p = (await this.requestExt(wasm.reqSetFeatureMode(feature, mode), 0x23)).find((p) => p.ext === 0x23);
    if (!p) throw new Error('no set-feature-mode response');
    const result = p.payload[2];
    if (result !== 0) throw new Error(`set-feature-mode rejected (0x${result?.toString(16)})`);
  }

  async featureLatest(feature: number): Promise<LatestValues> {
    const p = (await this.requestExt(wasm.reqFeatureLatest(feature), 0x25)).find((p) => p.ext === 0x25);
    if (!p) throw new Error('no feature-latest response');
    const data = p.payload.slice(7);
    const out: LatestValues = {};
    if (feature === FEATURE.DAYTIME_HR && data.length >= 2) {
      const ibi = data[0] | (data[1] << 8);
      if (ibi >= 300 && ibi <= 2000) out.bpm = Math.floor(60000 / ibi);
    } else if (feature === FEATURE.EXERCISE_HR && data[4]) {
      out.bpm = data[4];
    } else if (feature === FEATURE.SPO2) {
      if (data[3]) out.spo2 = data[3];
      if (data[4]) out.bpm = data[4];
    }
    return out;
  }

  // --- history -------------------------------------------------------------

  /**
   * Drain history from `cursor` (deciseconds). `onBatch` runs after each batch
   * and must persist events + cursor together before the next request; if it
   * throws, the drain stops without advancing past unstored events. Mirrors
   * `drain_events`, including the extended→legacy fallback and the tail guard.
   */
  async drainEvents(
    cursor: number,
    onBatch: (events: DecodedEvent[], progress: BatchProgress) => Promise<void>,
    signal?: AbortSignal,
  ): Promise<{ eventsSynced: number; nextCursor: number }> {
    let start = cursor;
    let total = 0;
    let tailPasses = 0;
    let useExtended = true;
    const batchTerminal = (p: Packet) => p.tag === 0x11 || (p.tag === 0x2f && (p.payload[0] === 0x42 || p.payload[0] === 0x00));
    const quiet = Math.max(this.quietMs, Math.min(this.quietMs * 4, DRAIN_QUIET_MS));
    const collect = (req: Uint8Array) =>
      transactUntil(this.link, req, quiet, (f) => parseFrame(f).some(batchTerminal));

    for (let i = 0; i < 100_000; i++) {
      if (signal?.aborted) throw new Error('sync cancelled');
      const frames = await transactUntil(this.link, wasm.reqDataFlush(), this.quietMs, (f) =>
        parseFrame(f).some((p) => p.tag === 0x29),
      );
      if (useExtended) {
        const ext = await collect(wasm.reqExtGetEvent(start * 100, EXT_BATCH_MAX_EVENTS, 0));
        const unsupported = ext.flatMap(parseFrame).some((p) => p.tag === 0x2f && p.payload[0] === 0x00);
        if (unsupported) {
          useExtended = false;
          frames.push(...(await collect(wasm.reqGetEvent(start, 255, -1))));
        } else {
          frames.push(...ext);
        }
      } else {
        frames.push(...(await collect(wasm.reqGetEvent(start, 255, -1))));
      }

      let batch;
      try {
        batch = decodeBatch(frames, start);
      } catch (e) {
        throw new Error(`${e instanceof Error ? e.message : e}. The link may have dropped mid-batch; progress up to cursor ${start} is saved, so sync again to resume.`);
      }
      total += batch.events.length;
      const tail = batch.progressed && batch.bytes_left === 0 && batch.events.length < TAIL_BATCH_EVENTS;
      if (batch.progressed) start = batch.next_cursor;
      await onBatch(batch.events, { nextCursor: start, bytesLeft: batch.bytes_left, eventsSynced: total });

      if (!batch.progressed) {
        if (batch.bytes_left === 0) break;
        throw new Error(`ring reports ${batch.bytes_left} bytes left but sent no events; stopping (cursor ${start})`);
      }
      if (tail) {
        if (++tailPasses >= MAX_TAIL_PASSES) break;
      } else {
        tailPasses = 0;
      }
    }
    return { eventsSynced: total, nextCursor: start };
  }

  // --- live ----------------------------------------------------------------

  /** Live heart rate via daytime-HR CONNECTED_LIVE; restores AUTOMATIC on exit. */
  async liveHeartRate(
    durationMs: number,
    onSample: (s: { bpm: number; ibi_ms: number }) => void,
    signal?: AbortSignal,
  ): Promise<void> {
    const unsubscribe = this.link.subscribe((frame) => {
      const s = wasm.parseLiveHr(frame) as { bpm: number; ibi_ms: number } | null;
      if (s) onSample(s);
    });
    try {
      await this.link.write(wasm.reqSetFeatureMode(FEATURE.DAYTIME_HR, FEATURE_MODE.CONNECTED_LIVE));
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, durationMs);
        signal?.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true });
        this.link.disconnectListeners.add(resolve);
      });
    } finally {
      unsubscribe();
      await this.link.write(wasm.reqSetFeatureMode(FEATURE.DAYTIME_HR, FEATURE_MODE.AUTOMATIC)).catch(() => undefined);
    }
  }
}
