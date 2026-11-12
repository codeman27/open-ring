/**
 * Web Bluetooth transport: the browser counterpart of `oura-link`'s
 * `BleTransport`. Notifications from every notify/indicate characteristic in the
 * Oura service are merged into one stream (Ring 5 exposes extra ones), and writes
 * are serialized because Web Bluetooth rejects overlapping GATT operations.
 */

export const OURA_SERVICE = '98ed0001-a541-11e4-b6a0-0002a5d5c51b';
export const OURA_WRITE = '98ed0002-a541-11e4-b6a0-0002a5d5c51b';
export const OURA_NOTIFY = '98ed0003-a541-11e4-b6a0-0002a5d5c51b';

const CONNECT_TIMEOUT_MS = 30_000;

type Listener = (frame: Uint8Array) => void;

export interface LogEntry {
  t: number;
  dir: 'tx' | 'rx' | 'info';
  text: string;
}

const LOG_LIMIT = 400;
const logEntries: LogEntry[] = [];
const logListeners = new Set<() => void>();

export const protocolLog = {
  entries: (): readonly LogEntry[] => logEntries,
  push(dir: LogEntry['dir'], text: string) {
    logEntries.push({ t: Date.now(), dir, text });
    if (logEntries.length > LOG_LIMIT) logEntries.splice(0, logEntries.length - LOG_LIMIT);
    logListeners.forEach((fn) => fn());
  },
  subscribe(fn: () => void) {
    logListeners.add(fn);
    return () => logListeners.delete(fn);
  },
};

const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

/** Hex for the log, with key-bearing requests (SetAuthKey, Authenticate) redacted. */
function redactedHex(data: Uint8Array): string {
  if (data[0] === 0x24) return '24 <auth key redacted>';
  if (data[0] === 0x2f && data[2] === 0x2d) return '2f 11 2d <auth response redacted>';
  return toHex(data);
}

/** False when the OS reports no usable Bluetooth radio (off, or no permission). */
export async function bluetoothAvailable(): Promise<boolean | undefined> {
  try {
    return await navigator.bluetooth?.getAvailability();
  } catch {
    return undefined;
  }
}

/**
 * Turn a Web Bluetooth failure into an actionable message, keeping Chrome's own
 * text since it usually names the real cause (adapter off, permission, cancel).
 */
export function explainBluetoothError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const name = e instanceof DOMException ? e.name : '';
  if (name === 'NotFoundError' && /cancel/i.test(msg)) {
    return 'The Bluetooth picker was closed without choosing a device. If your ring was not listed, see "Ring not showing up?" below.';
  }
  if (name === 'NotFoundError' && /adapter/i.test(msg)) {
    return `Chrome says: "${msg}". Turn Bluetooth on (and Location, on older Android), then try again.`;
  }
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return `Chrome says: "${msg}". Allow Chrome the "Nearby devices" permission: Android Settings → Apps → Chrome → Permissions → Nearby devices → Allow.`;
  }
  if (name === 'NetworkError') {
    return `Chrome says: "${msg}". The ring dropped the connection. Remove it from the charger, put it back, wait a few seconds and retry. If Android shows a pairing request, accept it.`;
  }
  if (name === 'NotSupportedError' && /GATT/i.test(msg)) {
    return `Chrome says: "${msg}". The ring itself accepts this connection, so Android is usually holding an old Bluetooth bond from the Oura app. In Android Settings → Connected devices, forget every "Oura" entry (including under "Previously connected devices"), turn Bluetooth off and on, lift the ring off the charger and back, then retry.`;
  }
  return name ? `${name}: ${msg}` : msg;
}

export function bluetoothSupport(): string | null {
  if (!window.isSecureContext) {
    return 'Web Bluetooth needs a secure context: open this app over HTTPS or http://localhost.';
  }
  const isBrave = 'brave' in navigator;
  const bt = (navigator as Navigator & { bluetooth?: Bluetooth }).bluetooth;
  if (isBrave && (!bt || /Android/i.test(navigator.userAgent))) {
    return 'Brave does not support Bluetooth for websites on Android. Open this page in Google Chrome to connect to your ring.';
  }
  if (!bt || typeof bt.requestDevice !== 'function') {
    return 'This browser has no Web Bluetooth. Open this page in Google Chrome (Android) or desktop Chrome/Edge.';
  }
  return null;
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}

export class RingLink implements Transport {
  private listeners = new Set<Listener>();
  private writeQueue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private onDisconnected = () => {
    this.closed = true;
    protocolLog.push('info', 'ring disconnected');
    this.disconnectListeners.forEach((fn) => fn());
  };
  readonly disconnectListeners = new Set<() => void>();

  private constructor(
    readonly device: BluetoothDevice,
    private writeChar: BluetoothRemoteGATTCharacteristic,
  ) {}

  /** Show the browser's device picker filtered to Oura rings. Needs a user gesture. */
  static async pick(showAll = false): Promise<BluetoothDevice> {
    protocolLog.push('info', `opening Bluetooth picker (${showAll ? 'all devices' : 'Oura filter'})`);
    return navigator.bluetooth.requestDevice(
      showAll
        ? { acceptAllDevices: true, optionalServices: [OURA_SERVICE] }
        : {
            // A reset Ring 4 advertises as "Oura <serial digits>" with the service
            // UUID and Oura's manufacturer ID (0x02b2); any one is enough to match.
            filters: [{ services: [OURA_SERVICE] }, { namePrefix: 'Oura' }, { manufacturerData: [{ companyIdentifier: 0x02b2 }] }],
            optionalServices: [OURA_SERVICE],
          },
    );
  }

