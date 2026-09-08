import { describe, expect, it, vi } from 'vitest';
import {
  FILE_ID_PROPERTY,
  VaultScanner,
  extractFrontmatterFileId,
  injectFrontmatterFileId,
  shouldSyncPath,
  type ScannerIdentity,
} from '../src/sync/scanner';

function makeScanner(app: unknown, overrides?: Partial<ScannerIdentity>): VaultScanner {
  return new VaultScanner(app as never, {
    identityMode: 'frontmatter',
    vaultId: 'vault-1',
    sidecar: new Map(),
    scanCache: {},
    pendingRenames: [],
    ...overrides,
  });
}

describe('vault path filtering', () => {
  it.each([
    '.obsidian/plugins/x.js',
    '.hidden/note.md',
    'folder/.hidden.md',
    '.tephra/data.json',
    '.tephra/data.json.bak',
    'draft.md~',
    'scratch.tmp',
    'swap.swp',
    '~$document.docx',
    '../escape.md',
    '/absolute.md',
  ])('excludes %s', (path) => expect(shouldSyncPath(path)).toBe(false));

  it.each(['Notes.md', 'Folder/image.png', 'normal.tempest.md'])('includes %s', (path) =>
    expect(shouldSyncPath(path)).toBe(true),
  );
});

describe('stable file IDs', () => {
  it('stores IDs in Markdown frontmatter and resolves attachments through the sidecar', async () => {
    const note = { path: 'Note.md', extension: 'md', stat: { mtime: 1, size: 5 } };
    const image = { path: 'image.png', extension: 'png', stat: { mtime: 1, size: 3 } };
    const caches = new Map<unknown, { frontmatter: Record<string, unknown> }>();
    const processFrontMatter = vi.fn(
      async (file: unknown, callback: (fm: Record<string, unknown>) => void) => {
        const frontmatter: Record<string, unknown> = {};
        callback(frontmatter);
        caches.set(file, { frontmatter });
      },
    );
    const app = {
      vault: {
        getFiles: () => [note, image],
        read: async () => 'hello',
        readBinary: async () => new Uint8Array([1, 2, 3]).buffer,
      },
      metadataCache: { getFileCache: (file: unknown) => caches.get(file) ?? null },
      fileManager: { processFrontMatter },
    };
    const scanCache = {};
    const scanner = makeScanner(app, { scanCache });
    const first = await scanner.scan();
    const noteEntry = first.files.find((file) => file.path === 'Note.md');
    expect(processFrontMatter).toHaveBeenCalledTimes(1);
    expect(caches.get(note)?.frontmatter[FILE_ID_PROPERTY]).toBe(noteEntry?.fileId);
    expect(first.sidecarUpdates.get('Note.md')).toBe(noteEntry?.fileId);
    const imageEntry = first.files.find((file) => file.path === 'image.png');
    expect(imageEntry?.fileId).toMatch(/^file_attachment_/);
    expect(first.sidecarUpdates.get('image.png')).toBe(imageEntry?.fileId);

    // Second scan resolves both ids from the sidecar without rewriting frontmatter.
    const secondScanner = makeScanner(app, { scanCache, sidecar: first.sidecarUpdates });
    const second = await secondScanner.scan();
    expect(second.files.find((file) => file.path === 'Note.md')?.fileId).toBe(noteEntry?.fileId);
    expect(second.files.find((file) => file.path === 'image.png')?.fileId).toBe(
      imageEntry?.fileId,
    );
    expect(processFrontMatter).toHaveBeenCalledTimes(1);

    // Attachments re-mint deterministically from (vaultId, path) even with no sidecar.
    const coldScanner = makeScanner(app, { scanCache: {} });
    const cold = await coldScanner.scan();
    expect(cold.files.find((file) => file.path === 'image.png')?.fileId).toBe(imageEntry?.fileId);
  });

  it('handles invalid YAML frontmatter (such as Templater tags) gracefully via raw injection fallback', async () => {
    const invalidYaml = [
      '---',
      'title: My Note',
      'tags: {{VALUE:tags}}',
      '---',
      'Note content',
    ].join('\n');

    let fileContent = invalidYaml;
    const note = { path: 'Template.md', extension: 'md', stat: { mtime: 1, size: 10 } };
    const modify = vi.fn(async (_file: unknown, updated: string) => {
      fileContent = updated;
    });
    const processFrontMatter = vi.fn(async () => {
      throw new Error(
        'Implicit map keys need to be followed by map values at line 3, column 1:\ntags: {{VALUE:tags}} ^^^^^^^^^^^^^^^',
      );
    });

    const app = {
      vault: {
        getFiles: () => [note],
        read: async () => fileContent,
        readBinary: async () => new TextEncoder().encode(fileContent).buffer,
        modify,
      },
      metadataCache: { getFileCache: () => null }, // Obsidian cache fails to parse invalid YAML
      fileManager: { processFrontMatter },
    };

    const scanCache = {};
    const scanner = makeScanner(app, { scanCache });
    const scanResult = await scanner.scan();

    // 1. Scan must NOT throw unhandled YAML parse error
    expect(scanResult.files).toHaveLength(1);
    const entry = scanResult.files[0];
    expect(entry?.fileId).toMatch(/^file_/);

    // 2. processFrontMatter was attempted and failed, triggering vault.modify fallback
    expect(processFrontMatter).toHaveBeenCalledTimes(1);
    expect(modify).toHaveBeenCalledTimes(1);

    // 3. File content now has tephra-file-id while preserving invalid YAML lines
    expect(fileContent).toContain(`${FILE_ID_PROPERTY}: ${entry?.fileId}`);
    expect(fileContent).toContain('tags: {{VALUE:tags}}');

    // 4. On next scan, extractFrontmatterFileId extracts the ID directly from raw content without calling processFrontMatter
    const secondScanner = makeScanner(app, { scanCache, sidecar: scanResult.sidecarUpdates });
    const secondScan = await secondScanner.scan();
    expect(secondScan.files[0]?.fileId).toBe(entry?.fileId);
    expect(processFrontMatter).toHaveBeenCalledTimes(1); // Not called again!
  });

  it('adopts the minted ID for this scan if writing frontmatter fails completely', async () => {
    const note = { path: 'ReadOnly.md', extension: 'md', stat: { mtime: 1, size: 10 } };
    const processFrontMatter = vi.fn(async () => {
      throw new Error('YAML error');
    });
    const modify = vi.fn(async () => {
      throw new Error('EACCES: permission denied');
    });

    const app = {
      vault: {
        getFiles: () => [note],
        read: async () => '# Read Only\nContent',
        readBinary: async () => new TextEncoder().encode('# Read Only\nContent').buffer,
        modify,
      },
      metadataCache: { getFileCache: () => null },
      fileManager: { processFrontMatter },
    };

    const scanner = makeScanner(app);
    // Should NOT throw; the minted id keeps the manifest valid and is retried next scan.
    const scanResult = await scanner.scan();
    expect(scanResult.files).toHaveLength(1);
    expect(scanResult.files[0]?.fileId).toMatch(/^file_/);
    expect(scanResult.sidecarUpdates.get('ReadOnly.md')).toBe(scanResult.files[0]?.fileId);

    // Stable across scans: path-seeded minting derives the same id, so the
    // failed write does not churn identity.
    const retry = await makeScanner(app, { sidecar: scanResult.sidecarUpdates }).scan();
    expect(retry.files[0]?.fileId).toBe(scanResult.files[0]?.fileId);
  });

  it('never surfaces the sidecar cache as a syncable file', async () => {
    const sidecar = { path: '.tephra/data.json', extension: 'json', stat: { mtime: 1, size: 10 } };
    const note = { path: 'Note.md', extension: 'md', stat: { mtime: 1, size: 5 } };
    const app = {
      vault: {
        getFiles: () => [sidecar, note],
        read: async () => 'hello',
        readBinary: async () => new Uint8Array([1]).buffer,
      },
      metadataCache: { getFileCache: () => ({ frontmatter: { [FILE_ID_PROPERTY]: 'file_x' } }) },
      fileManager: { processFrontMatter: vi.fn() },
    };
    const result = await makeScanner(app).scan();
    expect(result.files.map((file) => file.path)).toEqual(['Note.md']);
  });

  it('normalizes an NFD filename to an NFC manifest path', async () => {
    const nfd = 'Café.md'.normalize('NFD');
    expect(nfd).not.toBe(nfd.normalize('NFC')); // guard: the fixture really is decomposed
    const note = { path: nfd, extension: 'md', stat: { mtime: 1, size: 5 } };
    const app = {
      vault: {
        getFiles: () => [note],
        read: async () => 'hello',
        readBinary: async () => new Uint8Array([1]).buffer,
      },
      metadataCache: { getFileCache: () => null },
      fileManager: { processFrontMatter: vi.fn() },
    };
    const result = await makeScanner(app, { identityMode: 'sidecar' }).scan();
    expect(result.files).toHaveLength(1);
    expect(result.files[0]?.path).toBe(nfd.normalize('NFC'));
    expect([...result.sidecarUpdates.keys()]).toEqual([nfd.normalize('NFC')]);
  });
});

