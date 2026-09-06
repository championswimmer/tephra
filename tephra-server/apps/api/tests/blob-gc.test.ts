import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import { hashOpaqueToken } from '@tephra/auth';
import type { BlobStore } from '@tephra/blob-store-core';
import { openSqliteDatabase, type SqliteDatabase } from '@tephra/database-sqlite';
import { hashManifest, sha256Hex, type SyncManifestEntry } from '@tephra/protocol';

import { createApp } from '../src/app.js';
import { collectUnreferencedBlobs, DEFAULT_BLOB_GC_AGE_MS } from '../src/blob-gc.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_700_000_000_000;

class MemoryBlobStore implements BlobStore {
  readonly values = new Map<string, Uint8Array>();
  async has(hash: string): Promise<boolean> {
    return this.values.has(hash);
  }
  async put(input: Parameters<BlobStore['put']>[0]): Promise<void> {
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

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('blob garbage collection', () => {
  it('collects only old orphans and never deletes referenced blobs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tephra-gc-'));
    directories.push(directory);
    const database = openSqliteDatabase(join(directory, 'tephra.db'));
    databases.push(database);
    const blobStore = new MemoryBlobStore();
    let now = NOW;
    let nextId = 0;
    const app = createApp({
      database,
      blobStore,
      clock: { now: () => now },
      ids: { generate: () => `id-${++nextId}` },
      passwordHasher: { hash: async (value) => value, verify: async () => true },
      secureCookies: false,
    });

    await database.users.insert({
      id: 'user-1',
      email: 'owner@example.com',
      passwordHash: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await database.vaults.insert({
      id: 'vault-1',
      ownerUserId: 'user-1',
      name: 'Vault',
      latestRevision: 0,
      createdAt: NOW,
      updatedAt: NOW,
    });
    await database.devices.insert({
      id: 'device-1',
      userId: 'user-1',
      name: 'Device',
      createdAt: NOW,
      lastSeenAt: NOW,
    });
    const rawToken = 'gc-device-token';
    await database.apiTokens.insert({
      id: 'token-1',
      userId: 'user-1',
      vaultId: 'vault-1',
      deviceId: 'device-1',
      tokenHash: await hashOpaqueToken(rawToken),
      name: 'Sync',
      scopes: ['vault:upload', 'vault:read-metadata'],
      createdAt: NOW,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    const auth = { authorization: `Bearer ${rawToken}` };

    // Commit a referenced blob 8 days ago so its row is older than the grace period.
    now = NOW - 8 * DAY_MS;
    const referencedBytes = new TextEncoder().encode('# Referenced');
    const referencedHash = await sha256Hex(referencedBytes);
    const uploadReferenced = await app.request(`/api/v1/vaults/vault-1/blobs/${referencedHash}`, {
      method: 'PUT',
      headers: {
        ...auth,
        'x-tephra-blob-size': String(referencedBytes.byteLength),
        'content-type': 'text/markdown',
      },
      body: referencedBytes,
    });
    expect(uploadReferenced.status).toBe(200);
    const files: SyncManifestEntry[] = [
      {
        fileId: 'file-1',
        path: 'Note.md',
        hash: referencedHash,
        size: referencedBytes.byteLength,
        mtime: 1,
        kind: 'markdown',
      },
    ];
    const commit = await app.request('/api/v1/vaults/vault-1/sync/commit', {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'device-1',
        manifestHash: await hashManifest(files),
        files,
      }),
    });
    expect(commit.status).toBe(200);
    now = NOW;

    // A recent orphan uploaded through the API.
    const recentBytes = new TextEncoder().encode('recent orphan');
    const recentHash = await sha256Hex(recentBytes);
    const uploadRecent = await app.request(`/api/v1/vaults/vault-1/blobs/${recentHash}`, {
      method: 'PUT',
      headers: {
        ...auth,
        'x-tephra-blob-size': String(recentBytes.byteLength),
        'content-type': 'text/plain',
      },
      body: recentBytes,
    });
    expect(uploadRecent.status).toBe(200);

    // An old orphan inserted directly with an aged timestamp.
    const oldBytes = new TextEncoder().encode('old orphan');
    const oldHash = await sha256Hex(oldBytes);
    await blobStore.put({ hash: oldHash, bytes: oldBytes, size: oldBytes.byteLength });
    await database.blobs.insert({
      hash: oldHash,
      size: oldBytes.byteLength,
      mimeType: null,
      createdAt: NOW - 8 * DAY_MS,
    });

    const result = await collectUnreferencedBlobs({ database, blobStore, now: NOW });
    expect(result).toEqual({ deleted: [oldHash] });
    expect(await database.blobs.findByHash(oldHash)).toBeNull();
    expect(await blobStore.has(oldHash)).toBe(false);

    // Recent orphans stay within the 7-day grace period.
    expect(await database.blobs.findByHash(recentHash)).not.toBeNull();
    expect(await blobStore.has(recentHash)).toBe(true);

    // Old but referenced blobs are protected by vault_files and file_versions.
    expect(await database.blobs.findByHash(referencedHash)).not.toBeNull();
    expect(await blobStore.has(referencedHash)).toBe(true);

    // A second run finds nothing left to collect.
    await expect(collectUnreferencedBlobs({ database, blobStore, now: NOW })).resolves.toEqual({
      deleted: [],
    });
  });

  it('uses a 7-day default grace period and honors explicit options', () => {
    expect(DEFAULT_BLOB_GC_AGE_MS).toBe(7 * DAY_MS);
  });
});
