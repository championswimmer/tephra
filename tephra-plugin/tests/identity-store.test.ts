import { beforeEach, describe, expect, it } from 'vitest';
import {
  ID_SCHEME,
  IDENTITY_BACKUP_FILE,
  IDENTITY_DIR,
  IDENTITY_FILE,
  IDENTITY_TMP_FILE,
  loadIdentityStore,
  parseSidecarDocument,
  resetIdentityStoreCache,
  saveIdentityStore,
  serializeIdentityStore,
  type IdentityStoreAdapter,
} from '../src/state/identity-store';

interface MemAdapter extends IdentityStoreAdapter {
  files: Map<string, string>;
  dirs: Set<string>;
  mkdirCalls: string[];
  writeCalls: Array<{ path: string; data: string }>;
}

function createAdapter(initial: Record<string, string> = {}): MemAdapter {
  const files = new Map(Object.entries(initial));
  const adapter: MemAdapter = {
    files,
    dirs: new Set<string>(),
    mkdirCalls: [],
    writeCalls: [],
    exists: async (path) => files.has(path) || adapter.dirs.has(path),
    read: async (path) => {
      const content = files.get(path);
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    },
    write: async (path, data) => {
      adapter.writeCalls.push({ path, data });
      files.set(path, data);
    },
    remove: async (path) => {
      if (!files.delete(path)) throw new Error(`ENOENT: ${path}`);
    },
    rename: async (oldPath, newPath) => {
      const content = files.get(oldPath);
      if (content === undefined) throw new Error(`ENOENT: ${oldPath}`);
      files.delete(oldPath);
      files.set(newPath, content);
    },
    mkdir: async (path) => {
      adapter.mkdirCalls.push(path);
      adapter.dirs.add(path);
    },
  };
  return adapter;
}

function doc(vaultId: string, files: Array<[string, string]>, extra: Record<string, unknown> = {}) {
  return JSON.stringify({ version: 1, vaultId, idScheme: ID_SCHEME, files, ...extra });
}

beforeEach(() => {
  resetIdentityStoreCache();
});