describe('frontmatter extraction and injection helpers', () => {
  it('extracts frontmatter file ID with various delimiters and formatting', () => {
    expect(
      extractFrontmatterFileId('---\ntephra-file-id: file_abc\n---\nbody'),
    ).toBe('file_abc');
    expect(
      extractFrontmatterFileId('---\r\ntephra-file-id: "file_def"\r\n---\r\nbody'),
    ).toBe('file_def');
    expect(
      extractFrontmatterFileId('---\ntitle: Note\ntephra-file-id: file_ghi # comment\n---\nbody'),
    ).toBe('file_ghi');
    expect(extractFrontmatterFileId('No frontmatter here')).toBeUndefined();
  });

  it('injects frontmatter file ID cleanly into existing frontmatter or creates one', () => {
    const existing = '---\ntitle: Foo\ntags: {{VALUE:tags}}\n---\nHello';
    const injected = injectFrontmatterFileId(existing, 'file_123');
    expect(injected).toBe('---\ntephra-file-id: file_123\ntitle: Foo\ntags: {{VALUE:tags}}\n---\nHello');

    const noFm = '# Hello\nWorld';
    const created = injectFrontmatterFileId(noFm, 'file_456');
    expect(created).toBe('---\ntephra-file-id: file_456\n---\n\n# Hello\nWorld');

    const updateExisting = '---\ntephra-file-id: file_old\ntitle: Bar\n---';
    const replaced = injectFrontmatterFileId(updateExisting, 'file_new');
    expect(replaced).toBe('---\ntephra-file-id: file_new\ntitle: Bar\n---');
  });
});
