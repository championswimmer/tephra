import { describe, expect, it, vi } from 'vitest';
import type { BlobStore } from '@tephra/blob-store-core';
import type { Database } from '@tephra/database-core';
import { hashOpaqueToken } from '@tephra/auth';
import { SystemClock, UuidV7Generator } from '@tephra/core';
import { hashManifest, sha256Hex } from '@tephra/protocol';
import type { ApiToken, User, Vault } from '@tephra/vault-model';
import { createApp } from '../src/app.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ECHO_ID = '123e4567-e89b-12d3-a456-426614174000';

async function fixture() {
  const now = 1_700_000_000_000;
  const user: User = { id: 'user-1', email: 'owner@example.com', passwordHash: null, createdAt: now, updatedAt: now };
  const vault: Vault = { id: 'vault-1', ownerUserId: user.id, name: 'Test Vault', latestRevision: 0, createdAt: now, updatedAt: now };
  const tokenValue = 'tpt_test-token-value';
  const token: ApiToken = {
    id: 'token-1',
    userId: user.id,
    vaultId: vault.id,
    deviceId: null,
    tokenHash: await hashOpaqueToken(tokenValue),
    name: 'test',
    scopes: ['vault:read-metadata', 'vault:upload'],
    createdAt: now,
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };
  const database = {
    users: { findById: async (id: string) => (id === user.id ? user : null) },
    sessions: { findById: async () => null },
    vaults: { findById: async (id: string) => (id === vault.id ? vault : null) },
    apiTokens: {
      findById: async (id: string) => (id === token.id ? token : null),
      findByTokenHash: async (hash: string) => (hash === token.tokenHash ? token : null),
    },
    blobs: { findByHash: async () => null, findByHashes: async () => [], insert: async () => undefined },
    vaultRevisions: { findByManifestHash: async () => null },
  } as unknown as Database;
  const blobStore = { has: async () => false, put: async () => undefined } as unknown as BlobStore;
  const clock = new SystemClock();
  const app = createApp({
    database,
    blobStore,
    clock,
    ids: new UuidV7Generator(clock),
    passwordHasher: { hash: async (value: string) => value, verify: async () => false },
  });
  return { app, vault, tokenValue };
}

async function captureLogs<T>(run: () => T | Promise<T>): Promise<{ result: T; lines: Record<string, unknown>[] }> {
  const chunks: string[] = [];
  const spy = vi
    .spyOn(process.stdout, 'write')
    .mockImplementation(((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
  try {
    const result = await run();
    const lines = chunks
      .join('')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    return { result, lines };
  } finally {
    spy.mockRestore();
  }
}

describe('request observability', () => {
  it('sets X-Request-Id when absent', async () => {
    const { app } = await fixture();
    const response = await app.request('/healthz');
    const requestId = response.headers.get('x-request-id');
    expect(requestId).toMatch(UUID_PATTERN);
  });

  it('echoes a well-formed incoming X-Request-Id', async () => {
    const { app } = await fixture();
    const response = await app.request('/healthz', { headers: { 'x-request-id': ECHO_ID } });
    expect(response.headers.get('x-request-id')).toBe(ECHO_ID);
  });

  it('replaces a malformed incoming X-Request-Id', async () => {
    const { app } = await fixture();
    const response = await app.request('/healthz', { headers: { 'x-request-id': 'not-a-uuid' } });
    const requestId = response.headers.get('x-request-id');
    expect(requestId).not.toBe('not-a-uuid');
    expect(requestId).toMatch(UUID_PATTERN);
  });

  it('carries X-Request-Id on error responses', async () => {
    const { app } = await fixture();
    const unauthorized = await app.request('/api/v1/auth/me');
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get('x-request-id')).toMatch(UUID_PATTERN);
    const missing = await app.request('/does-not-exist', { headers: { 'x-request-id': ECHO_ID } });
    expect(missing.status).toBe(404);
    expect(missing.headers.get('x-request-id')).toBe(ECHO_ID);
  });

  it('emits one structured log line per request without secrets', async () => {
    const { app } = await fixture();
    const { result, lines } = await captureLogs(() =>
      app.request('/healthz', { headers: { authorization: 'Bearer secret-token', cookie: 'tephra_session=secret-session' } }),
    );
    const headerId = result.headers.get('x-request-id');
    expect(lines).toHaveLength(1);
    const entry = lines[0]!;
    expect(entry.request_id).toBe(headerId);
    expect(entry.method).toBe('GET');
    expect(entry.path).toBe('/healthz');
    expect(entry.status).toBe(200);
    expect(typeof entry.duration_ms).toBe('number');
    const serialized = JSON.stringify(entry);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).not.toContain('secret-session');
    for (const forbidden of ['authorization', 'cookie', 'password', 'content', 'token_hash', 'tokenHash']) {
      expect(entry).not.toHaveProperty(forbidden);
    }
  });

  it('includes sync fields for sync/plan and blob upload log lines', async () => {
    const { app, vault, tokenValue } = await fixture();
    const auth = { authorization: `Bearer ${tokenValue}` };
    const files = [
      { fileId: 'file-1', path: 'Note.md', hash: await sha256Hex(new TextEncoder().encode('hello')), size: 5, mtime: 1, kind: 'markdown' as const },
    ];
    const manifestHash = await hashManifest(files);
    const plan = await captureLogs(() =>
      app.request(`/api/v1/vaults/${vault.id}/sync/plan`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ deviceId: 'device-1', manifestHash, files }),
      }),
    );
    expect(plan.lines).toHaveLength(1);
    expect(plan.lines[0]).toMatchObject({
      vault_id: vault.id,
      device_id: 'device-1',
      manifest_hash: manifestHash,
      revision: 0,
      changed_file_count: 1,
    });

    const bytes = new TextEncoder().encode('hello');
    const hash = await sha256Hex(bytes);
    const upload = await captureLogs(() =>
      app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, {
        method: 'PUT',
        headers: { ...auth, 'x-tephra-blob-size': String(bytes.byteLength), 'content-type': 'text/markdown' },
        body: bytes,
      }),
    );
    expect(upload.lines).toHaveLength(1);
    expect(upload.lines[0]).toMatchObject({ vault_id: vault.id, uploaded_blob_count: 1 });
  });
});