describe('serializeIdentityStore', () => {
  it('produces byte-identical output regardless of insertion order', () => {
    const first = new Map([
      ['b.md', 'file_2'],
      ['007', 'file_3'],
      ['a.md', 'file_1'],
    ]);
    const second = new Map([
      ['a.md', 'file_1'],
      ['b.md', 'file_2'],
      ['007', 'file_3'],
    ]);
    expect(serializeIdentityStore('vlt_1', first)).toBe(serializeIdentityStore('vlt_1', second));
  });

  it('sorts by code point, immune to integer-key hoisting and UTF-16 order', () => {
    // '12' is integer-like (JS objects would hoist it); '\uFFFF' vs astral
    // U+1F600 differ between code-unit and code-point order.
    const ids = new Map([
      ['b.md', 'file_b'],
      ['12', 'file_12'],
      ['\u{1F600}.md', 'file_emoji'],
      ['\uFFFF.md', 'file_ffff'],
    ]);
    const text = serializeIdentityStore('vlt_1', ids);
    const order = [...text.matchAll(/\["(.*?)"(?=, "file_)/g)].map((m) => m[1]);
    // Code points: '1'(0x31) < 'b'(0x62) < U+FFFF < U+1F600.
    expect(order).toEqual(['12', 'b.md', '\uFFFF.md', '\u{1F600}.md']);
  });

  it('matches the documented layout exactly, with a trailing newline', () => {
    const text = serializeIdentityStore('vlt_9', new Map([['a.md', 'file_1']]));
    expect(text).toBe(
      '{\n' +
        '  "version": 1,\n' +
        '  "vaultId": "vlt_9",\n' +
        `  "idScheme": ${JSON.stringify(ID_SCHEME)},\n` +
        '  "files": [\n' +
        '    ["a.md", "file_1"]\n' +
        '  ]\n' +
        '}\n',
    );
  });
});

describe('parseSidecarDocument', () => {
  it('rejects unknown keys, wrong versions, and empty strings', () => {
    expect(parseSidecarDocument({ version: 1, vaultId: 'v', idScheme: 's', files: [], extra: 1 })).toBeUndefined();
    expect(parseSidecarDocument({ version: 2, vaultId: 'v', idScheme: 's', files: [] })).toBeUndefined();
    expect(parseSidecarDocument({ version: 1, vaultId: '', idScheme: 's', files: [] })).toBeUndefined();
    expect(parseSidecarDocument({ version: 1, vaultId: 'v', idScheme: 's', files: [['', 'file_1']] })).toBeUndefined();
    expect(parseSidecarDocument({ version: 1, vaultId: 'v', idScheme: 's', files: [['a.md', '']] })).toBeUndefined();
    expect(parseSidecarDocument({ version: 1, vaultId: 'v', idScheme: 's', files: [['a.md']] })).toBeUndefined();
    expect(
      parseSidecarDocument({ version: 1, vaultId: 'v', idScheme: 's', files: [['a.md', 'file_1']] }),
    ).toEqual({ version: 1, vaultId: 'v', idScheme: 's', files: [['a.md', 'file_1']] });
  });
});

describe('loadIdentityStore', () => {
  it('loads a valid sidecar with no repair flag', async () => {
    const adapter = createAdapter({
      [IDENTITY_FILE]: doc('vlt_1', [['b.md', 'file_2'], ['a.md', 'file_1']]),
    });
    const loaded = await loadIdentityStore(adapter, 'vlt_1');
    expect(loaded.repairNeeded).toBe(false);
    expect([...loaded.ids.entries()]).toEqual([['a.md', 'file_1'], ['b.md', 'file_2']]);
  });

  it('recovers from .bak when data.json is invalid', async () => {
    const adapter = createAdapter({
      [IDENTITY_FILE]: 'truncated {{{',
      [IDENTITY_BACKUP_FILE]: doc('vlt_1', [['a.md', 'file_1']]),
    });
    const loaded = await loadIdentityStore(adapter, 'vlt_1');
    expect(loaded.repairNeeded).toBe(false);
    expect([...loaded.ids.entries()]).toEqual([['a.md', 'file_1']]);
  });

  it('conflict markers: absent + repair + original preserved as corrupt-*', async () => {
    const conflicted = '<<<<<<< HEAD\n{"version": 1}\n=======\n{"version": 1}\n>>>>>>> branch\n';
    const adapter = createAdapter({ [IDENTITY_FILE]: conflicted });
    const loaded = await loadIdentityStore(adapter, 'vlt_1');
    expect(loaded.repairNeeded).toBe(true);
    expect(loaded.ids.size).toBe(0);
    expect(adapter.files.has(IDENTITY_FILE)).toBe(false);
    const archived = [...adapter.files.keys()].filter((key) =>
      key.startsWith(`${IDENTITY_FILE}.corrupt-`),
    );
    expect(archived).toHaveLength(1);
    const archivedKey = archived[0];
    expect(archivedKey).toBeDefined();
    if (archivedKey === undefined) throw new Error('expected one archived sidecar');
    expect(adapter.files.get(archivedKey)).toBe(conflicted);
  });

  it('archives a corrupt primary at most once', async () => {
    const adapter = createAdapter({ [IDENTITY_FILE]: 'nope{{{' });
    await loadIdentityStore(adapter, 'vlt_1');
    await loadIdentityStore(adapter, 'vlt_1');
    const archived = [...adapter.files.keys()].filter((key) =>
      key.startsWith(`${IDENTITY_FILE}.corrupt-`),
    );
    expect(archived).toHaveLength(1);
  });

  it('foreign vaultId: absent + repair, file left untouched', async () => {
    const original = doc('vlt_other', [['a.md', 'file_1']]);
    const adapter = createAdapter({ [IDENTITY_FILE]: original });
    const loaded = await loadIdentityStore(adapter, 'vlt_1');
    expect(loaded.repairNeeded).toBe(true);
    expect(loaded.ids.size).toBe(0);
    expect(adapter.files.get(IDENTITY_FILE)).toBe(original);
    expect([...adapter.files.keys()].some((key) => key.includes('.corrupt-'))).toBe(false);
  });

  it('duplicate ids dedupe deterministically: code-point-lowest path keeps the id', async () => {
    const adapter = createAdapter({
      [IDENTITY_FILE]: doc('vlt_1', [['b.md', 'file_x'], ['a.md', 'file_x'], ['c.md', 'file_y']]),
    });
    const loaded = await loadIdentityStore(adapter, 'vlt_1');
    expect(loaded.repairNeeded).toBe(false);
    expect([...loaded.ids.entries()].sort()).toEqual([
      ['a.md', 'file_x'],
      ['c.md', 'file_y'],
    ]);
  });

  it('unknown idScheme keeps the ids but flags repair', async () => {
    const adapter = createAdapter({
      [IDENTITY_FILE]: JSON.stringify({
        version: 1,
        vaultId: 'vlt_1',
        idScheme: 'ancient-scheme',
        files: [['a.md', 'file_1']],
      }),
    });
    const loaded = await loadIdentityStore(adapter, 'vlt_1');
    expect(loaded.repairNeeded).toBe(true);
    expect([...loaded.ids.entries()]).toEqual([['a.md', 'file_1']]);
  });

  it('never throws, even when the adapter itself throws', async () => {
    const broken: IdentityStoreAdapter = {
      exists: async () => {
        throw new Error('disk gone');
      },
      read: async () => {
        throw new Error('disk gone');
      },
      write: async () => {
        throw new Error('disk gone');
      },
      remove: async () => {
        throw new Error('disk gone');
      },
      rename: async () => {
        throw new Error('disk gone');
      },
      mkdir: async () => {
        throw new Error('disk gone');
      },
    };
    const loaded = await loadIdentityStore(broken, 'vlt_1');
    expect(loaded).toEqual({ ids: new Map(), repairNeeded: true });
  });
});

describe('saveIdentityStore', () => {
  it('creates .tephra when missing and writes atomically via .tmp + .bak', async () => {
    const adapter = createAdapter();
    await saveIdentityStore(adapter, 'vlt_1', new Map([['a.md', 'file_1']]));
    expect(adapter.mkdirCalls).toContain(IDENTITY_DIR);
    expect(adapter.files.has(IDENTITY_TMP_FILE)).toBe(false);
    expect(adapter.files.has(IDENTITY_BACKUP_FILE)).toBe(false);
    expect(adapter.files.has(IDENTITY_TMP_FILE)).toBe(false);
    const reloaded = await loadIdentityStore(adapter, 'vlt_1');
    expect([...reloaded.ids.entries()]).toEqual([['a.md', 'file_1']]);
  });

  it('rotates the previous file to .bak on rewrite', async () => {
    const adapter = createAdapter();
    await saveIdentityStore(adapter, 'vlt_1', new Map([['a.md', 'file_1']]));
    const firstText = adapter.files.get(IDENTITY_FILE);
    resetIdentityStoreCache();
    await saveIdentityStore(adapter, 'vlt_1', new Map([['a.md', 'file_1'], ['b.md', 'file_2']]));
    expect(adapter.files.get(IDENTITY_BACKUP_FILE)).toBe(firstText);
  });

  it('skips the write when the serialized text is unchanged', async () => {
    const adapter = createAdapter();
    const ids = new Map([['a.md', 'file_1']]);
    await saveIdentityStore(adapter, 'vlt_1', ids);
    const writesAfterFirst = adapter.writeCalls.length;
    expect(writesAfterFirst).toBeGreaterThan(0);
    await saveIdentityStore(adapter, 'vlt_1', new Map([['a.md', 'file_1']]));
    expect(adapter.writeCalls.length).toBe(writesAfterFirst);
  });

  it('writes again when the map changes', async () => {
    const adapter = createAdapter();
    await saveIdentityStore(adapter, 'vlt_1', new Map([['a.md', 'file_1']]));
    const writesAfterFirst = adapter.writeCalls.length;
    resetIdentityStoreCache();
    await saveIdentityStore(adapter, 'vlt_1', new Map([['a.md', 'file_1'], ['b.md', 'file_2']]));
    expect(adapter.writeCalls.length).toBeGreaterThan(writesAfterFirst);
  });
});

