import { describe, expect, it, vi } from 'vitest';
import { FILE_ID_PROPERTY, VaultScanner, shouldSyncPath } from '../src/sync/scanner';

describe('vault path filtering', () => {
  it.each([
    '.obsidian/plugins/x.js',
    '.hidden/note.md',
    'folder/.hidden.md',
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
  it('stores IDs in Markdown frontmatter and path mappings only for attachments', async () => {
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
    const scanner = new VaultScanner(app as never);
    const first = await scanner.scan({}, {});
    const noteEntry = first.files.find((file) => file.path === 'Note.md');
    expect(processFrontMatter).toHaveBeenCalledTimes(1);
    expect(caches.get(note)?.frontmatter[FILE_ID_PROPERTY]).toBe(noteEntry?.fileId);
    expect(first.attachmentIds['Note.md']).toBeUndefined();
    expect(first.attachmentIds['image.png']).toBeTruthy();

    const second = await scanner.scan({}, first.attachmentIds);
    expect(second.files.find((file) => file.path === 'Note.md')?.fileId).toBe(noteEntry?.fileId);
    expect(second.attachmentIds['image.png']).toBe(first.attachmentIds['image.png']);
    expect(processFrontMatter).toHaveBeenCalledTimes(1);

    const withoutSavedMapping = await scanner.scan({}, {});
    expect(withoutSavedMapping.attachmentIds['image.png']).toBe(first.attachmentIds['image.png']);
  });
});
