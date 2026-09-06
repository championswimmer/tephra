import { describe, expect, it } from 'vitest';
import type { Database, Repositories, TransactionRepositories } from '@tephra/database-core';
import type { BlobStore } from '@tephra/blob-store-core';
import {
  hashManifest,
  MINIMUM_PLUGIN_VERSION,
  PROTOCOL_VERSION,
  sha256Hex,
  type SyncManifestEntry,
} from '@tephra/protocol';
import type { ApiToken, BlobMetadata, CurrentVaultFile, Device, FileVersion, Session, User, Vault, VaultRevision } from '@tephra/vault-model';
import { createApp } from '../src/app.js';

class MemoryBlobStore implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  async has(hash: string): Promise<boolean> { return this.values.has(hash); }
  async put(input: { hash: string; bytes: ReadableStream<Uint8Array> | Uint8Array }): Promise<void> {
    if (!(input.bytes instanceof Uint8Array)) throw new Error('Test expects bytes.');
    this.values.set(input.hash, input.bytes);
  }
  async get(hash: string) {
    const value = this.values.get(hash);
    return value ? { bytes: new Blob([Uint8Array.from(value).buffer]).stream(), size: value.byteLength } : null;
  }
  async delete(hash: string): Promise<void> { this.values.delete(hash); }
}

class MemoryDatabase implements Database {
  readonly state = {
    users: new Map<string, User>(), sessions: new Map<string, Session>(), vaults: new Map<string, Vault>(),
    tokens: new Map<string, ApiToken>(), devices: new Map<string, Device>(), blobs: new Map<string, BlobMetadata>(), files: new Map<string, CurrentVaultFile>(),
    revisions: [] as VaultRevision[], versions: [] as FileVersion[],
  };
  users = {
    count: async () => this.state.users.size,
    findById: async (id: string) => this.state.users.get(id) ?? null,
    findByEmail: async (email: string) => [...this.state.users.values()].find((item) => item.email === email) ?? null,
    insert: async (item: User) => { this.state.users.set(item.id, item); },
    update: async (item: User) => { this.state.users.set(item.id, item); },
  };
  sessions = {
    findById: async (id: string) => this.state.sessions.get(id) ?? null,
    insert: async (item: Session) => { this.state.sessions.set(item.id, item); },
    delete: async (id: string) => { this.state.sessions.delete(id); },
    deleteExpired: async (now: number) => { let count = 0; for (const item of this.state.sessions.values()) if (item.expiresAt <= now) { this.state.sessions.delete(item.id); count += 1; } return count; },
  };
  vaults = {
    findById: async (id: string) => this.state.vaults.get(id) ?? null,
    listByOwner: async (id: string) => [...this.state.vaults.values()].filter((item) => item.ownerUserId === id),
    insert: async (item: Vault) => { this.state.vaults.set(item.id, item); },
    update: async (item: Vault) => { this.state.vaults.set(item.id, item); },
    delete: async (id: string) => { this.state.vaults.delete(id); },
  };
  devices = {
    findById: async (id: string) => this.state.devices.get(id) ?? null,
    listByUser: async (id: string) => [...this.state.devices.values()].filter((item) => item.userId === id),
    insert: async (item: Device) => { this.state.devices.set(item.id, item); },
    update: async (item: Device) => { this.state.devices.set(item.id, item); },
  };
  apiTokens = {
    findById: async (id: string) => this.state.tokens.get(id) ?? null,
    findByTokenHash: async (hash: string) => [...this.state.tokens.values()].find((item) => item.tokenHash === hash) ?? null,
    listByVault: async (id: string) => [...this.state.tokens.values()].filter((item) => item.vaultId === id),
    insert: async (item: ApiToken) => { this.state.tokens.set(item.id, item); },
    update: async (item: ApiToken) => { this.state.tokens.set(item.id, item); },
    delete: async (id: string) => { this.state.tokens.delete(id); },
  };
  blobs = {
    findByHash: async (hash: string) => this.state.blobs.get(hash) ?? null,
    findByHashes: async (hashes: readonly string[]) => hashes.flatMap((hash) => { const item = this.state.blobs.get(hash); return item ? [item] : []; }),
    findUnreferencedOlderThan: async (cutoff: number, limit: number) => {
      if (!Number.isSafeInteger(limit) || limit <= 0) return [];
      const referenced = new Set<string>();
      for (const file of this.state.files.values()) referenced.add(file.blobHash);
      for (const version of this.state.versions) if (version.blobHash !== null) referenced.add(version.blobHash);
      return [...this.state.blobs.values()]
        .filter((item) => item.createdAt < cutoff && !referenced.has(item.hash))
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, limit);
    },
    insert: async (item: BlobMetadata) => { this.state.blobs.set(item.hash, item); },
    delete: async (hash: string) => { this.state.blobs.delete(hash); },
  };
  vaultFiles = {
    findById: async (id: string) => this.state.files.get(id) ?? null,
    findByPath: async (vaultId: string, path: string) => [...this.state.files.values()].find((item) => item.vaultId === vaultId && item.path === path) ?? null,
    listByVault: async (id: string) => [...this.state.files.values()].filter((item) => item.vaultId === id),
    upsert: async (item: CurrentVaultFile) => { this.state.files.set(item.fileId, item); },
    delete: async (id: string) => { this.state.files.delete(id); },
  };
  vaultRevisions = {
    find: async (id: string, revision: number) => this.state.revisions.find((item) => item.vaultId === id && item.revision === revision) ?? null,
    findLatest: async (id: string) => this.state.revisions.filter((item) => item.vaultId === id).at(-1) ?? null,
    findByManifestHash: async (id: string, hash: string) => this.state.revisions.find((item) => item.vaultId === id && item.manifestHash === hash) ?? null,
    list: async (id: string) => this.state.revisions.filter((item) => item.vaultId === id),
    insert: async (item: VaultRevision) => { this.state.revisions.push(item); },
  };
  fileVersions = {
    listByRevision: async (id: string, revision: number) => this.state.versions.filter((item) => item.vaultId === id && item.revision === revision),
    listByFile: async (id: string, fileId: string) => this.state.versions.filter((item) => item.vaultId === id && item.fileId === fileId),
    insertMany: async (items: readonly FileVersion[]) => { this.state.versions.push(...items); },
  };
  noteIndex = {
    findMetadata: async () => null, listMetadata: async () => [], upsertMetadata: async () => undefined,
    deleteMetadata: async () => undefined, listLinksBySource: async () => [], listLinksByTarget: async () => [],
    listLinks: async () => [], replaceLinksForSource: async () => undefined, getState: async () => null, setState: async () => undefined,
  };
  async transaction<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T> {
    const snapshot = structuredClone(this.state);
    try { return await operation({ ...this.repositories(), lockVault: async () => undefined }); }
    catch (error) { Object.assign(this.state, snapshot); throw error; }
  }
  private repositories(): Repositories {
    return { users: this.users, sessions: this.sessions, vaults: this.vaults, devices: this.devices, apiTokens: this.apiTokens, blobs: this.blobs, vaultFiles: this.vaultFiles, vaultRevisions: this.vaultRevisions, fileVersions: this.fileVersions, noteIndex: this.noteIndex };
  }
}

