import type { GraphResponse } from './types';

/**
 * Stale-while-revalidate cache for graph payloads (plan 016, Lane B).
 *
 * The server already ETags `GET …/graph`, but `ApiClient` used to keep the
 * ETag/body pair only in a memory `Map` — every page reload paid the full
 * download + parse + `buildGraphModel`. This module persists one
 * `{ etag, body }` row per vault in IndexedDB so a reload can paint the stale
 * payload instantly and revalidate in the background (304 on a hit).
 *
 * Every entry point is total: IndexedDB may be missing (SSR, old browsers),
 * blocked (private mode), or over quota. All of those degrade to
 * network-only — the functions resolve `null` / `undefined` and never reject
 * into the UI.
 */

export interface CachedGraph {
  etag: string;
  body: GraphResponse;
  savedAt: number;
}

export interface SaveGraphInput {
  etag: string;
  body: GraphResponse;
}

const DB_NAME = 'tephra-graph';
const STORE_NAME = 'graphs';
const DB_VERSION = 1;

function factory(): IDBFactory | undefined {
  try {
    return typeof indexedDB === 'undefined' ? undefined : indexedDB;
  } catch {
    return undefined;
  }
}

function openDatabase(dbFactory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = dbFactory.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    request.onblocked = () => reject(new Error('IndexedDB open blocked'));
  });
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function isCachedGraph(value: unknown): value is CachedGraph {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry['etag'] === 'string' &&
    typeof entry['body'] === 'object' &&
    entry['body'] !== null &&
    typeof (entry['body'] as Record<string, unknown>)['revision'] === 'number'
  );
}

/** Read the cached `{ etag, body }` for a vault, or `null` on miss/failure. */
export async function loadGraphCache(
  vaultId: string,
  dbFactory?: IDBFactory,
): Promise<CachedGraph | null> {
  try {
    const idb = dbFactory ?? factory();
    if (!idb) return null;
    const db = await openDatabase(idb);
    try {
      const value = await requestValue(
        db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(vaultId),
      );
      return isCachedGraph(value) ? value : null;
    } finally {
      db.close();
    }
  } catch {
    return null;
  }
}

/** Overwrite the cached `{ etag, body }` for a vault; never rejects. */
export async function saveGraphCache(
  vaultId: string,
  input: SaveGraphInput,
  dbFactory?: IDBFactory,
): Promise<void> {
  try {
    const idb = dbFactory ?? factory();
    if (!idb) return;
    const db = await openDatabase(idb);
    try {
      await requestValue(
        db
          .transaction(STORE_NAME, 'readwrite')
          .objectStore(STORE_NAME)
          .put({ etag: input.etag, body: input.body, savedAt: Date.now() }, vaultId),
      );
    } finally {
      db.close();
    }
  } catch {
    // Quota / privacy-mode / blocked: network-only fallback, ignore.
  }
}

/**
 * Drop the cached row for one vault (or the whole store when `vaultId` is
 * omitted); never rejects.
 */
export async function clearGraphCache(vaultId?: string, dbFactory?: IDBFactory): Promise<void> {
  try {
    const idb = dbFactory ?? factory();
    if (!idb) return;
    const db = await openDatabase(idb);
    try {
      const store = db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME);
      await requestValue(vaultId === undefined ? store.clear() : store.delete(vaultId));
    } finally {
      db.close();
    }
  } catch {
    // Best-effort eviction only; ignore failures.
  }
}
