import { describe, expect, it } from 'vitest';
import type { NoteIndexRepository } from '@tephra/database-core';
import {
  hashManifest,
  MINIMUM_PLUGIN_VERSION,
  PROTOCOL_VERSION,
  sha256Hex,
  type SyncManifestEntry,
} from '@tephra/protocol';
import type { ApiToken, NoteLink, NoteMetadata, Vault } from '@tephra/vault-model';
import { createRuntimeIndexService } from '../src/runtime-index.js';
import { fixture, setup } from './helpers.js';

describe('Tephra API', () => {
  it('bootstraps once, authenticates, and keeps tokens vault-scoped', async () => {
    const { app, token, browserHeaders } = await setup();
    const other = await app.request('/api/v1/vaults', {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({ name: 'Other' }),
    });
    const { vault } = (await other.json()) as { vault: Vault };
    const denied = await app.request(`/api/v1/vaults/${vault.id}/files`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(denied.status).toBe(403);
  });

  it('rejects duplicate vault names, validates names, and resolves vaults by name', async () => {
    const { app, vault, browserHeaders } = await setup();
    const duplicate = await app.request('/api/v1/vaults', {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({ name: 'Test Vault' }),
    });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toEqual({
      error: { code: 'VAULT_NAME_TAKEN', message: 'A vault with this name already exists.' },
    });
    const caseVariant = await app.request('/api/v1/vaults', {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({ name: 'test vault' }),
    });
    expect(caseVariant.status).toBe(201);
    const slashed = await app.request('/api/v1/vaults', {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({ name: 'a/b' }),
    });
    expect(slashed.status).toBe(400);

    const byName = await app.request(`/api/v1/vaults/${encodeURIComponent(vault.name)}`, {
      headers: browserHeaders,
    });
    expect(byName.status).toBe(200);
    expect(await byName.json()).toEqual({ vault });
    const byId = await app.request(`/api/v1/vaults/${vault.id}`, { headers: browserHeaders });
    expect(byId.status).toBe(200);
    const filesByName = await app.request(
      `/api/v1/vaults/${encodeURIComponent(vault.name)}/files`,
      { headers: browserHeaders },
    );
    expect(filesByName.status).toBe(200);
  });

  it('deletes vaults only after exact name confirmation', async () => {
    const { app, vault, browserHeaders, database } = await setup();
    const mismatch = await app.request(`/api/v1/vaults/${vault.id}`, {
      method: 'DELETE',
      headers: browserHeaders,
      body: JSON.stringify({ confirmation: 'test vault' }),
    });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.json()).toEqual({
      error: {
        code: 'VAULT_NAME_MISMATCH',
        message: 'Vault name confirmation does not match.',
      },
    });
    expect(database.state.vaults.get(vault.id)).toMatchObject({ name: 'Test Vault' });

    const deleted = await app.request(`/api/v1/vaults/${vault.id}`, {
      method: 'DELETE',
      headers: browserHeaders,
      body: JSON.stringify({ confirmation: vault.name }),
    });
    expect(deleted.status).toBe(204);
    expect(database.state.vaults.has(vault.id)).toBe(false);
    expect([...database.state.tokens.values()].some((token) => token.vaultId === vault.id)).toBe(
      false,
    );
  });

  it('creates tokens by vault name and syncs through the name address', async () => {
    const { app, vault, browserHeaders } = await setup();
    const created = await app.request(`/api/v1/vaults/${encodeURIComponent(vault.name)}/tokens`, {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({ name: 'Plugin by name' }),
    });
    expect(created.status).toBe(201);
    const { value: token } = (await created.json()) as { value: string };
    const bytes = new TextEncoder().encode('# Named');
    const hash = await sha256Hex(bytes);
    const files: SyncManifestEntry[] = [
      {
        fileId: 'file-1',
        path: 'Note.md',
        hash,
        size: bytes.byteLength,
        mtime: 1,
        kind: 'markdown',
      },
    ];
    const body = JSON.stringify({
      deviceId: 'device-1',
      manifestHash: await hashManifest(files),
      files,
    });
    const plan = await app.request(`/api/v1/vaults/${encodeURIComponent(vault.name)}/sync/plan`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    expect(plan.status).toBe(200);
    await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tephra-blob-size': String(bytes.byteLength),
        'content-type': 'text/markdown',
      },
      body: bytes,
    });
    const commit = await app.request(
      `/api/v1/vaults/${encodeURIComponent(vault.name)}/sync/commit`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body,
      },
    );
    expect(commit.status).toBe(200);
    const filesById = await app.request(`/api/v1/vaults/${vault.id}/files`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await filesById.json()) as { revision: number }).revision).toBe(1);
  });

  it('rejects bad uploads and rolls back missing-blob commits', async () => {
    const { app, token, vault, database } = await setup();
    const bytes = new TextEncoder().encode('hello');
    const hash = await sha256Hex(bytes);
    const bad = await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${token}`, 'x-tephra-blob-size': '5' },
      body: 'wrong',
    });
    expect(bad.status).toBe(400);
    expect(database.state.blobs.size).toBe(0);
    const files: SyncManifestEntry[] = [
      { fileId: 'file-1', path: 'Note.md', hash, size: 5, mtime: 1, kind: 'markdown' },
    ];
    const commit = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'device-1',
        manifestHash: await hashManifest(files),
        files,
      }),
    });
    expect(commit.status).toBe(409);
    expect(database.state.revisions).toHaveLength(0);
    expect(database.state.vaults.get(vault.id)?.latestRevision).toBe(0);
  });

  it('registers the syncing device on commit', async () => {
    const { app, token, vault, database } = await setup();
    const bytes = new TextEncoder().encode('# Device');
    const hash = await sha256Hex(bytes);
    await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tephra-blob-size': String(bytes.byteLength),
        'content-type': 'text/markdown',
      },
      body: bytes,
    });
    const files: SyncManifestEntry[] = [
      {
        fileId: 'file-1',
        path: 'Note.md',
        hash,
        size: bytes.byteLength,
        mtime: 1,
        kind: 'markdown',
      },
    ];
    const commit = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'field-device',
        manifestHash: await hashManifest(files),
        files,
      }),
    });
    expect(commit.status).toBe(200);
    expect(database.state.devices.get('field-device')).toMatchObject({
      userId: vault.ownerUserId,
      lastSeenAt: 1_700_000_000_000,
    });
  });

  it('commits once, serves reads, and is idempotent by manifest hash', async () => {
    const { app, token, vault, database } = await setup();
    const bytes = new TextEncoder().encode('# Hello');
    const hash = await sha256Hex(bytes);
    const upload = await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tephra-blob-size': String(bytes.byteLength),
        'content-type': 'text/markdown',
      },
      body: bytes,
    });
    expect(upload.status).toBe(200);
    const files: SyncManifestEntry[] = [
      {
        fileId: 'file-1',
        path: 'Note.md',
        hash,
        size: bytes.byteLength,
        mtime: 1,
        kind: 'markdown',
        mimeType: 'text/markdown',
      },
    ];
    const body = JSON.stringify({
      deviceId: 'device-1',
      manifestHash: await hashManifest(files),
      files,
    });
    const first = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    expect(await first.json()).toEqual({
      status: 'committed',
      revision: 1,
      protocolVersion: PROTOCOL_VERSION,
      minimumPluginVersion: MINIMUM_PLUGIN_VERSION,
    });
    const second = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body,
    });
    expect(await second.json()).toEqual({
      status: 'up-to-date',
      revision: 1,
      protocolVersion: PROTOCOL_VERSION,
      minimumPluginVersion: MINIMUM_PLUGIN_VERSION,
    });
    expect(database.state.revisions).toHaveLength(1);
    const listing = await app.request(`/api/v1/vaults/${vault.id}/files`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(((await listing.json()) as { revision: number }).revision).toBe(1);
    const raw = await app.request(`/api/v1/vaults/${vault.id}/files/file-1/raw`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await raw.text()).toBe('# Hello');
  });

  it('advertises protocol versions and tolerates client version headers', async () => {
    const { app, token, vault } = await setup();
    const bytes = new TextEncoder().encode('# Versioned');
    const hash = await sha256Hex(bytes);
    const files: SyncManifestEntry[] = [
      {
        fileId: 'file-1',
        path: 'Note.md',
        hash,
        size: bytes.byteLength,
        mtime: 1,
        kind: 'markdown',
      },
    ];
    const body = JSON.stringify({
      deviceId: 'device-1',
      manifestHash: await hashManifest(files),
      files,
    });
    const versionHeaders = {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-tephra-plugin-version': '0.1.0',
      'x-tephra-protocol-version': '1',
    };
    const plan = await app.request(`/api/v1/vaults/${vault.id}/sync/plan`, {
      method: 'POST',
      headers: versionHeaders,
      body,
    });
    expect(plan.status).toBe(200);
    expect(await plan.json()).toEqual({
      status: 'upload-required',
      latestRevision: 0,
      missingBlobs: [{ hash, size: bytes.byteLength }],
      protocolVersion: PROTOCOL_VERSION,
      minimumPluginVersion: MINIMUM_PLUGIN_VERSION,
    });
    await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tephra-blob-size': String(bytes.byteLength),
        'content-type': 'text/markdown',
      },
      body: bytes,
    });
    const commit = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, {
      method: 'POST',
      headers: versionHeaders,
      body,
    });
    expect(await commit.json()).toEqual({
      status: 'committed',
      revision: 1,
      protocolVersion: PROTOCOL_VERSION,
      minimumPluginVersion: MINIMUM_PLUGIN_VERSION,
    });
  });
  it('supports bearer-authenticated sessions for non-browser clients without CSRF', async () => {
    const value = fixture();
    await value.app.request('/api/v1/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: 'bootstrap-secret',
        email: 'owner@example.com',
        password: 'password-123',
      }),
    });

    const login = await value.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'owner@example.com', password: 'password-123' }),
    });
    expect(login.status).toBe(200);
    const { sessionToken, user } = (await login.json()) as {
      sessionToken: string;
      user: { id: string; email: string };
    };
    expect(sessionToken).toMatch(/^tps_/);
    expect(user.email).toBe('owner@example.com');

    const sessionHeaders = {
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json',
    };

    const me = await value.app.request('/api/v1/auth/me', { headers: sessionHeaders });
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ user });

    const vaultsList = await value.app.request('/api/v1/vaults', { headers: sessionHeaders });
    expect(vaultsList.status).toBe(200);
    expect(await vaultsList.json()).toEqual({ vaults: [] });

    const createVault = await value.app.request('/api/v1/vaults', {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({ name: 'Obsidian Cloud Vault' }),
    });
    expect(createVault.status).toBe(201);
    const { vault } = (await createVault.json()) as { vault: Vault };
    expect(vault.name).toBe('Obsidian Cloud Vault');

    const createToken = await value.app.request(`/api/v1/vaults/${vault.id}/tokens`, {
      method: 'POST',
      headers: sessionHeaders,
      body: JSON.stringify({
        name: 'Obsidian Plugin (MacBook Pro)',
        deviceName: 'MacBook Pro',
        platform: 'obsidian-plugin',
      }),
    });
    expect(createToken.status).toBe(201);
    const { token: apiToken, value: rawToken } = (await createToken.json()) as {
      token: ApiToken;
      value: string;
    };
    expect(rawToken).toMatch(/^tpt_/);
    expect(apiToken.name).toBe('Obsidian Plugin (MacBook Pro)');

    const logout = await value.app.request('/api/v1/auth/logout', {
      method: 'POST',
      headers: sessionHeaders,
    });
    expect(logout.status).toBe(200);

    const revoked = await value.app.request('/api/v1/vaults', { headers: sessionHeaders });
    expect(revoked.status).toBe(401);
  });

  it('validates CSRF with x-csrf-token or x-tephra-csrf and rejects missing or invalid header', async () => {
    const value = fixture();
    await value.app.request('/api/v1/auth/bootstrap', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        token: 'bootstrap-secret',
        email: 'csrf-test@example.com',
        password: 'password-123',
      }),
    });
    const login = await value.app.request('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'csrf-test@example.com', password: 'password-123' }),
    });
    const loginBody = (await login.json()) as { csrfToken: string };
    const session = /tephra_session=([^;,]+)/.exec(login.headers.get('set-cookie') ?? '')?.[1];

    // Rejected if no CSRF header
    const noHeader = await value.app.request('/api/v1/vaults', {
      method: 'POST',
      headers: {
        cookie: `tephra_session=${session}; tephra_csrf=${loginBody.csrfToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'No CSRF' }),
    });
    expect(noHeader.status).toBe(403);
    const noHeaderBody = (await noHeader.json()) as { error: { code: string; message: string } };
    expect(noHeaderBody.error.message).toBe('CSRF validation failed.');

    // Accepted with x-csrf-token
    const withStandardCsrf = await value.app.request('/api/v1/vaults', {
      method: 'POST',
      headers: {
        cookie: `tephra_session=${session}; tephra_csrf=${loginBody.csrfToken}`,
        'x-csrf-token': loginBody.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Standard CSRF Vault' }),
    });
    expect(withStandardCsrf.status).toBe(201);

    // Accepted with x-tephra-csrf
    const withTephraCsrf = await value.app.request('/api/v1/vaults', {
      method: 'POST',
      headers: {
        cookie: `tephra_session=${session}; tephra_csrf=${loginBody.csrfToken}`,
        'x-tephra-csrf': loginBody.csrfToken,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ name: 'Tephra CSRF Vault' }),
    });
    expect(withTephraCsrf.status).toBe(201);
  });

  it('provisions token with client-supplied deviceId, upserts device and enforces ownership', async () => {
    const { app, vault, browserHeaders, database } = await setup();
    const deviceId = 'client-device-123';

    // 1. Provision token with explicit client deviceId
    const res = await app.request(`/api/v1/vaults/${vault.id}/tokens`, {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({
        name: 'Obsidian (MacBook)',
        deviceId,
        deviceName: 'MacBook',
        platform: 'obsidian-plugin',
      }),
    });
    expect(res.status).toBe(201);
    const savedDevice = await database.devices.findById(deviceId);
    expect(savedDevice).toBeDefined();
    expect(savedDevice?.name).toBe('MacBook');
    expect(savedDevice?.platform).toBe('obsidian-plugin');
    expect(savedDevice?.userId).toBe(vault.ownerUserId);

    // 2. Provision another token with the same deviceId updates the device
    const res2 = await app.request(`/api/v1/vaults/${vault.id}/tokens`, {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({
        name: 'Obsidian (MacBook 2)',
        deviceId,
        deviceName: 'MacBook Updated',
        platform: 'obsidian-plugin',
      }),
    });
    expect(res2.status).toBe(201);
    const updatedDevice = await database.devices.findById(deviceId);
    expect(updatedDevice?.name).toBe('MacBook Updated');

    // 3. Another user cannot provision a token with this deviceId
    const otherUser = {
      id: 'other-user',
      email: 'other-device@example.com',
      passwordHash: null,
      createdAt: 1,
      updatedAt: 1,
    };
    await database.users.insert(otherUser);
    const rawOtherSession = 'tps_other-raw-session-token';
    const otherSessionHash = await (await import('@tephra/auth')).hashOpaqueToken(rawOtherSession);
    await database.sessions.insert({
      id: otherSessionHash,
      userId: otherUser.id,
      expiresAt: 2_000_000_000_000,
      createdAt: 1,
    });
    const otherVault = {
      id: 'other-vault-1',
      ownerUserId: otherUser.id,
      name: 'Other Vault',
      latestRevision: 0,
      createdAt: 1,
      updatedAt: 1,
    };
    await database.vaults.insert(otherVault);

    const crossUserRes = await app.request(`/api/v1/vaults/${otherVault.id}/tokens`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${rawOtherSession}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Stolen Device Token',
        deviceId,
        deviceName: 'Imposter',
      }),
    });
    expect(crossUserRes.status).toBe(403);
    const crossUserBody = (await crossUserRes.json()) as { error: { message: string } };
    expect(crossUserBody.error.message).toBe('Device belongs to another user.');
  });
});

