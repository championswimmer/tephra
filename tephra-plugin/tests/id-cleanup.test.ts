import { describe, expect, it, vi } from 'vitest';
import { FILE_ID_PROPERTY, stripFrontmatterFileId } from '../src/sync/scanner';
import { removeFileIds, scanForFileIds, type FileIdEntry } from '../src/sync/id-cleanup';

describe('stripFrontmatterFileId', () => {
  it('drops the whole block plus one blank line when it is the only key', () => {
    expect(stripFrontmatterFileId(`---\n${FILE_ID_PROPERTY}: file_1\n---\n\nBody\n`)).toBe(
      'Body\n',
    );
  });

  it('drops the whole block when it is the only key with no following blank line', () => {
    expect(stripFrontmatterFileId(`---\n${FILE_ID_PROPERTY}: file_1\n---\nBody`)).toBe('Body');
  });

  it('leaves an empty string when the file was only frontmatter', () => {
    expect(stripFrontmatterFileId(`---\n${FILE_ID_PROPERTY}: file_1\n---\n`)).toBe('');
  });

  it('drops just the line when other keys are present', () => {
    expect(
      stripFrontmatterFileId(
        `---\ntitle: T\n${FILE_ID_PROPERTY}: file_1\ntags: [a]\n---\nBody`,
      ),
    ).toBe('---\ntitle: T\ntags: [a]\n---\nBody');
  });

  it('returns undefined when the property is absent or there is no frontmatter', () => {
    expect(stripFrontmatterFileId('---\ntitle: T\n---\nBody')).toBeUndefined();
    expect(stripFrontmatterFileId('# No frontmatter\nBody')).toBeUndefined();
  });

  it('preserves CRLF line endings', () => {
    const stripped = stripFrontmatterFileId(
      `---\r\ntitle: T\r\n${FILE_ID_PROPERTY}: file_1\r\n---\r\nBody`,
    );
    expect(stripped).toBe('---\r\ntitle: T\r\n---\r\nBody');
    // No bare LF: every LF must be part of CRLF.
    expect(stripped?.replaceAll('\r\n', '').includes('\n')).toBe(false);
  });

  it('handles a `...` terminator for both the only-key and among-keys cases', () => {
    expect(stripFrontmatterFileId(`---\n${FILE_ID_PROPERTY}: file_1\n...\nBody`)).toBe('Body');
    expect(
      stripFrontmatterFileId(`---\ntitle: T\n${FILE_ID_PROPERTY}: file_1\n...\nBody`),
    ).toBe('---\ntitle: T\n...\nBody');
  });

  it('handles quoted values and trailing comments', () => {
    expect(stripFrontmatterFileId(`---\n${FILE_ID_PROPERTY}: \"file_1\"\n---\n\nBody\n`)).toBe(
      'Body\n',
    );
    expect(
      stripFrontmatterFileId(`---\ntitle: T\n${FILE_ID_PROPERTY}: file_1 # comment\n---\nBody`),
    ).toBe('---\ntitle: T\n---\nBody');
  });
});

interface FakeFile {
  path: string;
  extension: string;
}

