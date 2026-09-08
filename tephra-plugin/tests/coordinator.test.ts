import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { TephraHttpError } from '../src/api/client';
import { SyncCoordinator } from '../src/sync/coordinator';
import { defaultState } from '../src/state/plugin-state';

const hash = 'a'.repeat(64);
const fileA = {
  fileId: 'file_1',
  path: 'a.md',
  hash,
  size: 4,
  mtime: 1,
  kind: 'markdown' as const,
};

function configuredState() {
  const state = defaultState();
  Object.assign(state.settings, {
    serverUrl: 'https://example.test',
    vaultId: 'vault',
    uploadToken: 'secret',
    deviceId: 'device',
  });
  return state;
}

function idMap(files: Array<{ path: string; fileId: string }>): Map<string, string> {
  return new Map(files.map((file) => [file.path, file.fileId]));
}

interface MockFile {
  fileId: string;
  path: string;
  hash: string;
  size: number;
  mtime: number;
  kind: 'markdown' | 'attachment';
}

function mockScanner(
  files: MockFile[],
  overrides?: {
    identityChanged?: string[];
    sidecarUpdates?: Map<string, string>;
    reResolved?: { files: MockFile[]; identityChanged: string[]; sidecarUpdates: Map<string, string> };
  },
) {
  return {
    identityMode: 'sidecar',
    vaultId: 'vault',
    scan: vi.fn(async () => ({
      files,
      identityChanged: overrides?.identityChanged ?? [],
      sidecarUpdates: overrides?.sidecarUpdates ?? idMap(files),
    })),
    resolveWithServerPrev: vi.fn(async () => ({
      files: overrides?.reResolved?.files ?? files,
      identityChanged: overrides?.reResolved?.identityChanged ?? [],
      sidecarUpdates: overrides?.reResolved?.sidecarUpdates ?? idMap(overrides?.reResolved?.files ?? files),
    })),
  };
}

function mockClient(overrides?: {
  planImpl?: (body: unknown) => Promise<unknown>;
  commitImpl?: (body: unknown) => Promise<unknown>;
  serverFiles?: Array<{ fileId: string; path: string; blobHash: string; size: number; mtime: number; kind: 'markdown' | 'attachment' }>;
}) {
  return {
    plan: vi.fn(
      overrides?.planImpl ??
        (async () => ({ status: 'up-to-date' as const, latestRevision: 7, missingBlobs: [] })),
    ),
    uploadBlob: vi.fn(),
    commit: vi.fn(
      overrides?.commitImpl ?? (async () => ({ status: 'committed' as const, revision: 8 })),
    ),
    listFiles: vi.fn(async () => ({
      revision: 7,
      files:
        overrides?.serverFiles ??
        [{ fileId: 'file_1', path: 'a.md', blobHash: hash, size: 4, mtime: 1, kind: 'markdown' as const }],
    })),
    resolve: vi.fn(),
  };
}

function setup(
  files: MockFile[],
  options?: {
    state?: ReturnType<typeof configuredState>;
    scannerOverrides?: Parameters<typeof mockScanner>[1];
    clientOverrides?: Parameters<typeof mockClient>[0];
    storeIds?: Map<string, string>;
  },
) {
  const state = options?.state ?? configuredState();
  const scanner = mockScanner(files, options?.scannerOverrides);
  const client = mockClient(options?.clientOverrides);
  const identitySave = vi.fn(async () => undefined);
  const storeIds = options?.storeIds ?? idMap(files);
  const saveState = vi.fn(async () => undefined);
  const statuses: Array<{ phase: string; message: string }> = [];
  const coordinator = new SyncCoordinator({
    app: {} as never,
    state,
    scanner: scanner as never,
    saveState,
    setStatus: (status) => statuses.push(status as { phase: string; message: string }),
    clientFactory: () => client as never,
    identityStore: { ids: storeIds, save: identitySave },
  });
  return { state, scanner, client, identitySave, storeIds, saveState, statuses, coordinator };
}