async function commitEntries(
  app: { request: (input: string, init?: any) => any },
  token: string,
  vaultId: string,
  entries: Array<{ fileId: string; path: string; content: string }>,
) {
  const files: SyncManifestEntry[] = [];
  for (const entry of entries) {
    const bytes = new TextEncoder().encode(entry.content);
    const hash = await sha256Hex(bytes);
    await app.request(`/api/v1/vaults/${vaultId}/blobs/${hash}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tephra-blob-size': String(bytes.byteLength),
        'content-type': 'text/markdown',
      },
      body: bytes,
    });
    files.push({
      fileId: entry.fileId,
      path: entry.path,
      hash,
      size: bytes.byteLength,
      mtime: 1,
      kind: 'markdown',
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifestHash = await hashManifest(files);
  return app.request(`/api/v1/vaults/${vaultId}/sync/commit`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId: 'device-1', manifestHash, files }),
  });
}

describe('composite vault_file identity', () => {
  it('keeps identical paths in two vaults independent', async () => {
    const { app, token, vault, browserHeaders, database } = await setup();
    const otherVaultResponse = await app.request('/api/v1/vaults', {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({ name: 'Second Vault' }),
    });
    const { vault: vaultB } = (await otherVaultResponse.json()) as { vault: Vault };
    const tokenResponse = await app.request(`/api/v1/vaults/${vaultB.id}/tokens`, {
      method: 'POST',
      headers: browserHeaders,
      body: JSON.stringify({ name: 'Plugin B' }),
    });
    const { value: tokenB } = (await tokenResponse.json()) as { value: string };
    const commitA = await commitEntries(app, token, vault.id, [
      { fileId: 'shared-id', path: 'Note.md', content: 'vault a' },
    ]);
    expect(commitA.status).toBe(200);
    const commitB = await commitEntries(app, tokenB, vaultB.id, [
      { fileId: 'shared-id', path: 'Note.md', content: 'vault b' },
    ]);
    expect(commitB.status).toBe(200);
    const filesA = await database.vaultFiles.listByVault(vault.id);
    const filesB = await database.vaultFiles.listByVault(vaultB.id);
    expect(filesA).toHaveLength(1);
    expect(filesB).toHaveLength(1);
    expect(filesA[0]).toMatchObject({ vaultId: vault.id, fileId: 'shared-id' });
    expect(filesB[0]).toMatchObject({ vaultId: vaultB.id, fileId: 'shared-id' });
    // Vault-scoped reads never cross vaults.
    expect(await database.vaultFiles.findById(vault.id, 'shared-id')).toMatchObject({
      vaultId: vault.id,
    });
    expect(await database.vaultFiles.findById(vaultB.id, 'shared-id')).toMatchObject({
      vaultId: vaultB.id,
    });
    const readA = await app.request(`/api/v1/vaults/${vault.id}/files/shared-id`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(readA.status).toBe(200);
    expect(((await readA.json()) as { file: { vaultId?: string; path: string } }).file.path).toBe(
      'Note.md',
    );
    // Committing again in vault A does not steal vault B's row.
    const recommit = await commitEntries(app, token, vault.id, [
      { fileId: 'shared-id', path: 'Renamed.md', content: 'vault a' },
    ]);
    expect(recommit.status).toBe(200);
    expect(await database.vaultFiles.findById(vaultB.id, 'shared-id')).toMatchObject({
      path: 'Note.md',
    });
  });

  it('rejects a non-NFC path at commit with 400 INVALID_PATH', async () => {
    const { app, token, vault } = await setup();
    const nfd = 'Cafe\u0301.md';
    expect(nfd.normalize('NFC') !== nfd).toBe(true);
    const bytes = new TextEncoder().encode('# nfd');
    const hash = await sha256Hex(bytes);
    await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${token}`,
        'x-tephra-blob-size': String(bytes.byteLength),
        'content-type': 'text/markdown',
      },
      body: bytes,
    });
    const files: SyncManifestEntry[] = [
      { fileId: 'file-nfd', path: nfd, hash, size: bytes.byteLength, mtime: 1, kind: 'markdown' },
    ];
    // Bypass hashManifest (it would throw on validation) with a bogus hash; path validation must still fire first.
    const commit = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'device-1', manifestHash: '0'.repeat(64), files }),
    });
    expect(commit.status).toBe(400);
    expect(((await commit.json()) as { error: { code: string } }).error.code).toBe('INVALID_PATH');
  });
});