function fixture() {
  const database = new MemoryDatabase();
  const blobStore = new MemoryBlobStore();
  let nextId = 0;
  const app = createApp({ database, blobStore, clock: { now: () => 1_700_000_000_000 }, ids: { generate: () => `id-${++nextId}` }, passwordHasher: { hash: async (password) => `hash:${password}`, verify: async (password, hash) => hash === `hash:${password}` }, bootstrapToken: 'bootstrap-secret', secureCookies: false });
  return { app, database, blobStore };
}

async function setup() {
  const value = fixture();
  const bootstrap = await value.app.request('/api/v1/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'bootstrap-secret', email: 'owner@example.com', password: 'password-123' }) });
  expect(bootstrap.status).toBe(201);
  const second = await value.app.request('/api/v1/auth/bootstrap', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: 'bootstrap-secret', email: 'other@example.com', password: 'password-123' }) });
  expect(second.status).toBe(409);
  const login = await value.app.request('/api/v1/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.com', password: 'password-123' }) });
  const loginBody = await login.json() as { csrfToken: string };
  const session = /tephra_session=([^;,]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
  const browserHeaders = { cookie: `tephra_session=${session}; tephra_csrf=${loginBody.csrfToken}`, 'x-tephra-csrf': loginBody.csrfToken, 'content-type': 'application/json' };
  const vaultResponse = await value.app.request('/api/v1/vaults', { method: 'POST', headers: browserHeaders, body: JSON.stringify({ name: 'Test Vault' }) });
  const { vault } = await vaultResponse.json() as { vault: Vault };
  const tokenResponse = await value.app.request(`/api/v1/vaults/${vault.id}/tokens`, { method: 'POST', headers: browserHeaders, body: JSON.stringify({ name: 'Plugin' }) });
  const { value: token } = await tokenResponse.json() as { value: string };
  return { ...value, vault, token, browserHeaders };
}