describe('SyncCoordinator', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('steady state: no listFiles, no commit, no sidecar write', async () => {
    const state = configuredState();
    state.manifest = { 'a.md': fileA };
    state.lastRemoteRevision = 7;
    const { coordinator, client, identitySave, saveState, statuses } = setup([fileA], { state });
    await coordinator.requestSync();
    expect(client.listFiles).not.toHaveBeenCalled();
    expect(client.commit).not.toHaveBeenCalled();
    expect(identitySave).not.toHaveBeenCalled();
    expect(state.manifest['a.md']?.fileId).toBe('file_1');
    expect(state.lastRemoteRevision).toBe(7);
    expect(saveState).toHaveBeenCalled();
    expect(statuses.at(-1)?.phase).toBe('success');
  });

  it('repairs when plan.latestRevision moved past lastRemoteRevision', async () => {
    const state = configuredState();
    state.manifest = { 'a.md': fileA };
    state.lastRemoteRevision = 7;
    const { coordinator, client, scanner, identitySave } = setup([fileA], {
      state,
      clientOverrides: {
        planImpl: (() => {
          let calls = 0;
          return async () => {
            calls += 1;
            if (calls === 1) return { status: 'up-to-date' as const, latestRevision: 8, missingBlobs: [] };
            return { status: 'up-to-date' as const, latestRevision: 8, missingBlobs: [] };
          };
        })(),
      },
    });
    await coordinator.requestSync();
    expect(client.listFiles).toHaveBeenCalledTimes(1);
    expect(scanner.resolveWithServerPrev).toHaveBeenCalledTimes(1);
    expect(client.plan).toHaveBeenCalledTimes(2);
    expect(client.commit).not.toHaveBeenCalled();
    expect(state.lastRemoteRevision).toBe(8);
    expect(identitySave).not.toHaveBeenCalled(); // resolved map unchanged
  });

  it('self-heals a DUPLICATE_FILE_ID commit with one repair retry', async () => {
    const state = configuredState();
    state.lastRemoteRevision = 3;
    const commitImpl = (() => {
      let calls = 0;
      return async () => {
        calls += 1;
        if (calls === 1) throw new TephraHttpError(400, 'Request validation failed. (DUPLICATE_FILE_ID)');
        return { status: 'committed' as const, revision: 4 };
      };
    })();
    const { coordinator, client } = setup([fileA], {
      state,
      clientOverrides: {
        planImpl: async () => ({ status: 'upload-required' as const, latestRevision: 3, missingBlobs: [] }),
        commitImpl,
      },
    });
    await coordinator.requestSync();
    expect(client.commit).toHaveBeenCalledTimes(2);
    expect(client.listFiles).toHaveBeenCalledTimes(1);
    expect(state.lastRemoteRevision).toBe(4);
    expect(state.manifest['a.md']?.fileId).toBe('file_1');
  });

  it('writes the sidecar only when the map changes', async () => {
    const state = configuredState();
    state.lastRemoteRevision = 7;
    const storeIds = new Map<string, string>();
    const first = setup([fileA], { state, storeIds });
    await first.coordinator.requestSync();
    expect(first.identitySave).toHaveBeenCalledTimes(1);
    expect(storeIds.get('a.md')).toBe('file_1');

    const second = setup([fileA], { state, storeIds });
    await second.coordinator.requestSync();
    expect(second.identitySave).not.toHaveBeenCalled();
  });

  it('offline with no sidecar performs no commit and no persist', async () => {
    const state = configuredState();
    state.identityRepairNeeded = true;
    const { coordinator, client, identitySave, saveState, statuses } = setup([fileA], {
      state,
      storeIds: new Map(),
      clientOverrides: {
        planImpl: async () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    await coordinator.requestSync();
    expect(client.commit).not.toHaveBeenCalled();
    expect(client.listFiles).not.toHaveBeenCalled();
    expect(identitySave).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
    expect(state.manifest['a.md']).toBeUndefined();
    expect(statuses.at(-1)?.phase).toBe('needs-identity-repair');
  });

  it('keeps pendingRenames durable across a simulated restart and clears them on commit', async () => {
    const state = configuredState();
    state.manifest = {
      'old.png': { fileId: 'attachment-id', path: 'old.png', hash, size: 1, mtime: 1, kind: 'attachment' as const },
    };
    state.lastRemoteRevision = 7;
    const renamed = {
      fileId: 'attachment-id',
      path: 'new.png',
      hash,
      size: 1,
      mtime: 1,
      kind: 'attachment' as const,
    };
    // The rename lands while offline, so the hint is stored durably but no sync clears it.
    const offline = setup([renamed], {
      state,
      clientOverrides: {
        planImpl: async () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    await expect(
      offline.coordinator.handleEvents([{ type: 'rename', oldPath: 'old.png', path: 'new.png' }]),
    ).rejects.toThrow('fetch failed');
    expect(state.pendingRenames).toEqual([['old.png', 'new.png']]);
    expect(offline.saveState).toHaveBeenCalled();
    // Simulated restart: a fresh coordinator over the same persisted state.
    const { coordinator } = setup([renamed], { state });
    expect(state.pendingRenames).toEqual([['old.png', 'new.png']]);
    const restarted = setup([renamed], { state });
    expect(restarted.state.pendingRenames).toEqual([['old.png', 'new.png']]);
    await restarted.coordinator.requestSync();
    expect(restarted.state.manifest['new.png']?.fileId).toBe('attachment-id');
    expect(restarted.state.pendingRenames).toEqual([]);
  });

  it('collapses rename chains in pendingRenames', async () => {
    const state = configuredState();
    const { coordinator } = setup([fileA], {
      state,
      clientOverrides: {
        planImpl: async () => {
          throw new TypeError('fetch failed');
        },
      },
    });
    // Offline so each sync fails and the hints accumulate instead of clearing.
    await expect(
      coordinator.handleEvents([{ type: 'rename', oldPath: 'a.md', path: 'b.md' }]),
    ).rejects.toThrow('fetch failed');
    await expect(
      coordinator.handleEvents([{ type: 'rename', oldPath: 'b.md', path: 'c.md' }]),
    ).rejects.toThrow('fetch failed');
    expect(state.pendingRenames).toEqual([['a.md', 'c.md']]);
  });

  it('blocks identity churn above the guard threshold and allows once when flagged', async () => {
    const files = Array.from({ length: 30 }, (_, index) => ({
      fileId: `file_new_${String(index)}`,
      path: `n${String(index)}.md`,
      hash,
      size: 1,
      mtime: 1,
      kind: 'markdown' as const,
    }));
    const changed = files.map((file) => file.path);
    const state = configuredState();
    state.lastRemoteRevision = 7;
    const reResolved = { files, identityChanged: changed, sidecarUpdates: idMap(files) };
    const blocked = setup(files, {
      state,
      scannerOverrides: { identityChanged: changed, reResolved },
      clientOverrides: {
        planImpl: async () => ({ status: 'up-to-date' as const, latestRevision: 8, missingBlobs: [] }),
      },
    });
    await expect(blocked.coordinator.requestSync()).rejects.toThrow(/churn guard/);
    expect(blocked.client.commit).not.toHaveBeenCalled();
    expect(blocked.statuses.at(-1)?.phase).toBe('error');

    const allowed = setup(files, {
      state,
      scannerOverrides: { identityChanged: changed, reResolved },
      clientOverrides: {
        planImpl: async () => ({ status: 'up-to-date' as const, latestRevision: 8, missingBlobs: [] }),
      },
    });
    allowed.coordinator.allowIdentityChurnOnce = true;
    await allowed.coordinator.requestSync();
    expect(allowed.client.commit).not.toHaveBeenCalled();
    expect(allowed.statuses.at(-1)?.phase).toBe('success');
    expect(allowed.coordinator.allowIdentityChurnOnce).toBe(false);
  });

  it('does not commit or advance the manifest after a failed upload', async () => {
    const state = configuredState();
    state.lastRemoteRevision = 3;
    const next = { ...fileA, hash: 'b'.repeat(64), mtime: 2 };
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
      listFiles: vi.fn(),
      resolve: vi.fn(),
    };
    const app = {
      vault: {
        getAbstractFileByPath: () => ({ extension: 'md' }),
        read: async () => 'hello',
      },
    };
    const coordinator = new SyncCoordinator({
      app: app as never,
      state,
      scanner: {
        identityMode: 'sidecar',
        vaultId: 'vault',
        scan: async () => ({ files: [next], identityChanged: [], sidecarUpdates: idMap([next]) }),
        resolveWithServerPrev: vi.fn(),
      } as never,
      saveState: async () => undefined,
      setStatus: () => undefined,
      clientFactory: () => client as never,
      identityStore: { ids: idMap([fileA]), save: vi.fn() },
    });
    await expect(coordinator.requestSync()).rejects.toThrow('upload failed');
    expect(client.uploadBlob).toHaveBeenCalledTimes(3);
    expect(client.commit).not.toHaveBeenCalled();
    expect(state.manifest['a.md']).toBeUndefined();
    expect(state.lastSuccessfulSyncAt).toBeUndefined();
  });

  it('does nothing and sets disabled status when enableSync is false', async () => {
    const state = configuredState();
    state.settings.enableSync = false;
    const client = mockClient();
    const statuses: unknown[] = [];
    const coordinator = new SyncCoordinator({
      app: {} as never,
      state,
      scanner: { scan: vi.fn() } as never,
      saveState: async () => undefined,
      setStatus: (s) => statuses.push(s),
      clientFactory: () => client as never,
    });
    await coordinator.requestSync();
    expect(client.plan).not.toHaveBeenCalled();
    expect(statuses).toHaveLength(1);
    expect((statuses[0] as { phase: string }).phase).toBe('disabled');
  });
});
