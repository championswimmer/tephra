import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
  requestUrl: vi.fn(),
}));

import { TephraHttpError } from '../src/api/client';
import { defaultState, type TephraPluginState } from '../src/state/plugin-state';
import { sha256Hex } from '../src/sync/hasher';
import type { PullVault } from '../src/sync/pull-vault';
import { pullRemoteChanges } from '../src/sync/puller';
import type { ChangeEntry, ChangesResponse } from '@tephra/protocol';

const DATE = '2026-01-02';
const encoder = new TextEncoder();

interface FakeStored {
  bytes: Uint8Array;
  mtime: number;
}

function extensionOf(path: string): string {
  const base = path.split('/').at(-1) ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(dot + 1) : '';
}

function createFakeVault(initial: Record<string, string> = {}) {
  const files = new Map<string, FakeStored>();
  for (const [path, text] of Object.entries(initial))
    files.set(path, { bytes: encoder.encode(text), mtime: 100 });
  const textWrites: Array<{ path: string; text: string }> = [];
  const binaryWrites: Array<{ path: string; bytes: Uint8Array }> = [];
  const removed: string[] = [];
  const renamed: Array<[string, string]> = [];
  const vault: PullVault = {
    getFile: (path) => {
      const file = files.get(path);
      return file
        ? { path, extension: extensionOf(path), size: file.bytes.byteLength, mtime: file.mtime }
        : null;
    },
    exists: (path) => files.has(path),
    readText: async (path) => {
      const file = files.get(path);
      if (!file) throw new Error(`missing: ${path}`);
      return new TextDecoder().decode(file.bytes);
    },
    readBinary: async (path) => {
      const file = files.get(path);
      if (!file) throw new Error(`missing: ${path}`);
      return file.bytes;
    },
    writeText: async (path, text) => {
      textWrites.push({ path, text });
      files.set(path, { bytes: encoder.encode(text), mtime: 999 });
    },
    writeBinary: async (path, bytes) => {
      binaryWrites.push({ path, bytes });
      files.set(path, { bytes, mtime: 999 });
    },
    remove: async (path) => {
      removed.push(path);
      files.delete(path);
    },
    rename: async (oldPath, newPath) => {
      renamed.push([oldPath, newPath]);
      const file = files.get(oldPath);
      if (!file) throw new Error(`missing: ${oldPath}`);
      files.delete(oldPath);
      files.set(newPath, file);
    },
  };
  return { vault, files, textWrites, binaryWrites, removed, renamed };
}

type ServerFile = { fileId: string; path: string; blobHash: string; kind: 'markdown' | 'attachment' };

function createFakeClient(options: {
  pages: ChangesResponse[];
  blobs?: Record<string, Uint8Array>;
  manifest?: ServerFile[];
}) {
  const sinceCalls: number[] = [];
  let pageIndex = 0;
  const client = {
    listFiles: vi.fn(async () => ({ revision: 9, files: options.manifest ?? [] })),
    changes: vi.fn(async (sinceRevision: number) => {
      sinceCalls.push(sinceRevision);
      const page = options.pages[pageIndex++];
      if (!page) throw new Error('unexpected extra changes call');
      return page;
    }),
    readContent: vi.fn(async (fileId: string) => {
      const blob = options.blobs?.[fileId];
      if (!blob) throw new TephraHttpError(404, 'missing blob');
      return blob;
    }),
  };
  return { client, sinceCalls };
}

function pullState(): TephraPluginState {
  const state = defaultState();
  Object.assign(state.settings, {
    serverUrl: 'https://example.test',
    vaultId: 'vault',
    uploadToken: 'secret',
    deviceId: 'device',
  });
  state.lastRemoteRevision = 7;
  state.lastPulledRevision = 7;
  return state;
}

function okPage(
  changes: ChangeEntry[],
  toRevision: number,
  truncated = false,
): ChangesResponse {
  return {
    status: 'ok',
    fromRevision: 7,
    toRevision,
    latestRevision: 9,
    truncated,
    changes,
  };
}

async function mdEntry(
  overrides: Partial<ChangeEntry> & { content?: string },
): Promise<ChangeEntry> {
  const { content, ...rest } = overrides;
  const bytes = encoder.encode(content ?? 'server text');
  return {
    fileId: 'file_1',
    changeType: 'create',
    path: 'new.md',
    blobHash: await sha256Hex(bytes),
    size: bytes.byteLength,
    mtime: 50,
    kind: 'markdown',
    revision: 8,
    ...rest,
  };
}

