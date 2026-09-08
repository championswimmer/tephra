import { describe, expect, it, vi } from 'vitest';
import { FILE_ID_PROPERTY, VaultScanner, type ScannerIdentity } from '../src/sync/scanner';
import { mintFileId } from '../src/sync/identity/id-mint';

interface MockFile {
  path: string;
  extension: string;
  content: string;
}

function mockApp(
  files: MockFile[],
  frontmatterByPath: ReadonlyMap<string, string> = new Map(),
) {
  const processFrontMatter = vi.fn(
    async (file: unknown, callback: (fm: Record<string, unknown>) => void) => {
      const frontmatter: Record<string, unknown> = {};
      callback(frontmatter);
    },
  );
  const modify = vi.fn(async () => undefined);
  const read = vi.fn(async (file: { path: string }) => {
    const found = files.find((entry) => entry.path === file.path);
    if (!found) throw new Error(`missing file: ${file.path}`);
    return found.content;
  });
  const app = {
    vault: {
      getFiles: () =>
        files.map((entry) => ({
          path: entry.path,
          extension: entry.extension,
          stat: { mtime: 7, size: entry.content.length },
        })),
      read,
      readBinary: async (file: { path: string }) =>
        new TextEncoder().encode(await read(file)).buffer,
      modify,
    },
    metadataCache: {
      getFileCache: (file: { path: string }) => {
        const id = frontmatterByPath.get(file.path);
        return id ? { frontmatter: { [FILE_ID_PROPERTY]: id } } : null;
      },
    },
    fileManager: { processFrontMatter },
  };
  return { app, processFrontMatter, modify, read };
}

function identity(overrides?: Partial<ScannerIdentity>): ScannerIdentity {
  return {
    identityMode: 'sidecar',
    vaultId: 'vault-1',
    sidecar: new Map(),
    scanCache: {},
    pendingRenames: [],
    ...overrides,
  };
}

const FILES: MockFile[] = [
  { path: 'A.md', extension: 'md', content: '# A\n' },
  { path: 'B.md', extension: 'md', content: '# B\n' },
  { path: 'img.png', extension: 'png', content: 'binary-ish' },
];

describe('identity modes', () => {
  it('mode B never writes to a note', async () => {
    const { app, processFrontMatter, modify } = mockApp(FILES);
    const scanner = new VaultScanner(app as never, identity({ identityMode: 'sidecar' }));
    const result = await scanner.scan();
    expect(result.files).toHaveLength(3);
    for (const file of result.files) expect(file.fileId).toMatch(/^file_/);
    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
  });

  it('mode C never writes to a note', async () => {
    const { app, processFrontMatter, modify } = mockApp(FILES);
    const scanner = new VaultScanner(app as never, identity({ identityMode: 'path' }));
    const result = await scanner.scan();
    expect(result.files).toHaveLength(3);
    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
  });

  it('mode B reads frontmatter ids without writing them', async () => {
    const frontmatter = new Map([['A.md', 'file_harvested_a']]);
    const { app, processFrontMatter, modify } = mockApp(FILES, frontmatter);
    const scanner = new VaultScanner(app as never, identity({ identityMode: 'sidecar' }));
    const result = await scanner.scan();
    expect(result.files.find((file) => file.path === 'A.md')?.fileId).toBe('file_harvested_a');
    expect(processFrontMatter).not.toHaveBeenCalled();
    expect(modify).not.toHaveBeenCalled();
  });

  it('mode C ids always equal mintFileId(path)', async () => {
    const { app } = mockApp(FILES);
    const scanner = new VaultScanner(app as never, identity({ identityMode: 'path' }));
    const result = await scanner.scan();
    for (const file of result.files) {
      const kind = file.path.endsWith('.md') ? 'markdown' : 'attachment';
      expect(file.fileId).toBe(await mintFileId('vault-1', file.path, kind));
    }
  });

  it('A→B harvest preserves every id', async () => {
    const frontmatter = new Map([
      ['A.md', 'file_keep_a'],
      ['B.md', 'file_keep_b'],
    ]);
    const first = mockApp(FILES, frontmatter);
    const modeA = new VaultScanner(
      first.app as never,
      identity({ identityMode: 'frontmatter' }),
    );
    const fromA = await modeA.scan();
    // Nothing to write: ids were already present, so mode A made no changes either.
    expect(first.processFrontMatter).not.toHaveBeenCalled();

    // Mode B with an empty sidecar harvests the same ids from frontmatter.
    const second = mockApp(FILES, frontmatter);
    const modeB = new VaultScanner(second.app as never, identity({ identityMode: 'sidecar' }));
    const fromB = await modeB.scan();
    expect(fromB.files.map((file) => [file.path, file.fileId])).toEqual(
      fromA.files.map((file) => [file.path, file.fileId]),
    );
    expect(second.processFrontMatter).not.toHaveBeenCalled();
    expect(second.modify).not.toHaveBeenCalled();
    expect(fromB.identityChanged).toEqual([]);
  });

  it('mode A writes missing ids into frontmatter', async () => {
    const { app, processFrontMatter } = mockApp(FILES);
    const scanner = new VaultScanner(app as never, identity({ identityMode: 'frontmatter' }));
    const result = await scanner.scan();
    // Two Markdown files lacked ids; the attachment resolves without a write.
    expect(processFrontMatter).toHaveBeenCalledTimes(2);
    expect(result.sidecarUpdates.get('img.png')).toMatch(/^file_attachment_/);
  });

  it('mode C reports every surviving path as identity-changed against the sidecar', async () => {
    const { app } = mockApp(FILES);
    const sidecar = new Map([
      ['A.md', 'file_old_a'],
      ['B.md', 'file_old_b'],
      ['img.png', 'file_attachment_old'],
    ]);
    const scanner = new VaultScanner(app as never, identity({ identityMode: 'path', sidecar }));
    const result = await scanner.scan();
    expect(result.identityChanged).toEqual(['A.md', 'B.md', 'img.png']);
  });

  it('mode B reports no identity change in the steady state', async () => {
    const { app } = mockApp(FILES);
    const first = await new VaultScanner(app as never, identity({ identityMode: 'sidecar' })).scan();
    const second = await new VaultScanner(
      app as never,
      identity({ identityMode: 'sidecar', sidecar: first.sidecarUpdates }),
    ).scan();
    expect(second.identityChanged).toEqual([]);
    expect(second.files.map((file) => file.fileId)).toEqual(
      first.files.map((file) => file.fileId),
    );
  });

  it('reuses hashes via the scanCache mtime/size fast path without re-reading', async () => {
    const { app, read } = mockApp(FILES);
    const shared = identity({ identityMode: 'sidecar' });
    await new VaultScanner(app as never, shared).scan();
    const firstReads = read.mock.calls.length;
    expect(firstReads).toBeGreaterThan(0);
    read.mockClear();
    const second = await new VaultScanner(app as never, shared).scan();
    expect(read).not.toHaveBeenCalled();
    expect(second.files).toHaveLength(3);
  });
});
