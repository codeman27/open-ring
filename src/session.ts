/**
 * High-level ring workflows (probe, pair, sync, features, live HR) built on the
 * client, mirroring the open_oura CLI commands of the same names.
 */
import { RingLink, protocolLog } from './ble';
import { OuraClient, FEATURE, FEATURE_MODE, type FeatureStatus } from './client';
import { addReading, commitBatch, db, saveRing, syncState, type RingRecord } from './db';
import { hex, unhex, type Capability, type DeviceInfo } from './wasm';

export type Step = (message: string) => void;

export class RingSession {
  private device?: BluetoothDevice;
  private link?: RingLink;
  private client?: OuraClient;
  private authedKey?: string;

  get connected(): boolean {
    return !!this.link?.connected;
  }

  get deviceName(): string | undefined {
    return this.device?.name;
  }

  /** Connect, reusing the device picked earlier in this session when possible. */
  async connect(step: Step, deviceId?: string, forcePicker = false): Promise<OuraClient> {
    if (!forcePicker && this.link?.connected && this.client) return this.client;
    if (forcePicker) {
      this.disconnect();
      this.device = undefined;
    }
    this.device ??= (await RingLink.known(deviceId)) ?? undefined;
    if (!this.device) {
      step('Choose your ring in the Bluetooth picker…');
      this.device = await RingLink.pick();
    }
    step(`Connecting to ${this.device.name ?? 'ring'}…`);
    this.link = await RingLink.open(this.device);
    this.authedKey = undefined;
    this.link.disconnectListeners.add(() => (this.authedKey = undefined));
    protocolLog.push('info', `connected to ${this.device.name ?? this.device.id}`);
    this.client = new OuraClient(this.link);
    return this.client;
  }

  async authed(step: Step, ring: RingRecord): Promise<OuraClient> {
    const client = await this.connect(step, ring.deviceId);
    if (this.authedKey !== ring.keyHex) {
      step('Authenticating…');
      await client.authenticate(unhex(ring.keyHex));
      this.authedKey = ring.keyHex;
    }
    return client;
  }

  get currentDeviceId(): string | undefined {
    return this.device?.id;
  }

  disconnect(): void {
    this.link?.disconnect();
    this.link = undefined;
    this.client = undefined;
    this.authedKey = undefined;
  }
}

export interface ProbeResult {
  deviceName?: string;
  firmware?: DeviceInfo;
  serial?: string;
  hardwareId?: string;
  capabilities: Capability[];
  errors: string[];
}

/** Read-only first contact: nothing on the ring is changed. */
export async function probe(session: RingSession, step: Step): Promise<ProbeResult> {
  const client = await session.connect(step, undefined, true);
  const out: ProbeResult = { deviceName: session.deviceName, capabilities: [], errors: [] };
  const attempt = async <T,>(what: string, fn: () => Promise<T>) => {
    step(`Reading ${what}…`);
    try {
      return await fn();
    } catch (e) {
      out.errors.push(`${what}: ${e instanceof Error ? e.message : e}`);
      return undefined;
    }
  };
  out.firmware = await attempt('firmware', () => client.firmware());
  out.serial = await attempt('serial', () => client.serial());
  out.hardwareId = await attempt('hardware id', () => client.hardwareId());
  out.capabilities = (await attempt('capabilities', () => client.capabilities())) ?? [];
  return out;
}

const pendingKeyId = (serial: string) => `pendingKey:${serial}`;

/**
 * Pair a factory-reset ring: install a fresh key (persisted before it is sent, so
 * an interrupted pairing can be retried with the same key), verify it, and turn on
 * the measurement features the official app would enable at onboarding.
 */
export async function pairFreshRing(session: RingSession, step: Step): Promise<RingRecord> {
  const client = await session.connect(step, undefined, true);
  step('Reading ring identity…');
  const serial = await client.serial();
  const hardwareId = await client.hardwareId().catch(() => undefined);
  const firmware = await client.firmware().catch(() => undefined);

  const d = await db();
  let keyHex = (await d.get('kv', pendingKeyId(serial))) as string | undefined;
  if (!keyHex) {
    keyHex = hex(crypto.getRandomValues(new Uint8Array(16)));
    await d.put('kv', keyHex, pendingKeyId(serial));
  }
  const key = unhex(keyHex);

  step('Installing a new auth key on the ring…');
  await client.setAuthKey(key);
  step('Verifying the key…');
  await client.authenticate(key);

  const ring: RingRecord = {
    serial,
    keyHex,
    hardwareId,
    firmware,
    deviceId: session.currentDeviceId,
    deviceName: session.deviceName,
    pairedAt: Math.floor(Date.now() / 1000),
  };
  await saveRing(ring);
  await d.delete('kv', pendingKeyId(serial));

  step('Setting the ring clock…');
  await client.syncTime().catch(() => undefined);
  // A key-only pairing leaves measurement off; the official app enables these.
  for (const [label, id] of [
    ['daytime heart rate', FEATURE.DAYTIME_HR],
    ['SpO2', FEATURE.SPO2],
    ['real steps', FEATURE.REAL_STEPS],
    ['workout heart rate', FEATURE.EXERCISE_HR],
  ] as const) {
    step(`Enabling ${label}…`);
    await client.setFeatureMode(id, FEATURE_MODE.AUTOMATIC).catch((e) => protocolLog.push('info', `enable ${label} failed: ${e}`));
  }
  await recordBattery(client, serial);
  return ring;
}