describe('pullRemoteChanges', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('skips entirely on first sync (no cursor yet)', async () => {
    const state = pullState();
    state.lastRemoteRevision = undefined;
    const { client } = createFakeClient({ pages: [] });
    const saveState = vi.fn(async () => undefined);
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState,
      vault: createFakeVault().vault,
    });
    expect(outcome).toEqual({ outcome: 'skipped-first-sync' });
    expect(client.listFiles).not.toHaveBeenCalled();
    expect(client.changes).not.toHaveBeenCalled();
    expect(saveState).not.toHaveBeenCalled();
  });

  it('creates a missing markdown file from server bytes and advances the cursor', async () => {
    const state = pullState();
    const fake = createFakeVault();
    const entry = await mdEntry({ content: 'hello server' });
    const { client, sinceCalls } = createFakeClient({
      pages: [okPage([entry], 8)],
      blobs: { file_1: encoder.encode('hello server') },
      manifest: [{ fileId: 'file_1', path: 'new.md', blobHash: entry.blobHash!, kind: 'markdown' }],
    });
    const saveState = vi.fn(async () => undefined);
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 1, toRevision: 8 });
    expect(fake.textWrites).toEqual([{ path: 'new.md', text: 'hello server' }]);
    expect(sinceCalls).toEqual([7]);
    expect(state.lastPulledRevision).toBe(8);
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(state.manifest['new.md']?.hash).toBe(entry.blobHash);
  });

  it('hash-equal entries just advance the cursor without writing', async () => {
    const state = pullState();
    const content = 'same everywhere';
    const bytes = encoder.encode(content);
    const fake = createFakeVault({ 'new.md': content });
    const entry = await mdEntry({ path: 'new.md', content });
    const { client } = createFakeClient({
      pages: [okPage([entry], 8)],
      blobs: { file_1: bytes },
    });
    const saveState = vi.fn(async () => undefined);
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 0, toRevision: 8 });
    expect(fake.textWrites).toEqual([]);
    expect(client.readContent).not.toHaveBeenCalled();
    expect(state.lastPulledRevision).toBe(8);
  });

  it('pull is hash-authoritative when mtimes lie (server older, hash differs)', async () => {
    const state = pullState();
    // Local file untouched since last sync (manifest baseline matches) but
    // the server moved on with an OLDER mtime — clock skew must not matter.
    const localBytes = encoder.encode('local v1');
    const localHash = await sha256Hex(localBytes);
    const fake = createFakeVault({ 'note.md': 'local v1' });
    fake.files.get('note.md')!.mtime = 9_999;
    state.manifest['note.md'] = {
      fileId: 'file_1',
      path: 'note.md',
      hash: localHash,
      size: localBytes.byteLength,
      mtime: 9_999,
      kind: 'markdown',
    };
    const entry = await mdEntry({
      fileId: 'file_1',
      changeType: 'modify',
      path: 'note.md',
      content: 'server v2',
      mtime: 10,
    });
    const { client } = createFakeClient({
      pages: [okPage([entry], 8)],
      blobs: { file_1: encoder.encode('server v2') },
    });
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 1, toRevision: 8 });
    expect(fake.textWrites).toEqual([{ path: 'note.md', text: 'server v2' }]);
  });

  it('writes a conflicted copy when the local file diverged', async () => {
    const state = pullState();
    const baseline = encoder.encode('baseline');
    state.manifest['note.md'] = {
      fileId: 'file_1',
      path: 'note.md',
      hash: await sha256Hex(baseline),
      size: baseline.byteLength,
      mtime: 100,
      kind: 'markdown',
    };
    const fake = createFakeVault({ 'note.md': 'local edits' });
    const entry = await mdEntry({
      fileId: 'file_1',
      changeType: 'modify',
      path: 'note.md',
      content: 'server v2',
    });
    const { client } = createFakeClient({
      pages: [okPage([entry], 8)],
      blobs: { file_1: encoder.encode('server v2') },
    });
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 1, toRevision: 8 });
    // Original untouched; server bytes land in the conflicted copy.
    expect(fake.files.get('note.md')).toBeDefined();
    expect(new TextDecoder().decode(fake.files.get('note.md')!.bytes)).toBe('local edits');
    expect(fake.textWrites).toEqual([
      { path: `note (server conflicted copy, ${DATE}).md`, text: 'server v2' },
    ]);
    expect(state.lastPulledRevision).toBe(8);
  });

  it('numbers conflicted copies when the name is taken, preserving attachment extensions', async () => {
    const state = pullState();
    state.manifest['img.png'] = {
      fileId: 'img_1',
      path: 'img.png',
      hash: '0'.repeat(64),
      size: 1,
      mtime: 100,
      kind: 'attachment',
    };
    const fake = createFakeVault({
      'img.png': 'local-bytes',
      [`img (server conflicted copy, ${DATE}).png`]: 'older conflict',
    });
    const serverBytes = new Uint8Array([9, 8, 7]);
    const entry: ChangeEntry = {
      fileId: 'img_1',
      changeType: 'modify',
      path: 'img.png',
      blobHash: await sha256Hex(serverBytes),
      size: serverBytes.byteLength,
      mtime: 50,
      kind: 'attachment',
      revision: 8,
    };
    const { client } = createFakeClient({
      pages: [okPage([entry], 8)],
      blobs: { img_1: serverBytes },
    });
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 1, toRevision: 8 });
    expect(fake.binaryWrites.map((write) => write.path)).toEqual([
      `img (server conflicted copy, ${DATE}) (2).png`,
    ]);
    expect(fake.binaryWrites[0]?.bytes).toEqual(serverBytes);
  });

  it('deletes only when the local hash matches the tombstoned blob', async () => {
    const state = pullState();
    const bytes = encoder.encode('doomed');
    const hash = await sha256Hex(bytes);
    state.manifest['gone.md'] = {
      fileId: 'file_1',
      path: 'gone.md',
      hash,
      size: bytes.byteLength,
      mtime: 100,
      kind: 'markdown',
    };
    const fake = createFakeVault({ 'gone.md': 'doomed' });
    const entry: ChangeEntry = {
      fileId: 'file_1',
      changeType: 'delete',
      path: 'gone.md',
      kind: 'markdown',
      revision: 8,
    };
    const { client } = createFakeClient({ pages: [okPage([entry], 8)] });
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 1, toRevision: 8 });
    expect(fake.removed).toEqual(['gone.md']);
    expect(client.readContent).not.toHaveBeenCalled();
    expect(state.manifest['gone.md']).toBeUndefined();
  });

  it('keeps a diverged file over a server delete (local wins)', async () => {
    const state = pullState();
    state.manifest['kept.md'] = {
      fileId: 'file_1',
      path: 'kept.md',
      hash: '0'.repeat(64),
      size: 1,
      mtime: 100,
      kind: 'markdown',
    };
    const fake = createFakeVault({ 'kept.md': 'local edits' });
    const entry: ChangeEntry = {
      fileId: 'file_1',
      changeType: 'delete',
      path: 'kept.md',
      kind: 'markdown',
      revision: 8,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = createFakeClient({ pages: [okPage([entry], 8)] });
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 0, toRevision: 8 });
    expect(fake.removed).toEqual([]);
    expect(fake.files.get('kept.md')).toBeDefined();
    expect(client.readContent).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('treats a missing local file as an already-applied delete', async () => {
    const state = pullState();
    const fake = createFakeVault();
    const entry: ChangeEntry = {
      fileId: 'file_1',
      changeType: 'delete',
      path: 'gone.md',
      kind: 'markdown',
      revision: 8,
    };
    const { client } = createFakeClient({ pages: [okPage([entry], 8)] });
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 0, toRevision: 8 });
    expect(fake.removed).toEqual([]);
    expect(client.readContent).not.toHaveBeenCalled();
  });

  it('resumes across truncated pages, persisting the cursor after each page', async () => {
    const state = pullState();
    const fake = createFakeVault();
    const first = await mdEntry({ fileId: 'file_1', path: 'one.md', content: 'one' });
    const second = await mdEntry({ fileId: 'file_2', path: 'two.md', content: 'two' });
    const { client, sinceCalls } = createFakeClient({
      pages: [
        { ...okPage([first], 8, true), latestRevision: 9 },
        okPage([second], 9),
      ],
      blobs: { file_1: encoder.encode('one'), file_2: encoder.encode('two') },
    });
    const saveState = vi.fn(async () => undefined);
    const seen: number[] = [];
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => {
        seen.push(state.lastPulledRevision ?? -1);
        await saveState();
      },
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 2, toRevision: 9 });
    expect(sinceCalls).toEqual([7, 8]);
    expect(seen).toEqual([8, 9]);
    expect(saveState).toHaveBeenCalledTimes(2);
    expect(state.lastPulledRevision).toBe(9);
  });

  it('falls back on full-resync-required without persisting the cursor', async () => {
    const state = pullState();
    const fake = createFakeVault();
    const { client } = createFakeClient({
      pages: [{ status: 'full-resync-required', latestRevision: 12 }],
    });
    const saveState = vi.fn(async () => undefined);
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'full-resync' });
    expect(state.identityRepairNeeded).toBe(true);
    expect(state.lastPulledRevision).toBe(7);
    expect(saveState).not.toHaveBeenCalled();
  });

  it('falls back to legacy reconcile when the server has no /changes route', async () => {
    const state = pullState();
    const fake = createFakeVault();
    const client = {
      listFiles: vi.fn(async () => ({ revision: 7, files: [] })),
      changes: vi.fn(async () => {
        throw new TephraHttpError(404, 'Unknown route. (NOT_FOUND)');
      }),
      readContent: vi.fn(),
    };
    const saveState = vi.fn(async () => undefined);
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'legacy' });
    expect(state.identityRepairNeeded).toBeUndefined();
    expect(state.lastPulledRevision).toBe(7);
    expect(saveState).not.toHaveBeenCalled();
  });

  it('applies a rename when the local file at the previous path is untouched', async () => {
    const state = pullState();
    const bytes = encoder.encode('renamed body');
    const hash = await sha256Hex(bytes);
    state.manifest['old.md'] = {
      fileId: 'file_1',
      path: 'old.md',
      hash,
      size: bytes.byteLength,
      mtime: 100,
      kind: 'markdown',
    };
    state.scanCache['old.md'] = { hash, size: bytes.byteLength, mtime: 100 };
    const fake = createFakeVault({ 'old.md': 'renamed body' });
    const entry: ChangeEntry = {
      fileId: 'file_1',
      changeType: 'rename',
      path: 'new.md',
      previousPath: 'old.md',
      blobHash: hash,
      size: bytes.byteLength,
      mtime: 60,
      kind: 'markdown',
      revision: 8,
    };
    const { client } = createFakeClient({ pages: [okPage([entry], 8)] });
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 1, toRevision: 8 });
    expect(fake.renamed).toEqual([['old.md', 'new.md']]);
    expect(client.readContent).not.toHaveBeenCalled();
    expect(state.manifest['old.md']).toBeUndefined();
    expect(state.manifest['new.md']?.hash).toBe(hash);
    expect(state.scanCache['old.md']).toBeUndefined();
    expect(state.scanCache['new.md']?.hash).toBe(hash);
  });

  it('creates at the new path when the rename source is missing locally', async () => {
    const state = pullState();
    const fake = createFakeVault();
    const entry = await mdEntry({
      fileId: 'file_1',
      changeType: 'rename',
      path: 'new.md',
      previousPath: 'old.md',
      content: 'arrived',
    });
    const { client } = createFakeClient({
      pages: [okPage([entry], 8)],
      blobs: { file_1: encoder.encode('arrived') },
    });
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 1, toRevision: 8 });
    expect(fake.textWrites).toEqual([{ path: 'new.md', text: 'arrived' }]);
  });

  it('skips non-canonical entry paths with a warning and no download', async () => {
    const state = pullState();
    const fake = createFakeVault();
    const entry = await mdEntry({ path: '../evil.md' });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { client } = createFakeClient({ pages: [okPage([entry], 8)] });
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 0, toRevision: 8 });
    expect(client.readContent).not.toHaveBeenCalled();
    expect(fake.textWrites).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('skips a blob hash mismatch with a warning and completes the sync', async () => {
    const state = pullState();
    const fake = createFakeVault();
    // Server still advertises the stale hash: retry once, then skip — the
    // vault is never written with unverified bytes and the sync completes.
    const entry = await mdEntry({ blobHash: 'f'.repeat(64), content: 'tampered' });
    const { client } = createFakeClient({
      pages: [okPage([entry], 8)],
      blobs: { file_1: encoder.encode('tampered') },
      manifest: [
        { fileId: 'file_1', path: 'new.md', blobHash: 'f'.repeat(64), kind: 'markdown' },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const saveState = vi.fn(async () => undefined);
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 0, toRevision: 8 });
    expect(fake.textWrites).toEqual([]);
    expect(client.readContent).toHaveBeenCalledTimes(2); // initial + one retry
    expect(warn).toHaveBeenCalled();
    expect(saveState).toHaveBeenCalledTimes(1);
    expect(state.lastPulledRevision).toBe(8);
  });

  it('skips a superseded entry when the server already moved on', async () => {
    const state = pullState();
    const fake = createFakeVault();
    // The changelog advertises a stale hash but /content already serves the
    // current server bytes: no retry, skip with a superseded warning.
    const currentBytes = encoder.encode('current server text');
    const currentHash = await sha256Hex(currentBytes);
    const entry = await mdEntry({ blobHash: 'f'.repeat(64), content: 'ignored' });
    const { client } = createFakeClient({
      pages: [okPage([entry], 8)],
      blobs: { file_1: currentBytes },
      manifest: [
        { fileId: 'file_1', path: 'new.md', blobHash: currentHash, kind: 'markdown' },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 0, toRevision: 8 });
    expect(fake.textWrites).toEqual([]);
    expect(client.readContent).toHaveBeenCalledTimes(1); // no retry when superseded
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('superseded'));
    expect(state.lastPulledRevision).toBe(8);
  });

  it('skips a mismatched entry for a file gone from the server', async () => {
    const state = pullState();
    const fake = createFakeVault();
    const entry = await mdEntry({ blobHash: 'f'.repeat(64), content: 'tampered' });
    const { client } = createFakeClient({
      pages: [okPage([entry], 8)],
      blobs: { file_1: encoder.encode('tampered') },
      manifest: [], // refresh shows the file is gone
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 0, toRevision: 8 });
    expect(fake.textWrites).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('gone from the server'));
    expect(state.lastPulledRevision).toBe(8);
  });

  it('applies later entries after skipping a mismatched one', async () => {
    const state = pullState();
    const fake = createFakeVault();
    const bad = await mdEntry({
      fileId: 'file_bad',
      path: 'bad.md',
      blobHash: 'f'.repeat(64),
      content: 'tampered',
    });
    const good = await mdEntry({ fileId: 'file_1', path: 'good.md', content: 'good bytes' });
    const { client } = createFakeClient({
      pages: [okPage([bad, good], 8)],
      blobs: { file_bad: encoder.encode('tampered'), file_1: encoder.encode('good bytes') },
      manifest: [
        { fileId: 'file_bad', path: 'bad.md', blobHash: 'f'.repeat(64), kind: 'markdown' },
        { fileId: 'file_1', path: 'good.md', blobHash: good.blobHash!, kind: 'markdown' },
      ],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 1, toRevision: 8 });
    expect(fake.textWrites).toEqual([{ path: 'good.md', text: 'good bytes' }]);
    expect(fake.files.has('bad.md')).toBe(false);
    expect(warn).toHaveBeenCalled();
    expect(state.lastPulledRevision).toBe(8);
  });

  it('still throws non-integrity download failures instead of skipping', async () => {
    const state = pullState();
    const fake = createFakeVault();
    const entry = await mdEntry({ content: 'server text' });
    const { client } = createFakeClient({ pages: [okPage([entry], 8)] });
    client.readContent = vi.fn(async () => {
      throw new TephraHttpError(500, 'Server exploded.');
    });
    const saveState = vi.fn(async () => undefined);
    await expect(
      pullRemoteChanges({
        app: {} as never,
        client: client as never,
        state,
        saveState,
        conflictedDate: DATE,
        vault: fake.vault,
      }),
    ).rejects.toThrow(/Server exploded/);
    expect(fake.textWrites).toEqual([]);
    expect(saveState).not.toHaveBeenCalled();
    expect(state.lastPulledRevision).toBe(7);
  });

  it('classifies by local extension over a conflicting entry kind', async () => {
    const state = pullState();
    // Server thinks attachment; the local file is really markdown — rule 2 wins.
    const fake = createFakeVault({ 'clip.md': 'local clip' });
    const baseline = encoder.encode('local clip');
    state.manifest['clip.md'] = {
      fileId: 'file_9',
      path: 'clip.md',
      hash: await sha256Hex(baseline),
      size: baseline.byteLength,
      mtime: 100,
      kind: 'markdown',
    };
    const entry: ChangeEntry = {
      fileId: 'file_9',
      changeType: 'modify',
      path: 'clip.md',
      blobHash: await sha256Hex(encoder.encode('server clip')),
      size: 11,
      mtime: 60,
      kind: 'attachment',
      revision: 8,
    };
    const { client } = createFakeClient({
      pages: [okPage([entry], 8)],
      blobs: { file_9: encoder.encode('server clip') },
      manifest: [
        { fileId: 'file_9', path: 'clip.md', blobHash: entry.blobHash!, kind: 'attachment' },
      ],
    });
    const outcome = await pullRemoteChanges({
      app: {} as never,
      client: client as never,
      state,
      saveState: async () => undefined,
      conflictedDate: DATE,
      vault: fake.vault,
    });
    expect(outcome).toEqual({ outcome: 'ok', applied: 1, toRevision: 8 });
    expect(fake.textWrites).toEqual([{ path: 'clip.md', text: 'server clip' }]);
    expect(fake.binaryWrites).toEqual([]);
  });
});
