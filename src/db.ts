/**
 * Local persistence in IndexedDB (the browser counterpart of `oura-store`).
 * Raw event bodies are always kept so newer decoders can re-run over them; the
 * composite primary key makes re-syncing idempotent, like the SQLite UNIQUE index.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { DecodedEvent, DeviceInfo } from './wasm';

export interface RingRecord {
  serial: string;
  keyHex: string;
  deviceId?: string;
  deviceName?: string;
  hardwareId?: string;
  firmware?: DeviceInfo;
  pairedAt: number;
  keyBackedUp?: boolean;
}

export interface StoredEvent {
  serial: string;
  tag: number;
  ts: number;
  body_hex: string;
  name: string;
  decoded: Record<string, unknown> | null;
  captured: number;
}

export interface SyncState {
  serial: string;
  cursor: number;
  lastSyncUnix?: number;
  /** Newest ring timestamp seen at `lastSyncUnix`: a fallback clock anchor. */
  newestTs?: number;
}

export interface Reading {
  id?: number;
  serial: string;
  kind: 'battery' | 'heart_rate_live' | 'heart_rate' | 'spo2';
  value: number;
  captured: number;
}

interface Schema extends DBSchema {
  rings: { key: string; value: RingRecord };
  events: {
    key: [string, number, number, string];
    value: StoredEvent;
    indexes: { by_tag_ts: [string, number, number] };
  };
  sync: { key: string; value: SyncState };
  readings: { key: number; value: Reading; indexes: { by_kind: [string, string, number] } };
  kv: { key: string; value: unknown };
}

let dbp: Promise<IDBPDatabase<Schema>> | null = null;

export function db(): Promise<IDBPDatabase<Schema>> {
  dbp ??= openDB<Schema>('open-ring', 1, {
    upgrade(d) {
      d.createObjectStore('rings', { keyPath: 'serial' });
      const ev = d.createObjectStore('events', { keyPath: ['serial', 'tag', 'ts', 'body_hex'] });
      ev.createIndex('by_tag_ts', ['serial', 'tag', 'ts']);
      d.createObjectStore('sync', { keyPath: 'serial' });
      const r = d.createObjectStore('readings', { keyPath: 'id', autoIncrement: true });
      r.createIndex('by_kind', ['serial', 'kind', 'captured']);
      d.createObjectStore('kv');
    },
  });
  return dbp;
}

const nowUnix = () => Math.floor(Date.now() / 1000);

export async function activeSerial(): Promise<string | undefined> {
  return (await (await db()).get('kv', 'activeSerial')) as string | undefined;
}

export async function activeRing(): Promise<RingRecord | undefined> {
  const serial = await activeSerial();
  return serial ? (await db()).get('rings', serial) : undefined;
}

export async function saveRing(ring: RingRecord): Promise<void> {
  const d = await db();
  const tx = d.transaction(['rings', 'kv'], 'readwrite');
  await tx.objectStore('rings').put(ring);
  await tx.objectStore('kv').put(ring.serial, 'activeSerial');
  await tx.done;
}

export async function syncState(serial: string): Promise<SyncState> {
  return (await (await db()).get('sync', serial)) ?? { serial, cursor: 0 };
}

/** Store one batch and its cursor atomically, so a crash never skips events. */
export async function commitBatch(serial: string, events: DecodedEvent[], cursor: number): Promise<void> {
  const d = await db();
  const tx = d.transaction(['events', 'sync'], 'readwrite');
  const captured = nowUnix();
  const evs = tx.objectStore('events');
  const sync = tx.objectStore('sync');
  let newest = -1;
  for (const e of events) {
    newest = Math.max(newest, e.timestamp);
    evs.put({
      serial,
      tag: e.tag,
      ts: e.timestamp,
      body_hex: e.body_hex,
      name: e.name,
      decoded: e.decoded,
      captured,
    });
  }
  const prev = (await sync.get(serial)) ?? { serial, cursor: 0 };
  await sync.put({
    ...prev,
    cursor,
    lastSyncUnix: captured,
    newestTs: newest >= 0 ? Math.max(newest, prev.newestTs ?? 0) : prev.newestTs,
  });
  await tx.done;
}

export async function resetCursor(serial: string): Promise<void> {
  const d = await db();
  const prev = await syncState(serial);
  await d.put('sync', { ...prev, cursor: 0 });
}

export async function addReading(r: Omit<Reading, 'captured' | 'id'>): Promise<void> {
  await (await db()).add('readings', { ...r, captured: nowUnix() });
}

export async function eventsByTag(serial: string, tags: number[]): Promise<StoredEvent[]> {
  const d = await db();
  const out: StoredEvent[] = [];
  for (const tag of tags) {
    out.push(...(await d.getAllFromIndex('events', 'by_tag_ts', IDBKeyRange.bound([serial, tag, 0], [serial, tag, Infinity]))));
  }
  return out;
}

export async function eventCounts(serial: string): Promise<Map<string, number>> {
  const d = await db();
  const counts = new Map<string, number>();
  let cursor = await d.transaction('events').store.openCursor(IDBKeyRange.bound([serial], [serial, []]));
  while (cursor) {
    counts.set(cursor.value.name, (counts.get(cursor.value.name) ?? 0) + 1);
    cursor = await cursor.continue();
  }
  return counts;
}

export async function latestReading(serial: string, kind: Reading['kind']): Promise<Reading | undefined> {
  const d = await db();
  const c = await d
    .transaction('readings')
    .store.index('by_kind')
    .openCursor(IDBKeyRange.bound([serial, kind, 0], [serial, kind, Infinity]), 'prev');
  return c?.value;
}

export async function getKv<T>(key: string): Promise<T | undefined> {
  return (await (await db()).get('kv', key)) as T | undefined;
}

export async function setKv(key: string, value: unknown): Promise<void> {
  await (await db()).put('kv', value, key);
}

/** Remove a ring and everything stored for it from this device. */
export async function forgetRing(serial: string): Promise<void> {
  const d = await db();
  const tx = d.transaction(['rings', 'sync', 'events', 'readings', 'kv'], 'readwrite');
  await tx.objectStore('rings').delete(serial);
  await tx.objectStore('sync').delete(serial);
  await tx.objectStore('events').delete(IDBKeyRange.bound([serial], [serial, []]));
  let c = await tx.objectStore('readings').openCursor();
  while (c) {
    if (c.value.serial === serial) await c.delete();
    c = await c.continue();
  }
  if ((await tx.objectStore('kv').get('activeSerial')) === serial) await tx.objectStore('kv').delete('activeSerial');
  await tx.done;
}

/** Everything for one ring as JSON (for backups / moving to a native app). */
export async function exportAll(serial: string): Promise<Blob> {
  const d = await db();
  const range = IDBKeyRange.bound([serial], [serial, []]);
  const data = {
    format: 'open-ring-export/1',
    exportedAt: new Date().toISOString(),
    ring: await d.get('rings', serial),
    sync: await d.get('sync', serial),
    events: await d.getAll('events', range),
    readings: (await d.getAll('readings')).filter((r) => r.serial === serial),
    activity: { types: await d.get('kv', 'activityTypes'), tags: await d.get('kv', 'activityTags') },
  };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}
