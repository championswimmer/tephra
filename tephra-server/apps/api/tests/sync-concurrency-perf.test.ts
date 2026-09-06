import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createFilesystemBlobStore } from '@tephra/blob-store-filesystem';
import { openSqliteDatabase, type SqliteDatabase } from '@tephra/database-sqlite';
import { hashManifest, MINIMUM_PLUGIN_VERSION, PROTOCOL_VERSION, sha256Hex, type SyncManifestEntry } from '@tephra/protocol';
import type { Vault } from '@tephra/vault-model';
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createRuntimeIndexService } from '../src/runtime-index.js';

const databases: SqliteDatabase[] = [];
const directories: string[] = [];

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

interface RealFixture {
  app: ReturnType<typeof createApp>;
  database: SqliteDatabase;
  indexService: ReturnType<typeof createRuntimeIndexService>;
  vault: Vault;
  token: string;
}

async function realFixture(): Promise<RealFixture> {
  const directory = await mkdtemp(join(tmpdir(), 'tephra-api-real-'));
  directories.push(directory);
  const database = openSqliteDatabase(join(directory, 'tephra.db'));
  databases.push(database);
  const blobStore = createFilesystemBlobStore(join(directory, 'blobs'));
  let nextId = 0;
  const ids = { generate: () => `fixture-${++nextId}` };
  const clock = { now: () => 1_700_000_000_000 };
  // Build the real indexer against the same adapters but do NOT hand it to
  // the app: commits stay synchronous and tests drive indexing explicitly.
  const indexService = createRuntimeIndexService({ database, blobStore, clock, ids });
  const app = createApp({
    database,
    blobStore,
    clock,
    ids,
    passwordHasher: {
      hash: async (password: string) => `hash:${password}`,
      verify: async (password: string, hash: string) => hash === `hash:${password}`,
    },
    bootstrapToken: 'bootstrap-secret',
    secureCookies: false,
  });

  const bootstrap = await app.request('/api/v1/auth/bootstrap', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: 'bootstrap-secret',
      email: 'owner@example.com',
      password: 'password-123',
    }),
  });
  expect(bootstrap.status).toBe(201);
  const login = await app.request('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'owner@example.com', password: 'password-123' }),
  });
  expect(login.status).toBe(200);
  const loginBody = (await login.json()) as { csrfToken: string };
  const session = /tephra_session=([^;,]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];
  const browserHeaders = {
    cookie: `tephra_session=${session}; tephra_csrf=${loginBody.csrfToken}`,
    'x-tephra-csrf': loginBody.csrfToken,
    'content-type': 'application/json',
  };
  const vaultResponse = await app.request('/api/v1/vaults', {
    method: 'POST',
    headers: browserHeaders,
    body: JSON.stringify({ name: 'Real Store Vault' }),
  });
  expect(vaultResponse.status).toBe(201);
  const { vault } = (await vaultResponse.json()) as { vault: Vault };
  const tokenResponse = await app.request(`/api/v1/vaults/${vault.id}/tokens`, {
    method: 'POST',
    headers: browserHeaders,
    body: JSON.stringify({ name: 'Plugin' }),
  });
  expect(tokenResponse.status).toBe(201);
  const { value: token } = (await tokenResponse.json()) as { value: string };
  return { app, database, indexService, vault, token };
}

async function putBlob(
  app: RealFixture['app'],
  vaultId: string,
  token: string,
  bytes: Uint8Array<ArrayBuffer>,
  hash: string,
): Promise<void> {
  const response = await app.request(`/api/v1/vaults/${vaultId}/blobs/${hash}`, {
    method: 'PUT',
    headers: {
      authorization: `Bearer ${token}`,
      'x-tephra-blob-size': String(bytes.byteLength),
      'content-type': 'text/markdown',
    },
    body: bytes,
  });
  expect(response.status).toBe(200);
}

function entry(fileId: string, path: string, hash: string, size: number): SyncManifestEntry {
  return {
    fileId,
    path,
    hash,
    size,
    mtime: 1_700_000_000_000,
    kind: 'markdown',
    mimeType: 'text/markdown',
  };
}

