import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { SyncCoordinator } from '../src/sync/coordinator';
import { defaultState } from '../src/state/plugin-state';

const hash = 'a'.repeat(64);
const oldEntry = {
  fileId: 'attachment-id',
  path: 'old.png',
  hash,
  size: 1,
  mtime: 1,
  kind: 'attachment' as const,
};

function configuredState() {
  const state = defaultState();
  Object.assign(state.settings, {
    serverUrl: 'https://example.test',
    vaultId: 'vault',
    uploadToken: 'secret',
    deviceId: 'device',
  });
  state.manifest = { 'old.png': oldEntry };
  state.attachmentIds = { 'old.png': oldEntry.fileId };
  return state;
}

describe('SyncCoordinator', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('preserves attachment identity across rename reconciliation', async () => {
    const state = configuredState();
    const scan = vi.fn(
      async (previous: Record<string, typeof oldEntry>, attachmentIds: Record<string, string>) => {
        expect(previous['new.png']?.fileId).toBe('attachment-id');
        expect(previous['old.png']).toBeUndefined();
        expect(attachmentIds['new.png']).toBe('attachment-id');
        const renamed = { ...oldEntry, path: 'new.png' };
        return { files: [renamed], attachmentIds: { 'new.png': 'attachment-id' } };
      },
    );
    const client = {
      plan: vi.fn(async () => ({
        status: 'up-to-date' as const,
        latestRevision: 7,
        missingBlobs: [],
      })),
      uploadBlob: vi.fn(),
      commit: vi.fn(),
    };
    const coordinator = new SyncCoordinator({
      app: {} as never,
      state,
      scanner: { scan } as never,
      saveState: async () => undefined,
      setStatus: () => undefined,
      clientFactory: () => client,
    });
    await coordinator.handleEvents([{ type: 'rename', oldPath: 'old.png', path: 'new.png' }]);
    expect(state.manifest['new.png']?.fileId).toBe('attachment-id');
    expect(state.manifest['old.png']).toBeUndefined();
    expect(client.commit).not.toHaveBeenCalled();
  });

  it('does not commit or advance the manifest after a failed upload', async () => {
    const state = configuredState();
    const next = { ...oldEntry, hash: 'b'.repeat(64), mtime: 2 };
    const client = {
      plan: vi.fn(async () => ({
        status: 'upload-required' as const,
        latestRevision: 3,
        missingBlobs: [{ hash: next.hash, size: 1 }],
      })),
      uploadBlob: vi.fn(async () => {
        throw new Error('upload failed');
      }),
      commit: vi.fn(),
    };
    const app = {
      vault: {
        getAbstractFileByPath: () => ({ extension: 'png' }),
        readBinary: async () => new Uint8Array([1]).buffer,
      },
    };
    const coordinator = new SyncCoordinator({
      app: app as never,
      state,
      scanner: {
        scan: async () => ({ files: [next], attachmentIds: state.attachmentIds }),
      } as never,
      saveState: async () => undefined,
      setStatus: () => undefined,
      clientFactory: () => client,
    });
    await expect(coordinator.requestSync()).rejects.toThrow('upload failed');
    expect(client.uploadBlob).toHaveBeenCalledTimes(3);
    expect(client.commit).not.toHaveBeenCalled();
    expect(state.manifest['old.png']?.hash).toBe(hash);
    expect(state.lastSuccessfulSyncAt).toBeUndefined();
  });
});
