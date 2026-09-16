import { expect } from 'vitest';
import type {
  Database,
  GraphCacheEntry,
  Repositories,
  TransactionRepositories,
} from '@tephra/database-core';
import type { BlobStore } from '@tephra/blob-store-core';
import type {
  ApiToken,
  BlobMetadata,
  CurrentVaultFile,
  Device,
  FileVersion,
  Session,
  User,
  Vault,
  VaultRevision,
} from '@tephra/vault-model';
import { createApp, type IndexService } from '../src/app.js';

export class MemoryBlobStore implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  async has(hash: string): Promise<boolean> {
    return this.values.has(hash);
  }
  async put(input: {
    hash: string;
    bytes: ReadableStream<Uint8Array> | Uint8Array;
  }): Promise<void> {
    if (!(input.bytes instanceof Uint8Array)) throw new Error('Test expects bytes.');
    this.values.set(input.hash, input.bytes);
  }
  async get(hash: string) {
    const value = this.values.get(hash);
    return value
      ? { bytes: new Blob([Uint8Array.from(value).buffer]).stream(), size: value.byteLength }
      : null;
  }
  async delete(hash: string): Promise<void> {
    this.values.delete(hash);
  }
}

export class MemoryDatabase implements Database {
  readonly state = {
    users: new Map<string, User>(),
    sessions: new Map<string, Session>(),
    vaults: new Map<string, Vault>(),
    tokens: new Map<string, ApiToken>(),
    devices: new Map<string, Device>(),
    blobs: new Map<string, BlobMetadata>(),
    files: new Map<string, CurrentVaultFile>(),
    revisions: [] as VaultRevision[],
    versions: [] as FileVersion[],
    graphCacheEntries: new Map<string, GraphCacheEntry>(),
  };
  users = {
    count: async () => this.state.users.size,
    findById: async (id: string) => this.state.users.get(id) ?? null,
    findByEmail: async (email: string) =>
      [...this.state.users.values()].find((item) => item.email === email) ?? null,
    insert: async (item: User) => {
      this.state.users.set(item.id, item);
    },
    update: async (item: User) => {
      this.state.users.set(item.id, item);
    },
  };
  sessions = {
    findById: async (id: string) => this.state.sessions.get(id) ?? null,
    insert: async (item: Session) => {
      this.state.sessions.set(item.id, item);
    },
    delete: async (id: string) => {
      this.state.sessions.delete(id);
    },
    deleteExpired: async (now: number) => {
      let count = 0;
      for (const item of this.state.sessions.values())
        if (item.expiresAt <= now) {
          this.state.sessions.delete(item.id);
          count += 1;
        }
      return count;
    },
  };
  vaults = {
    findById: async (id: string) => this.state.vaults.get(id) ?? null,
    findByName: async (name: string) =>
      [...this.state.vaults.values()].find((item) => item.name === name) ?? null,
    listByOwner: async (id: string) =>
      [...this.state.vaults.values()].filter((item) => item.ownerUserId === id),
    insert: async (item: Vault) => {
      if ([...this.state.vaults.values()].some((existing) => existing.name === item.name))
        throw Object.assign(new Error('UNIQUE constraint failed: vaults.name'), {
          code: 'SQLITE_CONSTRAINT_UNIQUE',
        });
      this.state.vaults.set(item.id, item);
    },
    update: async (item: Vault) => {
      this.state.vaults.set(item.id, item);
    },
    delete: async (id: string) => {
      this.state.vaults.delete(id);
      for (const [tokenId, token] of this.state.tokens) {
        if (token.vaultId === id) this.state.tokens.delete(tokenId);
      }
      for (const [fileKey, file] of this.state.files) {
        if (file.vaultId === id) this.state.files.delete(fileKey);
      }
      this.state.revisions = this.state.revisions.filter((item) => item.vaultId !== id);
      this.state.versions = this.state.versions.filter((item) => item.vaultId !== id);
    },
  };
  devices = {
    findById: async (id: string) => this.state.devices.get(id) ?? null,
    listByUser: async (id: string) =>
      [...this.state.devices.values()].filter((item) => item.userId === id),
    insert: async (item: Device) => {
      this.state.devices.set(item.id, item);
    },
    update: async (item: Device) => {
      this.state.devices.set(item.id, item);
    },
  };
  apiTokens = {
    findById: async (id: string) => this.state.tokens.get(id) ?? null,
    findByTokenHash: async (hash: string) =>
      [...this.state.tokens.values()].find((item) => item.tokenHash === hash) ?? null,
    listByVault: async (id: string) =>
      [...this.state.tokens.values()].filter((item) => item.vaultId === id),
    insert: async (item: ApiToken) => {
      this.state.tokens.set(item.id, item);
    },
    update: async (item: ApiToken) => {
      this.state.tokens.set(item.id, item);
    },
    delete: async (id: string) => {
      this.state.tokens.delete(id);
    },
  };
  blobs = {
    findByHash: async (hash: string) => this.state.blobs.get(hash) ?? null,
    findByHashes: async (hashes: readonly string[]) =>
      hashes.flatMap((hash) => {
        const item = this.state.blobs.get(hash);
        return item ? [item] : [];
      }),
    findUnreferencedOlderThan: async (cutoff: number, limit: number) => {
      if (!Number.isSafeInteger(limit) || limit <= 0) return [];
      const referenced = new Set<string>();
      for (const file of this.state.files.values()) referenced.add(file.blobHash);
      for (const version of this.state.versions)
        if (version.blobHash !== null) referenced.add(version.blobHash);
      return [...this.state.blobs.values()]
        .filter((item) => item.createdAt < cutoff && !referenced.has(item.hash))
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, limit);
    },
    insert: async (item: BlobMetadata) => {
      this.state.blobs.set(item.hash, item);
    },
    delete: async (hash: string) => {
      this.state.blobs.delete(hash);
    },
  };
  vaultFiles = {
    findById: async (vaultId: string, fileId: string) =>
      [...this.state.files.values()].find(
        (item) => item.vaultId === vaultId && item.fileId === fileId,
      ) ?? null,
    findByPath: async (vaultId: string, path: string) =>
      [...this.state.files.values()].find(
        (item) => item.vaultId === vaultId && item.path === path,
      ) ?? null,
    findByPathFold: async (vaultId: string, pathFold: string) =>
      [...this.state.files.values()].filter(
        (item) => item.vaultId === vaultId && item.path.normalize('NFC').toLowerCase() === pathFold,
      ),
    listByVault: async (id: string) =>
      [...this.state.files.values()].filter((item) => item.vaultId === id),
    upsert: async (item: CurrentVaultFile) => {
      this.state.files.set(`${item.vaultId}\0${item.fileId}`, item);
    },
    delete: async (vaultId: string, fileId: string) => {
      this.state.files.delete(`${vaultId}\0${fileId}`);
    },
  };
  vaultRevisions = {
    find: async (id: string, revision: number) =>
      this.state.revisions.find((item) => item.vaultId === id && item.revision === revision) ??
      null,
    findLatest: async (id: string) =>
      this.state.revisions.filter((item) => item.vaultId === id).at(-1) ?? null,
    // Newest-wins: since migration 005 the same manifest hash may appear on
    // several revisions (edit-then-revert), so idempotency checks resolve to
    // the latest instead of the first.
    findByManifestHash: async (id: string, hash: string) =>
      this.state.revisions
        .filter((item) => item.vaultId === id && item.manifestHash === hash)
        .sort((left, right) => right.revision - left.revision)[0] ?? null,
    list: async (id: string) => this.state.revisions.filter((item) => item.vaultId === id),
    insert: async (item: VaultRevision) => {
      this.state.revisions.push(item);
    },
  };
  fileVersions = {
    listByRevision: async (id: string, revision: number) =>
      this.state.versions.filter((item) => item.vaultId === id && item.revision === revision),
    listByFile: async (id: string, fileId: string) =>
      this.state.versions.filter((item) => item.vaultId === id && item.fileId === fileId),
    findLatestByPath: async (id: string, path: string) =>
      this.state.versions
        .filter((item) => item.vaultId === id && item.path === path)
        .sort((a, b) => b.revision - a.revision)[0] ?? null,
    listSince: async (id: string, sinceRevision: number, limit: number) => {
      if (!Number.isSafeInteger(limit) || limit <= 0) return [];
      return this.state.versions
        .filter((item) => item.vaultId === id && item.revision > sinceRevision)
        .sort((a, b) => a.revision - b.revision || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit);
    },
    insertMany: async (items: readonly FileVersion[]) => {
      this.state.versions.push(...items);
    },
  };
  noteIndex = {
    findMetadata: async () => null,
    listMetadata: async () => [],
    upsertMetadata: async () => undefined,
    deleteMetadata: async () => undefined,
    listLinksBySource: async () => [],
    listLinksByTarget: async () => [],
    listLinks: async () => [],
    replaceLinksForSource: async () => undefined,
    getState: async () => null,
    setState: async () => undefined,
  };
  graphCache = {
    find: async (vaultId: string) => this.state.graphCacheEntries.get(vaultId) ?? null,
    upsert: async (entry: GraphCacheEntry) => {
      this.state.graphCacheEntries.set(entry.vaultId, entry);
    },
    deleteByVault: async (vaultId: string) => {
      this.state.graphCacheEntries.delete(vaultId);
    },
  };
  // Per-vault mutexes so concurrent transactions that take lockVault
  // serialize the way SQLite's BEGIN IMMEDIATE does. Locks are released when
  // the transaction settles.
  private readonly vaultLocks = new Map<string, Promise<void>>();
  private async acquireVaultLock(vaultId: string): Promise<() => void> {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.vaultLocks.get(vaultId) ?? Promise.resolve();
    this.vaultLocks.set(vaultId, previous.then(() => gate));
    await previous;
    return release;
  }
  async transaction<T>(
    operation: (repositories: TransactionRepositories) => Promise<T>,
  ): Promise<T> {
    const snapshot = structuredClone(this.state);
    const releases: Array<() => void> = [];
    const lockVault = async (vaultId: string): Promise<void> => {
      releases.push(await this.acquireVaultLock(vaultId));
    };
    try {
      return await operation({ ...this.repositories(), lockVault });
    } catch (error) {
      Object.assign(this.state, snapshot);
      throw error;
    } finally {
      while (releases.length > 0) releases.pop()!();
    }
  }
  private repositories(): Repositories {
    return {
      users: this.users,
      sessions: this.sessions,
      vaults: this.vaults,
      devices: this.devices,
      apiTokens: this.apiTokens,
      blobs: this.blobs,
      vaultFiles: this.vaultFiles,
      vaultRevisions: this.vaultRevisions,
      fileVersions: this.fileVersions,
      noteIndex: this.noteIndex,
      graphCache: this.graphCache,
    };
  }
}