describe('path resolver', () => {
  it('resolves exact paths', async () => {
    const { app, token, vault } = await setup();
    await commitEntries(app, token, vault.id, [
      { fileId: 'file-1', path: 'Notes/Hello.md', content: 'hi' },
    ]);
    const response = await app.request(
      `/api/v1/vaults/${vault.id}/resolve?path=${encodeURIComponent('Notes/Hello.md')}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      match: string;
      requestedPath: string;
      canonicalPath: string;
      file: { fileId: string };
    };
    expect(body.match).toBe('exact');
    expect(body.canonicalPath).toBe('Notes/Hello.md');
    expect(body.file.fileId).toBe('file-1');
  });

  it('resolves NFD requests to NFC rows as normalized', async () => {
    const { app, token, vault } = await setup();
    const nfc = 'Caf\u00e9.md';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    await commitEntries(app, token, vault.id, [{ fileId: 'file-1', path: nfc, content: 'cafe' }]);
    const response = await app.request(
      `/api/v1/vaults/${vault.id}/resolve?path=${encodeURIComponent(nfd)}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { match: string; canonicalPath: string };
    expect(body.match).toBe('normalized');
    expect(body.canonicalPath).toBe(nfc);
  });

  it('resolves case-only misses as case, not exact', async () => {
    const { app, token, vault } = await setup();
    await commitEntries(app, token, vault.id, [
      { fileId: 'file-1', path: 'Note.md', content: 'hi' },
    ]);
    const response = await app.request(
      `/api/v1/vaults/${vault.id}/resolve?path=${encodeURIComponent('note.md')}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { match: string; canonicalPath: string };
    expect(body.match).toBe('case');
    expect(body.canonicalPath).toBe('Note.md');
  });

  it('returns 409 AMBIGUOUS_PATH when the fold matches several files', async () => {
    const { app, token, vault } = await setup();
    await commitEntries(app, token, vault.id, [
      { fileId: 'file-1', path: 'Note.md', content: 'one' },
      { fileId: 'file-2', path: 'NOTE.md', content: 'two' },
    ]);
    const response = await app.request(
      `/api/v1/vaults/${vault.id}/resolve?path=${encodeURIComponent('note.md')}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(409);
    const body = (await response.json()) as {
      error: { code: string };
      candidates: Array<{ fileId: string }>;
    };
    expect(body.error.code).toBe('AMBIGUOUS_PATH');
    expect(body.candidates.map((candidate) => candidate.fileId).sort()).toEqual([
      'file-1',
      'file-2',
    ]);
  });

  it('resolves renamed files through history and reports the move', async () => {
    const { app, token, vault } = await setup();
    await commitEntries(app, token, vault.id, [
      { fileId: 'file-1', path: 'Old.md', content: 'hi' },
    ]);
    await commitEntries(app, token, vault.id, [
      { fileId: 'file-1', path: 'New.md', content: 'hi' },
    ]);
    const response = await app.request(
      `/api/v1/vaults/${vault.id}/resolve?path=${encodeURIComponent('Old.md')}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      match: string;
      canonicalPath: string;
      movedFromPath?: string;
      movedAtRevision?: number;
    };
    expect(body.match).toBe('historic');
    expect(body.canonicalPath).toBe('New.md');
    expect(body.movedFromPath).toBe('Old.md');
    expect(typeof body.movedAtRevision).toBe('number');
  });

  it('prefers a live occupant over history', async () => {
    const { app, token, vault } = await setup();
    await commitEntries(app, token, vault.id, [
      { fileId: 'file-1', path: 'Old.md', content: 'first' },
    ]);
    await commitEntries(app, token, vault.id, [
      { fileId: 'file-1', path: 'New.md', content: 'first' },
      { fileId: 'file-2', path: 'Old.md', content: 'second' },
    ]);
    const response = await app.request(
      `/api/v1/vaults/${vault.id}/resolve?path=${encodeURIComponent('Old.md')}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { match: string; file: { fileId: string } };
    expect(body.match).toBe('exact');
    expect(body.file.fileId).toBe('file-2');
  });

  it('returns 410 FILE_DELETED for paths whose file is gone', async () => {
    const { app, token, vault } = await setup();
    await commitEntries(app, token, vault.id, [
      { fileId: 'file-1', path: 'Gone.md', content: 'bye' },
    ]);
    await commitEntries(app, token, vault.id, []);
    const response = await app.request(
      `/api/v1/vaults/${vault.id}/resolve?path=${encodeURIComponent('Gone.md')}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(response.status).toBe(410);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe(
      'FILE_DELETED',
    );
  });

  it('returns 404 for unknown paths and 400 for invalid paths', async () => {
    const { app, token, vault } = await setup();
    await commitEntries(app, token, vault.id, [
      { fileId: 'file-1', path: 'Note.md', content: 'hi' },
    ]);
    const missing = await app.request(
      `/api/v1/vaults/${vault.id}/resolve?path=${encodeURIComponent('Missing.md')}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(missing.status).toBe(404);
    const invalid = await app.request(
      `/api/v1/vaults/${vault.id}/resolve?path=${encodeURIComponent('../secret')}`,
      { headers: { authorization: `Bearer ${token}` } },
    );
    expect(invalid.status).toBe(400);
    expect(((await invalid.json()) as { error: { code: string } }).error.code).toBe('INVALID_PATH');
  });

  it('never writes the path to the access log', async () => {
    const { app, token, vault } = await setup();
    const secret = 'Personal/Therapy/2026-09-02.md';
    await commitEntries(app, token, vault.id, [
      { fileId: 'file-1', path: secret, content: 'private' },
    ]);
    const chunks: string[] = [];
    const original = process.stdout.write.bind(process.stdout);
    (process.stdout as unknown as { write: (chunk: string) => boolean }).write = ((
      chunk: unknown,
    ) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    try {
      const response = await app.request(
        `/api/v1/vaults/${vault.id}/resolve?path=${encodeURIComponent(secret)}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(200);
    } finally {
      process.stdout.write = original;
    }
    const text = chunks.join('');
    expect(text).not.toContain(secret);
    expect(text).not.toContain(encodeURIComponent(secret));
    const line = JSON.parse(text.trim().split('\n').at(-1)!) as Record<string, unknown>;
    expect(line).toMatchObject({ path_resolved: true, resolve_match: 'exact' });
  });
});

describe('graph payload v2', () => {
  async function seedGraphFixture() {
    const { app, token, vault, database, blobStore } = await setup();
    const entries = [
      {
        fileId: 'file-a',
        path: 'A.md',
        content: '[[B]] ![[img.png]] [[Missing Note]] #foo',
        kind: 'markdown' as const,
      },
      { fileId: 'file-b', path: 'B.md', content: '# B', kind: 'markdown' as const },
      { fileId: 'file-img', path: 'img.png', content: 'png-bytes', kind: 'attachment' as const },
    ];
    const files: SyncManifestEntry[] = [];
    for (const entry of entries) {
      const bytes = new TextEncoder().encode(entry.content);
      const hash = await sha256Hex(bytes);
      await app.request(`/api/v1/vaults/${vault.id}/blobs/${hash}`, {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${token}`,
          'x-tephra-blob-size': String(bytes.byteLength),
        },
        body: bytes,
      });
      files.push({
        fileId: entry.fileId,
        path: entry.path,
        hash,
        size: bytes.byteLength,
        mtime: 100,
        kind: entry.kind,
      });
    }
    const commit = await app.request(`/api/v1/vaults/${vault.id}/sync/commit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceId: 'device-1',
        manifestHash: await hashManifest(files),
        files,
      }),
    });
    expect(commit.status).toBe(200);

    // Seed the note index the way the indexer would. The in-memory stub
    // infers never-returning methods, so go through the repository type.
    const noteIndex = database.noteIndex as NoteIndexRepository;
    const meta = (fileId: string, title: string, tags: string[] = []): NoteMetadata => ({
      fileId,
      vaultId: vault.id,
      indexedBlobHash: 'h',
      title,
      frontmatter: {},
      headings: [],
      tags,
      blocks: [],
      indexedAt: 1,
    });
    noteIndex.listMetadata = async () => [meta('file-a', 'Alpha', ['foo']), meta('file-b', 'Beta')];
    const link = (overrides: Record<string, unknown>): NoteLink =>
      ({
        id: 'l',
        vaultId: vault.id,
        sourceFileId: 'file-a',
        rawText: '',
        linkPath: '',
        subpath: null,
        displayText: null,
        isEmbed: false,
        targetFileId: null,
        createdAt: 1,
        ...overrides,
      }) as NoteLink;
    noteIndex.listLinks = async () => [
      link({ id: 'l1', linkPath: 'B', targetFileId: 'file-b' }),
      link({ id: 'l2', linkPath: 'img.png', targetFileId: 'file-img', isEmbed: true }),
      link({ id: 'l3', linkPath: 'Missing Note' }),
      link({ id: 'l4', linkPath: 'Missing Note', sourceFileId: 'file-b' }),
    ];
    noteIndex.getState = async () => ({ vaultId: vault.id, indexedRevision: 1, lastError: null });
    return { app, token, vault, database, blobStore };
  }

  it('synthesizes attachment and tag nodes, never unresolved/external ones with index-based edges', async () => {
    const { app, token, vault } = await seedGraphFixture();
    const response = await app.request(`/api/v1/vaults/${vault.id}/graph`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('etag')).toBe('W/"1-1-graph-v3"');
    const body = (await response.json()) as {
      revision: number;
      truncated: boolean;
      nodes: { id: string; kind: string; path: string; tags: string[]; createdAt: number }[];
      edges: { s: number; t: number; count: number; embeds: number }[];
    };
    expect(body.revision).toBe(1);
    expect(body.truncated).toBe(false);
    const byId = new Map(body.nodes.map((node, index) => [node.id, { ...node, index }]));
    expect([...byId.keys()].sort()).toEqual(['file-a', 'file-b', 'file-img', 'tag:foo']);
    expect(byId.get('file-a')).toMatchObject({ kind: 'note', tags: ['foo'], createdAt: 100 });
    expect(byId.get('file-img')).toMatchObject({ kind: 'attachment', createdAt: 100 });
    expect(byId.get('tag:foo')).toMatchObject({ kind: 'tag', title: '#foo', createdAt: 100 });
    // Markdown nodes come first so trimming prefers them.
    expect(body.nodes.slice(0, 3).every((node) => node.kind !== 'tag')).toBe(true);
    const edge = (a: string, b: string) =>
      body.edges.find((item) => item.s === byId.get(a)!.index && item.t === byId.get(b)!.index);
    expect(edge('file-a', 'file-b')).toMatchObject({ count: 1, embeds: 0 });
    expect(edge('file-a', 'file-img')).toMatchObject({ count: 1, embeds: 1 });
    expect(edge('file-a', 'tag:foo')).toMatchObject({ count: 1, embeds: 0 });
    for (const item of body.edges) {
      expect(item.s).toBeLessThan(body.nodes.length);
      expect(item.t).toBeLessThan(body.nodes.length);
    }
  });

  it('answers 304 when the vault and index revisions are unchanged', async () => {
    const { app, token, vault } = await seedGraphFixture();
    const first = await app.request(`/api/v1/vaults/${vault.id}/graph`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const etag = first.headers.get('etag')!;
    const second = await app.request(`/api/v1/vaults/${vault.id}/graph`, {
      headers: { authorization: `Bearer ${token}`, 'if-none-match': etag },
    });
    expect(second.status).toBe(304);
    // A newer index revision invalidates the cached payload.
    const third = await app.request(`/api/v1/vaults/${vault.id}/graph`, {
      headers: { authorization: `Bearer ${token}`, 'if-none-match': 'W/"1-0-graph-v3"' },
    });
    expect(third.status).toBe(200);
  });

  it('serves the cached payload without touching the index tables on a hit', async () => {
    const { app, token, vault, database } = await seedGraphFixture();
    const url = `/api/v1/vaults/${vault.id}/graph`;
    const first = await app.request(url, { headers: { authorization: `Bearer ${token}` } });
    expect(first.status).toBe(200);
    expect(first.headers.get('etag')).toBe('W/"1-1-graph-v3"');
    const firstBody = await first.json();
    expect(await database.graphCache.find(vault.id)).toMatchObject({
      revision: 1,
      indexedRevision: 1,
    });
    // Break the underlying reads: any index fan-out now fails the request,
    // so a 200 with an identical body proves the cache served it.
    const noteIndex = database.noteIndex as NoteIndexRepository;
    noteIndex.listMetadata = async () => {
      throw new Error('must not query note_metadata on a hit');
    };
    noteIndex.listLinks = async () => {
      throw new Error('must not query note_links on a hit');
    };
    const second = await app.request(url, { headers: { authorization: `Bearer ${token}` } });
    expect(second.status).toBe(200);
    expect(second.headers.get('etag')).toBe('W/"1-1-graph-v3"');
    expect(await second.json()).toEqual(firstBody);
  });

  it('rewrites the cache after indexVault and drops it when indexing fails', async () => {
    const { app, token, vault, database, blobStore } = await seedGraphFixture();
    const url = `/api/v1/vaults/${vault.id}/graph`;
    const first = await app.request(url, { headers: { authorization: `Bearer ${token}` } });
    expect(first.status).toBe(200);
    expect(await first.json()).not.toEqual(
      expect.objectContaining({
        nodes: expect.arrayContaining([expect.objectContaining({ id: 'tag:bar' })]),
      }),
    );

    let nextId = 0;
    const indexService = createRuntimeIndexService({
      database,
      blobStore,
      clock: { now: () => 1_700_000_000_001 },
      ids: { generate: () => `link-${++nextId}` },
    });
    const indexVault = indexService.indexVault;
    expect(indexVault).toBeDefined();
    const noteIndex = database.noteIndex as NoteIndexRepository;
    const meta = (fileId: string, title: string, tags: string[] = []): NoteMetadata => ({
      fileId,
      vaultId: vault.id,
      indexedBlobHash: 'h',
      title,
      frontmatter: {},
      headings: [],
      tags,
      blocks: [],
      indexedAt: 1,
    });
    // Evolve the indexed metadata, then reindex: the served graph follows.
    noteIndex.listMetadata = async () => [
      meta('file-a', 'Alpha', ['foo', 'bar']),
      meta('file-b', 'Beta'),
    ];
    await indexVault!(vault.id, 1);
    const second = await app.request(url, { headers: { authorization: `Bearer ${token}` } });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { nodes: { id: string }[] };
    expect(secondBody.nodes.map((node) => node.id)).toContain('tag:bar');

    // Drop every blob so indexing fails: the stale row must be deleted and
    // the next request must rebuild from the index tables instead.
    blobStore.values.clear();
    await expect(indexVault!(vault.id, 1)).rejects.toThrow();
    expect(await database.graphCache.find(vault.id)).toBeNull();
    const third = await app.request(url, { headers: { authorization: `Bearer ${token}` } });
    expect(third.status).toBe(200);
    expect(await database.graphCache.find(vault.id)).toMatchObject({
      revision: 1,
      indexedRevision: 1,
    });
  });
});
