import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphResponse } from '../src/api/types';
import { clearGraphCache, loadGraphCache, saveGraphCache } from '../src/api/graphCache';

// jsdom ships no IndexedDB and the project adds no fake-indexeddb
// dependency (plan 016 forbids new deps), so these tests drive the wrapper
// through a minimal in-memory IDBFactory fake implementing exactly the
// surface graphCache.ts uses: open/onupgradeneeded, transaction,
// objectStore get/put/delete/clear, and close.

type Handler = ((event?: unknown) => void) | null;

class FakeRequest<T = unknown> {
  result = undefined as T;
  error: unknown = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
  succeed(value: T): void {
    this.result = value;
    queueMicrotask(() => this.onsuccess?.({ target: this }));
  }
  fail(error: unknown): void {
    this.error = error;
    queueMicrotask(() => this.onerror?.({ target: this }));
  }
}

class FakeObjectStore {
  constructor(private readonly data: Map<unknown, unknown>) {}
  get(key: unknown): IDBRequest<unknown> {
    const request = new FakeRequest<unknown>();
    request.succeed(this.data.has(key) ? this.data.get(key) : undefined);
    return request as unknown as IDBRequest<unknown>;
  }
  put(value: unknown, key: unknown): IDBRequest<unknown> {
    const request = new FakeRequest<unknown>();
    this.data.set(key, value);
    request.succeed(key);
    return request as unknown as IDBRequest<unknown>;
  }
  delete(key: unknown): IDBRequest<undefined> {
    const request = new FakeRequest<undefined>();
    this.data.delete(key);
    request.succeed(undefined);
    return request as unknown as IDBRequest<undefined>;
  }
  clear(): IDBRequest<undefined> {
    const request = new FakeRequest<undefined>();
    this.data.clear();
    request.succeed(undefined);
    return request as unknown as IDBRequest<undefined>;
  }
}

class FakeDatabase {
  readonly stores = new Map<string, Map<unknown, unknown>>();
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };
  createObjectStore(name: string): FakeObjectStore {
    let data = this.stores.get(name);
    if (!data) {
      data = new Map();
      this.stores.set(name, data);
    }
    return new FakeObjectStore(data);
  }
  transaction(name: string): { objectStore: () => FakeObjectStore } {
    const data = this.stores.get(name);
    if (!data) throw new Error(`no such store: ${name}`);
    return { objectStore: () => new FakeObjectStore(data) };
  }
  close(): void {}
}

class FakeFactory {
  readonly databases = new Map<string, FakeDatabase>();
  failOpen: unknown = null;
  open(name: string): IDBOpenDBRequest {
    const request = new FakeRequest<IDBDatabase>();
    queueMicrotask(() => {
      if (this.failOpen !== null) {
        request.fail(this.failOpen);
        return;
      }
      let db = this.databases.get(name);
      if (!db) {
        db = new FakeDatabase();
        this.databases.set(name, db);
        request.result = db as unknown as IDBDatabase;
        request.onupgradeneeded?.({ target: request });
      } else {
        request.result = db as unknown as IDBDatabase;
      }
      queueMicrotask(() => request.onsuccess?.({ target: request }));
    });
    return request as unknown as IDBOpenDBRequest;
  }
  storeData(dbName: string, storeName: string): Map<unknown, unknown> | undefined {
    return this.databases.get(dbName)?.stores.get(storeName);
  }
}

const bodyFixture: GraphResponse = {
  revision: 3,
  truncated: false,
  nodes: [{ id: 'a', path: 'a.md', title: 'Alpha', kind: 'note', tags: [], createdAt: 1 }],
  edges: [],
};

let fake: FakeFactory;
let idb: IDBFactory;

beforeEach(() => {
  fake = new FakeFactory();
  idb = fake as unknown as IDBFactory;
  // Force the "no IndexedDB" path hermetically — jsdom provides none, but
  // never depend on the environment for the degradation assertions.
  vi.stubGlobal('indexedDB', undefined);
});

describe('graphCache IndexedDB wrapper', () => {
  it('round-trips etag + body per vault', async () => {
    expect(await loadGraphCache('vault-1', idb)).toBeNull();
    await saveGraphCache('vault-1', { etag: 'W/"3"', body: bodyFixture }, idb);
    const cached = await loadGraphCache('vault-1', idb);
    expect(cached).toMatchObject({ etag: 'W/"3"', body: bodyFixture });
    expect(typeof cached?.savedAt).toBe('number');
    // Vaults are isolated rows, never appended.
    expect(await loadGraphCache('vault-2', idb)).toBeNull();
  });

  it('overwrites (never appends) on re-save', async () => {
    await saveGraphCache('vault-1', { etag: 'W/"3"', body: bodyFixture }, idb);
    const updated: GraphResponse = { ...bodyFixture, revision: 4 };
    await saveGraphCache('vault-1', { etag: 'W/"4"', body: updated }, idb);
    expect(await loadGraphCache('vault-1', idb)).toMatchObject({
      etag: 'W/"4"',
      body: updated,
    });
    expect(fake.storeData('tephra-graph', 'graphs')?.size).toBe(1);
  });

  it('clears one vault or the whole store', async () => {
    await saveGraphCache('vault-1', { etag: 'e1', body: bodyFixture }, idb);
    await saveGraphCache('vault-2', { etag: 'e2', body: bodyFixture }, idb);
    await clearGraphCache('vault-1', idb);
    expect(await loadGraphCache('vault-1', idb)).toBeNull();
    expect(await loadGraphCache('vault-2', idb)).not.toBeNull();
    await clearGraphCache(undefined, idb);
    expect(await loadGraphCache('vault-2', idb)).toBeNull();
  });

  it('treats corrupt rows as a miss', async () => {
    await saveGraphCache('vault-1', { etag: 'e1', body: bodyFixture }, idb);
    fake.storeData('tephra-graph', 'graphs')?.set('vault-1', { nope: true });
    expect(await loadGraphCache('vault-1', idb)).toBeNull();
  });

  it('degrades to network-only when IndexedDB is missing', async () => {
    expect(await loadGraphCache('vault-1')).toBeNull();
    await expect(
      saveGraphCache('vault-1', { etag: 'e', body: bodyFixture }),
    ).resolves.toBeUndefined();
    await expect(clearGraphCache('vault-1')).resolves.toBeUndefined();
    await expect(clearGraphCache()).resolves.toBeUndefined();
  });

  it('never rejects on open/quota failures', async () => {
    fake.failOpen = new Error('denied');
    expect(await loadGraphCache('vault-1', idb)).toBeNull();
    await expect(
      saveGraphCache('vault-1', { etag: 'e', body: bodyFixture }, idb),
    ).resolves.toBeUndefined();
    await expect(clearGraphCache('vault-1', idb)).resolves.toBeUndefined();
  });

  it('never rejects when open() itself throws (privacy mode)', async () => {
    const throwing = {
      open(): IDBOpenDBRequest {
        throw new Error('blocked');
      },
    } as unknown as IDBFactory;
    expect(await loadGraphCache('vault-1', throwing)).toBeNull();
    await expect(
      saveGraphCache('vault-1', { etag: 'e', body: bodyFixture }, throwing),
    ).resolves.toBeUndefined();
    await expect(clearGraphCache('vault-1', throwing)).resolves.toBeUndefined();
  });
});