function makeApp(
  initial: Record<string, string>,
  hooks: {
    cache?: (path: string) => Record<string, unknown> | null;
    failProcessPaths?: Set<string>;
    failModifyPaths?: Set<string>;
  } = {},
) {
  const contents = new Map(Object.entries(initial));
  const files: FakeFile[] = [...contents.keys()].map((path) => ({ path, extension: 'md' }));
  const read = vi.fn(async (file: FakeFile) => {
    const content = contents.get(file.path);
    if (content === undefined) throw new Error(`ENOENT: ${file.path}`);
    return content;
  });
  const beforeWrite = vi.fn((_path: string) => undefined);
  const app = {
    vault: {
      getMarkdownFiles: () => files,
      getFileByPath: (path: string) => files.find((f) => f.path === path) ?? null,
      read,
      modify: vi.fn(async (file: FakeFile, updated: string) => {
        if (hooks.failModifyPaths?.has(file.path)) throw new Error('EACCES: denied');
        contents.set(file.path, updated);
      }),
    },
    metadataCache: {
      getFileCache: (file: FakeFile) => {
        const fm = hooks.cache?.(file.path);
        return fm === undefined || fm === null ? null : { frontmatter: fm };
      },
    },
    fileManager: {
      processFrontMatter: vi.fn(
        async (file: FakeFile, callback: (fm: Record<string, unknown>) => void) => {
          if (hooks.failProcessPaths?.has(file.path)) throw new Error('YAML parse error');
          const content = contents.get(file.path) ?? '';
          const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
          const fm: Record<string, unknown> = {};
          if (match) {
            for (const line of (match[1] ?? '').split('\n')) {
              const kv = /^([^:#]+?):\s*(.*?)\s*$/.exec(line);
              if (kv?.[1]) fm[kv[1].trim()] = kv[2] ?? '';
            }
          }
          callback(fm);
          const entries = Object.entries(fm);
          const rest = match ? content.slice(match[0].length) : content;
          contents.set(
            file.path,
            entries.length === 0 && match
              ? rest.replace(/^\r?\n/, '')
              : `---\n${entries.map(([k, v]) => `${k}: ${String(v)}`).join('\n')}\n---\n${rest}`,
          );
        },
      ),
    },
  };
  return { app: app as never, contents, read, beforeWrite };
}

const WITH_ID = `---\ntitle: T\n${FILE_ID_PROPERTY}: file_1\n---\nBody\n`;
const ONLY_ID = `---\n${FILE_ID_PROPERTY}: file_2\n---\n\nSecond\n`;

describe('scanForFileIds', () => {
  it('finds ids via metadataCache and via raw fallback, skipping clean files', async () => {
    const { app, read } = makeApp(
      { 'A.md': WITH_ID, 'B.md': '---\ntitle: B\n---\nplain', 'C.md': '# no frontmatter' },
      { cache: (path) => (path === 'A.md' ? { [FILE_ID_PROPERTY]: 'file_1' } : null) },
    );
    const found = await scanForFileIds(app);
    expect(found).toEqual([{ path: 'A.md', id: 'file_1' }]);
    // Cache hit for A.md means no raw read for it; B/C fall back to raw reads.
    expect(read.mock.calls.map((call) => (call[0] as FakeFile).path).sort()).toEqual([
      'B.md',
      'C.md',
    ]);
  });

  it('uses the raw fallback when the cache has no id', async () => {
    const { app } = makeApp({ 'A.md': WITH_ID });
    expect(await scanForFileIds(app)).toEqual([{ path: 'A.md', id: 'file_1' }]);
  });
});

describe('removeFileIds sweep', () => {
  it('removes ids and reports counts', async () => {
    const { app, contents, beforeWrite } = makeApp({ 'A.md': WITH_ID, 'B.md': ONLY_ID });
    const preview = await scanForFileIds(app);
    expect(preview).toHaveLength(2);
    const progress = vi.fn();
    const result = await removeFileIds(app, preview, { beforeWrite, onProgress: progress });
    expect(result).toEqual({ removed: 2, skipped: 0, failed: [] });
    expect(contents.get('A.md')).not.toContain(FILE_ID_PROPERTY);
    expect(contents.get('B.md')).toBe('Second\n');
    expect(progress).toHaveBeenCalledWith(2, 2);
    const writtenPaths = beforeWrite.mock.calls.map((call) => call[0] as string);
    for (const entry of preview) expect(writtenPaths).toContain(entry.path);
  });

  it('skips files that no longer exist', async () => {
    const { app } = makeApp({ 'A.md': WITH_ID });
    const result = await removeFileIds(app, [
      { path: 'A.md', id: 'file_1' },
      { path: 'Gone.md', id: 'file_x' },
    ]);
    expect(result.removed).toBe(1);
    expect(result.skipped).toBe(1);
    expect(result.failed).toEqual([]);
  });

  it('one file failing does not abort the batch', async () => {
    const { app } = makeApp(
      { 'A.md': WITH_ID, 'B.md': WITH_ID, 'C.md': WITH_ID },
      { failProcessPaths: new Set(['B.md']), failModifyPaths: new Set(['B.md']) },
    );
    const preview: FileIdEntry[] = [
      { path: 'A.md', id: 'file_1' },
      { path: 'B.md', id: 'file_2' },
      { path: 'C.md', id: 'file_3' },
    ];
    const result = await removeFileIds(app, preview);
    expect(result.removed).toBe(2);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.path).toBe('B.md');
    expect(result.failed[0]?.reason).toContain('EACCES');
  });

  it('falls back to the raw strip when processFrontMatter throws', async () => {
    const templater = `---\ntitle: T\ntags: {{VALUE:tags}}\n${FILE_ID_PROPERTY}: file_9\n---\nBody\n`;
    const { app, contents } = makeApp(
      { 'T.md': templater },
      { failProcessPaths: new Set(['T.md']) },
    );
    const result = await removeFileIds(app, [{ path: 'T.md', id: 'file_9' }]);
    expect(result).toEqual({ removed: 1, skipped: 0, failed: [] });
    expect(contents.get('T.md')).toBe('---\ntitle: T\ntags: {{VALUE:tags}}\n---\nBody\n');
  });

  it('records failed when both processFrontMatter and the raw fallback throw', async () => {
    const { app } = makeApp(
      { 'A.md': WITH_ID },
      { failProcessPaths: new Set(['A.md']), failModifyPaths: new Set(['A.md']) },
    );
    const result = await removeFileIds(app, [{ path: 'A.md', id: 'file_1' }]);
    expect(result.removed).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]).toMatchObject({ path: 'A.md' });
  });

  it('yields between chunks and reports progress per chunk', async () => {
    const initial: Record<string, string> = {};
    for (let i = 0; i < 5; i++) initial[`N${String(i)}.md`] = WITH_ID;
    const { app } = makeApp(initial);
    const preview = await scanForFileIds(app);
    const progress: Array<[number, number]> = [];
    const result = await removeFileIds(app, preview, {
      chunkSize: 2,
      onProgress: (done, total) => progress.push([done, total]),
    });
    expect(result).toEqual({ removed: 5, skipped: 0, failed: [] });
    expect(progress).toEqual([
      [2, 5],
      [4, 5],
      [5, 5],
    ]);
  });

  it('a second sweep reports 0 removed', async () => {
    const { app } = makeApp({ 'A.md': WITH_ID, 'B.md': ONLY_ID });
    const first = await removeFileIds(app, await scanForFileIds(app));
    expect(first.removed).toBe(2);
    const rescan = await scanForFileIds(app);
    expect(rescan).toEqual([]);
    const second = await removeFileIds(app, rescan);
    expect(second).toEqual({ removed: 0, skipped: 0, failed: [] });
  });
});
