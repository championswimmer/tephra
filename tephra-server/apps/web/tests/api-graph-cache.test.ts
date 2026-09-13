import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GraphResponse } from '../src/api/types';

vi.mock('../src/api/graphCache', () => ({
  loadGraphCache: vi.fn(),
  saveGraphCache: vi.fn(),
  clearGraphCache: vi.fn(),
}));

import { ApiClient } from '../src/api/client';
import { clearGraphCache, loadGraphCache, saveGraphCache } from '../src/api/graphCache';

const bodyFixture: GraphResponse = {
  revision: 3,
  truncated: false,
  nodes: [{ id: 'a', path: 'a.md', title: 'Alpha', kind: 'note', tags: [], createdAt: 1 }],
  edges: [],
};

function jsonResponse(body: unknown, etag?: string): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: (name: string) => (name.toLowerCase() === 'etag' ? (etag ?? null) : null) },
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

function notModifiedResponse(): Response {
  return {
    ok: false,
    status: 304,
    headers: { get: () => null },
    json: () => Promise.reject(new Error('304 carries no body')),
  } as unknown as Response;
}

function sentHeader(name: string, callIndex = 0): string | null {
  const init = vi.mocked(fetch).mock.calls[callIndex]?.[1] as RequestInit | undefined;
  const headers = init?.headers;
  // fetchRaw() wraps init headers in a real Headers instance.
  if (headers instanceof Headers) return headers.get(name);
  return (headers as Record<string, string> | undefined)?.[name] ?? null;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', vi.fn());
  vi.mocked(loadGraphCache).mockResolvedValue(null);
  vi.mocked(saveGraphCache).mockResolvedValue(undefined);
  vi.mocked(clearGraphCache).mockResolvedValue(undefined);
});

describe('ApiClient.graph IndexedDB persistence', () => {
  it('persists every 200 response and sends no validator on a cold load', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(bodyFixture, 'W/"3"'));
    const result = await new ApiClient().graph('vault-1');

    expect(result).toEqual(bodyFixture);
    expect(sentHeader('If-None-Match', 0)).toBeNull();
    expect(vi.mocked(saveGraphCache)).toHaveBeenCalledWith('vault-1', {
      etag: 'W/"3"',
      body: bodyFixture,
    });
  });

  it('hydrates from IndexedDB on a fresh instance so reloads get a 304', async () => {
    const cached = { etag: 'W/"3"', body: bodyFixture, savedAt: 1 };
    vi.mocked(loadGraphCache).mockResolvedValue(cached);
    vi.mocked(fetch).mockResolvedValue(notModifiedResponse());

    const result = await new ApiClient().graph('vault-1');

    expect(result).toBe(bodyFixture);
    expect(vi.mocked(loadGraphCache)).toHaveBeenCalledWith('vault-1');
    expect(sentHeader('If-None-Match', 0)).toBe('W/"3"');
    // A 304 reuses the payload — nothing new to persist.
    expect(vi.mocked(saveGraphCache)).not.toHaveBeenCalled();
  });

  it('clears the persisted row when a 200 carries no ETag', async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse(bodyFixture));
    const client = new ApiClient();
    await client.graph('vault-1');

    expect(vi.mocked(saveGraphCache)).not.toHaveBeenCalled();
    expect(vi.mocked(clearGraphCache)).toHaveBeenCalledWith('vault-1');

    // The in-memory entry is gone too, so the next call sends no validator.
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(bodyFixture));
    await client.graph('vault-1');
    expect(sentHeader('If-None-Match', 1)).toBeNull();
  });

  it('degrades to network-only when hydration fails', async () => {
    vi.mocked(loadGraphCache).mockRejectedValue(new Error('IDB exploded'));
    vi.mocked(fetch).mockResolvedValue(jsonResponse(bodyFixture, 'W/"3"'));

    const result = await new ApiClient().graph('vault-1');

    expect(result).toEqual(bodyFixture);
    expect(sentHeader('If-None-Match', 0)).toBeNull();
  });

  it('shares one hydration across concurrent calls', async () => {
    let release!: (value: { etag: string; body: GraphResponse; savedAt: number } | null) => void;
    vi.mocked(loadGraphCache).mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      }),
    );
    vi.mocked(fetch).mockResolvedValue(jsonResponse(bodyFixture, 'W/"3"'));

    const client = new ApiClient();
    const first = client.graph('vault-1');
    const second = client.graph('vault-1');
    release(null);
    await expect(first).resolves.toEqual(bodyFixture);
    await expect(second).resolves.toEqual(bodyFixture);
    expect(vi.mocked(loadGraphCache)).toHaveBeenCalledTimes(1);
  });
});