  /**
   * Find a previously permitted ring without a picker, where the browser supports
   * `getDevices()` (Chrome's persistent Bluetooth permissions).
   */
  static async known(deviceId: string | undefined): Promise<BluetoothDevice | null> {
    const bt = navigator.bluetooth as Bluetooth & { getDevices?: () => Promise<BluetoothDevice[]> };
    if (!deviceId || !bt.getDevices) return null;
    try {
      return (await bt.getDevices()).find((d) => d.id === deviceId) ?? null;
    } catch {
      return null;
    }
  }

  static async open(device: BluetoothDevice): Promise<RingLink> {
    if (!device.gatt) throw new Error('device has no GATT server');
    const stage = async <T,>(what: string, p: Promise<T>): Promise<T> => {
      protocolLog.push('info', `${what}…`);
      try {
        return await p;
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        protocolLog.push('info', `${what} failed: ${err.name}: ${err.message}`);
        // Keep the DOMException name for explainBluetoothError, but say which step failed.
        const wrapped = new DOMException(`${err.message} (while: ${what})`, err.name);
        throw wrapped;
      }
    };
    const gatt = await stage(
      'connecting',
      withTimeout(device.gatt.connect(), CONNECT_TIMEOUT_MS, 'Bluetooth connect (is another app holding the ring? put it on the charger and retry)'),
    );
    const service = await stage('opening the Oura service', gatt.getPrimaryService(OURA_SERVICE));
    const chars = await stage('listing characteristics', service.getCharacteristics());
    const writeChar = chars.find((c) => c.uuid === OURA_WRITE);
    if (!writeChar) throw new Error(`write characteristic ${OURA_WRITE} not found`);

    const link = new RingLink(device, writeChar);
    // Every ring response arrives on 98ed0003 (verified on a reset Ring 4), so only it
    // is required. The extra channels (0004/0005/0006) are subscribed best-effort.
    const ordered = [...chars].sort((a, b) => Number(b.uuid === OURA_NOTIFY) - Number(a.uuid === OURA_NOTIFY));
    for (const c of ordered) {
      if (!c.properties.notify && !c.properties.indicate) continue;
      c.addEventListener('characteristicvaluechanged', (ev) => {
        const value = (ev.target as BluetoothRemoteGATTCharacteristic).value;
        if (!value) return;
        const frame = new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
        protocolLog.push('rx', toHex(frame));
        link.listeners.forEach((fn) => fn(frame));
      });
      const short = c.uuid.slice(4, 8);
      if (c.uuid === OURA_NOTIFY) {
        await stage(`subscribing to channel ${short}`, c.startNotifications());
      } else {
        await c.startNotifications().then(
          () => protocolLog.push('info', `subscribed to optional channel ${short}`),
          (e) => protocolLog.push('info', `optional channel ${short} unavailable: ${e?.name}: ${e?.message}`),
        );
      }
    }
    device.addEventListener('gattserverdisconnected', link.onDisconnected);
    return link;
  }

  get connected(): boolean {
    return !this.closed && !!this.device.gatt?.connected;
  }

  write(data: Uint8Array): Promise<void> {
    const run = this.writeQueue.then(async () => {
      if (!this.connected) throw new Error('ring disconnected');
      protocolLog.push('tx', redactedHex(data));
      await this.writeChar.writeValueWithResponse(data as BufferSource);
    });
    this.writeQueue = run.catch(() => undefined);
    return run;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  disconnect(): void {
    this.device.removeEventListener('gattserverdisconnected', this.onDisconnected);
    this.closed = true;
    this.device.gatt?.disconnect();
    this.disconnectListeners.forEach((fn) => fn());
  }
}

export interface Transport {
  write(data: Uint8Array): Promise<void>;
  subscribe(fn: Listener): () => void;
  readonly disconnectListeners: Set<() => void>;
}

/**
 * Write `request` and collect notification frames until one satisfies
 * `isTerminal` or the link stays quiet for `quietMs` (port of `transact_until`).
 */
export function transactUntil(
  link: Transport,
  request: Uint8Array,
  quietMs: number,
  isTerminal: (frame: Uint8Array) => boolean,
): Promise<Uint8Array[]> {
  return new Promise((resolve, reject) => {
    const frames: Uint8Array[] = [];
    let timer: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      unsubscribe();
      link.disconnectListeners.delete(finish);
    };
    const finish = () => {
      if (done) return;
      cleanup();
      resolve(frames);
    };
    const arm = () => {
      if (done) return;
      clearTimeout(timer);
      timer = setTimeout(finish, quietMs);
    };
    const unsubscribe = link.subscribe((frame) => {
      if (done) return;
      frames.push(frame);
      if (isTerminal(frame)) finish();
      else arm();
    });
    link.disconnectListeners.add(finish);
    link.write(request).then(arm, (e) => {
      if (done) return;
      cleanup();
      reject(e);
    });
  });
}