describe('Tephra API', () => {
  it('bootstraps once, authenticates, and keeps tokens vault-scoped', async () => {
    const { app, token, browserHeaders } = await setup();
    const other = await app.request('/api/v1/vaults', { method: 'POST', headers: browserHeaders, body: JSON.stringify({ name: 'Other' }) });
    const { vault } = await other.json() as { vault: Vault };
    const denied = await app.request(`/api/v1/vaults/${vault.id}/files`, { headers: { authorization: `Bearer ${token}` } });
    expect(denied.status).toBe(403);
  });

  it('rejects bad uploads and rolls back missing-blob commits', async () => {
    const { app, token, vault, database } = await setup();
    const bytes = new TextEncoder().encode('hello');
    const hash = await sha256Hex(bytes);
    const bad = await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-tephra-blob-size': '5' }, body: 'wrong' });
    expect(bad.status).toBe(400);
    expect(database.state.blobs.size).toBe(0);
    const files: SyncManifestEntry[] = [{ fileId: 'file-1', path: 'Note.md', hash, size: 5, mtime: 1, kind: 'markdown' }];
    const commit = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'device-1', manifestHash: await hashManifest(files), files }) });
    expect(commit.status).toBe(409);
    expect(database.state.revisions).toHaveLength(0);
    expect(database.state.vaults.get(vault.id)?.latestRevision).toBe(0);
  });

  it('registers the syncing device on commit', async () => {
    const { app, token, vault, database } = await setup();
    const bytes = new TextEncoder().encode('# Device');
    const hash = await sha256Hex(bytes);
    await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-tephra-blob-size': String(bytes.byteLength), 'content-type': 'text/markdown' }, body: bytes });
    const files: SyncManifestEntry[] = [{ fileId: 'file-1', path: 'Note.md', hash, size: bytes.byteLength, mtime: 1, kind: 'markdown' }];
    const commit = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ deviceId: 'field-device', manifestHash: await hashManifest(files), files }) });
    expect(commit.status).toBe(200);
    expect(database.state.devices.get('field-device')).toMatchObject({ userId: vault.ownerUserId, lastSeenAt: 1_700_000_000_000 });
  });

  it('commits once, serves reads, and is idempotent by manifest hash', async () => {
    const { app, token, vault, database } = await setup();
    const bytes = new TextEncoder().encode('# Hello');
    const hash = await sha256Hex(bytes);
    const upload = await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-tephra-blob-size': String(bytes.byteLength), 'content-type': 'text/markdown' }, body: bytes });
    expect(upload.status).toBe(200);
    const files: SyncManifestEntry[] = [{ fileId: 'file-1', path: 'Note.md', hash, size: bytes.byteLength, mtime: 1, kind: 'markdown', mimeType: 'text/markdown' }];
    const body = JSON.stringify({ deviceId: 'device-1', manifestHash: await hashManifest(files), files });
    const first = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    expect(await first.json()).toEqual({ status: 'committed', revision: 1, protocolVersion: PROTOCOL_VERSION, minimumPluginVersion: MINIMUM_PLUGIN_VERSION });
    const second = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body });
    expect(await second.json()).toEqual({ status: 'up-to-date', revision: 1, protocolVersion: PROTOCOL_VERSION, minimumPluginVersion: MINIMUM_PLUGIN_VERSION });
    expect(database.state.revisions).toHaveLength(1);
    const listing = await app.request(`/api/v1/vaults/${vault.id}/files`, { headers: { authorization: `Bearer ${token}` } });
    expect((await listing.json() as { revision: number }).revision).toBe(1);
    const raw = await app.request(`/api/v1/vaults/${vault.id}/files/file-1/raw`, { headers: { authorization: `Bearer ${token}` } });
    expect(await raw.text()).toBe('# Hello');
  });

  it('advertises protocol versions and tolerates client version headers', async () => {
    const { app, token, vault } = await setup();
    const bytes = new TextEncoder().encode('# Versioned');
    const hash = await sha256Hex(bytes);
    const files: SyncManifestEntry[] = [{ fileId: 'file-1', path: 'Note.md', hash, size: bytes.byteLength, mtime: 1, kind: 'markdown' }];
    const body = JSON.stringify({ deviceId: 'device-1', manifestHash: await hashManifest(files), files });
    const versionHeaders = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-tephra-plugin-version': '0.1.0',
      'x-tephra-protocol-version': '1',
    };
    const plan = await app.request(`/api/v1/vaults/${vault.id}/sync/plan`, { method: 'POST', headers: versionHeaders, body });
    expect(plan.status).toBe(200);
    expect(await plan.json()).toEqual({
      status: 'upload-required',
      latestRevision: 0,
      missingBlobs: [{ hash, size: bytes.byteLength }],
      protocolVersion: PROTOCOL_VERSION,
      minimumPluginVersion: MINIMUM_PLUGIN_VERSION,
    });
    await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'x-tephra-blob-size': String(bytes.byteLength), 'content-type': 'text/markdown' }, body: bytes });
    const commit = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, { method: 'POST', headers: versionHeaders, body });
    expect(await commit.json()).toEqual({
      status: 'committed',
      revision: 1,
      protocolVersion: PROTOCOL_VERSION,
      minimumPluginVersion: MINIMUM_PLUGIN_VERSION,
    });
  });
});