describe('concurrent commits against one vault (real SQLite + filesystem blobs)', () => {
  it('serializes N concurrent commits into revisions 1..N with last-writer-wins state and full history', async () => {
    const { app, database, vault, token } = await realFixture();
    const count = 8;

    // Distinct single-file manifests: each commit replaces the previous
    // file, so the winner's manifest is the whole vault state while every
    // commit still leaves create/delete rows in file_versions.
    const manifests: { deviceId: string; files: SyncManifestEntry[]; manifestHash: string }[] = [];
    for (let index = 0; index < count; index += 1) {
      const bytes = new TextEncoder().encode(
        `# Concurrent note ${index}\n\nBody for device ${index}.\n`,
      );
      const hash = await sha256Hex(bytes);
      await putBlob(app, vault.id, token, bytes, hash);
      const files = [
        entry(`concurrent-file-${index}`, `Concurrent-${index}.md`, hash, bytes.byteLength),
      ];
      manifests.push({
        deviceId: `concurrent-device-${index}`,
        files,
        manifestHash: await hashManifest(files),
      });
    }

    const results = await Promise.all(
      manifests.map(async (manifest) => {
        const response = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            deviceId: manifest.deviceId,
            manifestHash: manifest.manifestHash,
            files: manifest.files,
          }),
        });
        expect(response.status).toBe(200);
        return (await response.json()) as { status: string; revision: number };
      }),
    );

    // Every commit succeeded and revisions are strictly monotonic 1..N.
    expect(results.every((result) => result.status === 'committed')).toBe(true);
    const revisions = results.map((result) => result.revision).sort((a, b) => a - b);
    expect(revisions).toEqual(Array.from({ length: count }, (_, index) => index + 1));

    // Current state is exactly one committed manifest (last-writer-wins).
    const listing = await app.request(`/api/v1/vaults/${vault.id}/files`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listing.status).toBe(200);
    const { revision, files } = (await listing.json()) as {
      revision: number;
      files: SyncManifestEntry[];
    };
    expect(revision).toBe(count);
    expect(files).toHaveLength(1);
    const winner = manifests.find(
      (manifest) =>
        manifest.files[0]?.fileId === (files[0] as unknown as { fileId: string }).fileId,
    );
    expect(winner).toBeDefined();
    expect(files[0]).toMatchObject({
      path: winner?.files[0]?.path,
      blobHash: winner?.files[0]?.hash,
    });

    // Revision rows cover every manifest hash with no gaps or duplicates.
    const stored = await database.vaultRevisions.list(vault.id);
    expect(stored.map((item) => item.revision).sort((a, b) => a - b)).toEqual(revisions);
    expect(new Set(stored.map((item) => item.manifestHash))).toEqual(
      new Set(manifests.map((item) => item.manifestHash)),
    );

    // History is preserved: revision 1 creates one file; every later
    // revision creates its file and deletes the previous winner.
    let versionTotal = 0;
    for (let rev = 1; rev <= count; rev += 1) {
      const versions = await database.fileVersions.listByRevision(vault.id, rev);
      expect(versions.length).toBeGreaterThan(0);
      versionTotal += versions.length;
    }
    expect(versionTotal).toBe(1 + (count - 1) * 2);
    for (const manifest of manifests) {
      const versions = await database.fileVersions.listByFile(vault.id, manifest.files[0]!.fileId);
      expect(versions.some((version) => version.changeType === 'create')).toBe(true);
    }
  });
});

