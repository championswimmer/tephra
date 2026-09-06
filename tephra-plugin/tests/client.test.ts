import type { RequestUrlParam } from 'obsidian';
import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION } from '@tephra/protocol';
import { PLUGIN_VERSION, TephraClient } from '../src/api/client';

class CapturingClient extends TephraClient {
  public captured: RequestUrlParam[] = [];
  public fakeJson: unknown = { status: 'up-to-date', latestRevision: 0, missingBlobs: [] };

  protected async request(options: RequestUrlParam): Promise<never> {
    this.captured.push(options);
    return {
      status: 200,
      text: JSON.stringify(this.fakeJson),
      json: this.fakeJson,
    } as unknown as never;
  }
}

function headersOf(client: CapturingClient, index: number): Record<string, string> {
  const headers = client.captured[index]?.headers;
  expect(headers).toBeDefined();
  return headers as Record<string, string>;
}

describe('TephraClient version headers', () => {
  it('sends plugin and protocol versions on sync plan and commit', async () => {
    const client = new CapturingClient('https://example.test', 'vault-1', 'token-1');
    const body = {
      deviceId: 'device-1',
      manifestHash: 'a'.repeat(64),
      files: [],
    };
    await client.plan(body);
    client.fakeJson = { status: 'up-to-date', revision: 1 };
    await client.commit(body);

    expect(client.captured).toHaveLength(2);
    for (const index of [0, 1]) {
      const headers = headersOf(client, index);
      expect(headers['X-Tephra-Plugin-Version']).toBe(PLUGIN_VERSION);
      expect(headers['X-Tephra-Protocol-Version']).toBe(PROTOCOL_VERSION);
      expect(headers.Authorization).toBe('Bearer token-1');
    }
  });

  it('sends plugin and protocol versions on blob upload', async () => {
    const client = new CapturingClient('https://example.test', 'vault-1', 'token-1');
    const hash = 'b'.repeat(64);
    client.fakeJson = { hash, stored: true };
    await client.uploadBlob(hash, new Uint8Array([1, 2, 3]));

    expect(client.captured).toHaveLength(1);
    const headers = headersOf(client, 0);
    expect(headers['X-Tephra-Plugin-Version']).toBe(PLUGIN_VERSION);
    expect(headers['X-Tephra-Protocol-Version']).toBe(PROTOCOL_VERSION);
  });
});

describe('TephraClient auth and vault management', () => {
  it('tests connection against healthz', async () => {
    const client = new CapturingClient('https://example.test');
    client.fakeJson = { status: 'ok' };
    const res = await client.testConnection();
    expect(res.ok).toBe(true);
    expect(client.captured[0]?.url).toBe('https://example.test/healthz');
  });

  it('logs in and returns user and session token', async () => {
    const client = new CapturingClient('https://example.test');
    client.fakeJson = { user: { id: 'user-1', email: 'me@example.com' }, sessionToken: 'tps_abc' };
    const res = await client.login('me@example.com', 'password123');
    expect(res.user.email).toBe('me@example.com');
    expect(res.sessionToken).toBe('tps_abc');
    expect(client.captured[0]?.url).toBe('https://example.test/api/v1/auth/login');
    expect(client.captured[0]?.method).toBe('POST');
  });

  it('lists vaults with session token bearer', async () => {
    const client = new CapturingClient('https://example.test');
    client.fakeJson = {
      vaults: [{ id: 'v1', name: 'Notes', latestRevision: 4, createdAt: 100, updatedAt: 200 }],
    };
    const vaults = await client.listVaults('tps_session');
    expect(vaults).toHaveLength(1);
    expect(vaults[0]?.name).toBe('Notes');
    expect(client.captured[0]?.headers?.Authorization).toBe('Bearer tps_session');
    expect(client.captured[0]?.url).toBe('https://example.test/api/v1/vaults');
  });

  it('creates vault with session token', async () => {
    const client = new CapturingClient('https://example.test');
    client.fakeJson = {
      vault: { id: 'v2', name: 'Work', latestRevision: 0, createdAt: 100, updatedAt: 100 },
    };
    const vault = await client.createVault('Work', 'tps_session');
    expect(vault.id).toBe('v2');
    expect(client.captured[0]?.headers?.Authorization).toBe('Bearer tps_session');
    expect(client.captured[0]?.body).toBe(JSON.stringify({ name: 'Work' }));
  });

  it('provisions vault token with session token', async () => {
    const client = new CapturingClient('https://example.test');
    client.fakeJson = {
      token: {
        id: 'tok-1',
        userId: 'u1',
        vaultId: 'v1',
        deviceId: 'dev-1',
        name: 'Obsidian (Mac)',
        scopes: ['vault:read-metadata', 'vault:upload'],
        createdAt: 100,
      },
      value: 'tpt_token123',
    };
    const res = await client.provisionVaultToken(
      'v1',
      { name: 'Obsidian (Mac)', deviceId: 'dev-1', deviceName: 'Mac' },
      'tps_session',
    );
    expect(res.value).toBe('tpt_token123');
    expect(client.captured[0]?.url).toBe('https://example.test/api/v1/vaults/v1/tokens');
    expect(client.captured[0]?.headers?.Authorization).toBe('Bearer tps_session');
  });

  it('logs out using session token', async () => {
    const client = new CapturingClient('https://example.test');
    client.fakeJson = { ok: true };
    await client.logout('tps_session');
    expect(client.captured[0]?.url).toBe('https://example.test/api/v1/auth/logout');
    expect(client.captured[0]?.headers?.Authorization).toBe('Bearer tps_session');
  });
});