/** Adopt a key obtained elsewhere (e.g. `oura pair` on Linux) after verifying it. */
export async function importKey(session: RingSession, step: Step, keyHex: string): Promise<RingRecord> {
  const key = unhex(keyHex);
  if (key.length !== 16) throw new Error('the auth key must be 32 hex characters (16 bytes)');
  const client = await session.connect(step, undefined, true);
  step('Reading ring identity…');
  const serial = await client.serial();
  step('Verifying the key…');
  await client.authenticate(key);
  const ring: RingRecord = {
    serial,
    keyHex: hex(key),
    hardwareId: await client.hardwareId().catch(() => undefined),
    firmware: await client.firmware().catch(() => undefined),
    deviceId: session.currentDeviceId,
    deviceName: session.deviceName,
    pairedAt: Math.floor(Date.now() / 1000),
    keyBackedUp: true,
  };
  await saveRing(ring);
  return ring;
}

async function recordBattery(client: OuraClient, serial: string): Promise<number | undefined> {
  try {
    const b = await client.battery();
    await addReading({ serial, kind: 'battery', value: b.percent });
    return b.percent;
  } catch {
    return undefined;
  }
}

export interface SyncResult {
  eventsSynced: number;
  battery?: number;
  seconds: number;
}

export async function syncRing(
  session: RingSession,
  ring: RingRecord,
  step: Step,
  signal?: AbortSignal,
): Promise<SyncResult> {
  const started = Date.now();
  const client = await session.authed(step, ring);
  if (session.currentDeviceId && session.currentDeviceId !== ring.deviceId) {
    ring = { ...ring, deviceId: session.currentDeviceId, deviceName: session.deviceName };
    await saveRing(ring);
  }
  const hw = ring.hardwareId ?? (await client.hardwareId().catch(() => ''));
  await client.setupAppStream(hw).catch((e) => protocolLog.push('info', `app stream setup: ${e}`));
  step('Setting the ring clock…');
  await client.syncTime().catch(() => undefined);
  // Ask the ring to finish sleep postprocessing so last night lands in this sync.
  await client.checkSleepAnalysis(false).catch(() => undefined);
  const battery = await recordBattery(client, ring.serial);

  const { cursor } = await syncState(ring.serial);
  step('Downloading history…');
  const out = await client.drainEvents(
    cursor,
    async (events, p) => {
      await commitBatch(ring.serial, events, p.nextCursor);
      const kb = (p.bytesLeft / 1024).toFixed(1);
      step(`Downloading history… ${p.eventsSynced.toLocaleString()} events${p.bytesLeft ? `, ${kb} KB left` : ''}`);
    },
    signal,
  );
  return { eventsSynced: out.eventsSynced, battery, seconds: (Date.now() - started) / 1000 };
}

export const FEATURE_ROWS = [
  { id: FEATURE.DAYTIME_HR, label: 'Daytime heart rate' },
  { id: FEATURE.SPO2, label: 'Blood oxygen (SpO2)' },
  { id: FEATURE.RESTING_HR, label: 'Resting heart rate' },
  { id: FEATURE.REAL_STEPS, label: 'Steps' },
  { id: FEATURE.EXERCISE_HR, label: 'Workout heart rate' },
] as const;

export async function readFeatures(session: RingSession, ring: RingRecord, step: Step) {
  const client = await session.authed(step, ring);
  const out: { id: number; label: string; status?: FeatureStatus; error?: string }[] = [];
  for (const row of FEATURE_ROWS) {
    step(`Reading ${row.label}…`);
    try {
      out.push({ ...row, status: await client.featureStatus(row.id) });
    } catch (e) {
      out.push({ ...row, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export async function setFeature(session: RingSession, ring: RingRecord, step: Step, id: number, on: boolean) {
  const client = await session.authed(step, ring);
  await client.setFeatureMode(id, on ? FEATURE_MODE.AUTOMATIC : FEATURE_MODE.OFF);
}

export async function liveHeartRate(
  session: RingSession,
  ring: RingRecord,
  step: Step,
  seconds: number,
  onBpm: (bpm: number) => void,
  signal: AbortSignal,
) {
  const client = await session.authed(step, ring);
  step('Listening for heartbeats (keep still)…');
  let last = 0;
  await client.liveHeartRate(
    seconds * 1000,
    (s) => {
      onBpm(s.bpm);
      last = s.bpm;
    },
    signal,
  );
  if (last) await addReading({ serial: ring.serial, kind: 'heart_rate_live', value: last });
}