export interface FixtureOptions {
  now?: () => number;
  indexService?: IndexService;
  maxBlobBytes?: number;
}

export function fixture(options: FixtureOptions = {}) {
  const database = new MemoryDatabase();
  const blobStore = new MemoryBlobStore();
  let nextId = 0;
  const app = createApp({
    database,
    blobStore,
    clock: { now: options.now ?? (() => 1_700_000_000_000) },
    ids: { generate: () => `id-${++nextId}` },
    passwordHasher: {
      hash: async (password) => `hash:${password}`,
      verify: async (password, hash) => hash === `hash:${password}`,
    },
    bootstrapToken: 'bootstrap-secret',
    secureCookies: false,
    ...(options.indexService === undefined ? {} : { indexService: options.indexService }),
    ...(options.maxBlobBytes === undefined ? {} : { maxBlobBytes: options.maxBlobBytes }),
  });
  return { app, database, blobStore };
}

export async function setup(options: FixtureOptions = {}) {
  const value = fixture(options);
  const bootstrap = await value.app.request('/api/v1/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: 'bootstrap-secret',
      email: 'owner@example.com',
      password: 'password-123',
    }),
  });
  expect(bootstrap.status).toBe(201);
  const second = await value.app.request('/api/v1/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: 'bootstrap-secret',
      email: 'other@example.com',
      password: 'password-123',
    }),
  });
  expect(second.status).toBe(409);
  const login = await value.app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'password-123' }),
  });
  const loginBody = (await login.json()) as { csrfToken: string };
  const session = /tephra_session=([^;,]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
  const browserHeaders = {
    cookie: `tephra_session=${session}; tephra_csrf=${loginBody.csrfToken}`,
    'x-tephra-csrf': loginBody.csrfToken,
    'content-type': 'application/json',
  };
  const vaultResponse = await value.app.request('/api/v1/vaults', {
    method: 'POST',
    headers: browserHeaders,
    body: JSON.stringify({ name: 'Test Vault' }),
  });
  const { vault } = (await vaultResponse.json()) as { vault: Vault };
  const tokenResponse = await value.app.request(`/api/v1/vaults/${vault.id}/tokens`, {
    method: 'POST',
    headers: browserHeaders,
    body: JSON.stringify({ name: 'Plugin' }),
  });
  const { value: token } = (await tokenResponse.json()) as { value: string };
  return { ...value, vault, token, browserHeaders };
}
