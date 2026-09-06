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