describe('larger-vault indexing performance (real SQLite + filesystem blobs)', () => {
  it(
    'commits ~500 cross-linked notes, indexes, and serves the graph in well under 30s',
    { timeout: 60_000 },
    async () => {
      const { app, database, indexService, vault, token } = await realFixture();
      const count = 500;
      const pad = (index: number): string => `Note-${String(index).padStart(4, '0')}`;
      const overallStart = Date.now();

      const files: SyncManifestEntry[] = [];
      const bodies = new Map<string, Uint8Array<ArrayBuffer>>();
      for (let index = 0; index < count; index += 1) {
        const first = pad((index + 1) % count);
        const second = pad((index + 7) % count);
        const markdown =
          `---\ntitle: ${pad(index)}\n---\n# ${pad(index)}\n\n` +
          `Connects to [[${first}]] and [[${second}|alias for ${second}]].\n\n` +
          `Filler sentence ${index} to give the note realistic body text. `.repeat(6) +
          '\n';
        const bytes = new TextEncoder().encode(markdown);
        const hash = await sha256Hex(bytes);
        bodies.set(hash, bytes);
        files.push(entry(`perf-file-${index}`, `notes/${pad(index)}.md`, hash, bytes.byteLength));
      }
      const manifestHash = await hashManifest(files);

      const uploadStart = Date.now();
      const uploadChunk = 50;
      for (let offset = 0; offset < files.length; offset += uploadChunk) {
        await Promise.all(
          files
            .slice(offset, offset + uploadChunk)
            .map((file) => putBlob(app, vault.id, token, bodies.get(file.hash)!, file.hash)),
        );
      }
      const uploadMs = Date.now() - uploadStart;

      const commitStart = Date.now();
      const commitBody = JSON.stringify({ deviceId: 'perf-device', manifestHash, files });
      const commit = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: commitBody,
      });
      expect(commit.status).toBe(200);
      const commitResult = (await commit.json()) as { status: string; revision: number };
      expect(commitResult).toEqual({ status: 'committed', revision: 1, protocolVersion: PROTOCOL_VERSION, minimumPluginVersion: MINIMUM_PLUGIN_VERSION });
      const commitMs = Date.now() - commitStart;

      const indexStart = Date.now();
      const indexVault = indexService.indexVault;
      if (!indexVault) throw new Error('Runtime index service does not implement indexVault');
      await indexVault(vault.id, commitResult.revision);
      const indexMs = Date.now() - indexStart;
      expect((await database.noteIndex.getState(vault.id))?.indexedRevision).toBe(
        commitResult.revision,
      );
      expect(await database.noteIndex.listMetadata(vault.id)).toHaveLength(count);

      const graphStart = Date.now();
      const graph = await app.request(`/api/v1/vaults/${vault.id}/graph`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(graph.status).toBe(200);
      const graphBody = (await graph.json()) as {
        revision: number;
        nodes: unknown[];
        edges: { count: number }[];
      };
      const graphMs = Date.now() - graphStart;
      expect(graphBody.revision).toBe(1);
      expect(graphBody.nodes).toHaveLength(count);
      expect(graphBody.edges.length).toBeGreaterThan(0);

      // Unchanged reconciliation: recommitting the identical manifest is a
      // no-op, and plan reports up-to-date with nothing left to upload.
      const recommit = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: commitBody,
      });
      expect(await recommit.json()).toEqual({ status: 'up-to-date', revision: 1, protocolVersion: PROTOCOL_VERSION, minimumPluginVersion: MINIMUM_PLUGIN_VERSION });
      const plan = await app.request(`/api/v1/vaults/${vault.id}/sync/plan`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: commitBody,
      });
      expect(await plan.json()).toEqual({
        status: 'up-to-date',
        latestRevision: 1,
        missingBlobs: [],
        protocolVersion: PROTOCOL_VERSION,
        minimumPluginVersion: MINIMUM_PLUGIN_VERSION,
      });
      expect(await database.vaultRevisions.list(vault.id)).toHaveLength(1);

      const totalMs = Date.now() - overallStart;
      console.log(
        `[perf] ${count} notes: upload=${uploadMs}ms commit=${commitMs}ms index=${indexMs}ms graph=${graphMs}ms total=${totalMs}ms`,
      );
      expect(totalMs).toBeLessThan(30_000);
    },
  );

  it("provisions token with client-supplied deviceId on real SQLite without foreign key violation", async () => {
    const { app, database, vault } = await realFixture();
    // Login to get session headers
    const login = await app.request("/api/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "owner@example.com", password: "password-123" }),
    });
    const loginBody = (await login.json()) as { csrfToken: string };
    const session = /tephra_session=([^;,]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1];
    const browserHeaders = {
      cookie: `tephra_session=${session}; tephra_csrf=${loginBody.csrfToken}`,
      "x-csrf-token": loginBody.csrfToken,
      "content-type": "application/json",
    };

    const deviceId = "obsidian-plugin-device-uuid-1234";
    const tokenResponse = await app.request(`/api/v1/vaults/${vault.id}/tokens`, {
      method: "POST",
      headers: browserHeaders,
      body: JSON.stringify({
        name: "Obsidian (My MacBook)",
        deviceId,
        deviceName: "My MacBook",
        platform: "obsidian-plugin",
      }),
    });
    expect(tokenResponse.status).toBe(201);
    const tokenData = (await tokenResponse.json()) as { token: { id: string; name: string }; value: string };
    expect(tokenData.token.name).toBe("Obsidian (My MacBook)");
    expect(tokenData.value).toMatch(/^tpt_/);

    const savedDevice = await database.devices.findById(deviceId);
    expect(savedDevice).toBeDefined();
    expect(savedDevice?.id).toBe(deviceId);
    expect(savedDevice?.name).toBe("My MacBook");
    expect(savedDevice?.platform).toBe("obsidian-plugin");
  });
});
