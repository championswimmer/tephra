import { describe, expect, it } from 'vitest';
import {
  canonicalManifestJson,
  canonicalVaultPathSchema,
  hashManifest,
  isCanonicalVaultPath,
  resolveResponseSchema,
  syncManifestSchema,
  type SyncManifestEntry,
} from '../src/index.js';

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function entry(overrides: Partial<SyncManifestEntry> = {}): SyncManifestEntry {
  return {
    fileId: 'file_1',
    path: 'Notes/A.md',
    hash: HASH_A,
    size: 12,
    mtime: 1_788_640_000_000,
    kind: 'markdown',
    ...overrides,
  };
}

describe('canonical paths', () => {
  it.each(['Notes.md', 'Projects/Alpha.md', 'Attachments/image.png'])('accepts %s', (path) => {
    expect(isCanonicalVaultPath(path)).toBe(true);
  });

  it.each([
    '',
    '/Notes.md',
    '../secret',
    'a/../../secret',
    'a//b',
    './a',
    'C:\\foo',
    'a\0b',
    `bad-${String.fromCharCode(0xd800)}`,
    'Cafe\u0301.md',
  ])('rejects %s', (path) => expect(isCanonicalVaultPath(path)).toBe(false));

  it('rejects non-NFC paths while accepting the NFC form', () => {
    const nfc = 'Caf\u00e9.md';
    const nfd = nfc.normalize('NFD');
    expect(nfd).not.toBe(nfc);
    expect(isCanonicalVaultPath(nfc)).toBe(true);
    expect(isCanonicalVaultPath(nfd)).toBe(false);
    expect(canonicalVaultPathSchema.safeParse(nfd).success).toBe(false);
    expect(canonicalVaultPathSchema.safeParse(nfc).success).toBe(true);
  });
});

describe('manifest schemas', () => {
  it('rejects duplicate paths and file IDs', () => {
    const result = syncManifestSchema.safeParse([
      entry(),
      entry({ path: 'Other.md', hash: HASH_B }),
    ]);
    expect(result.success).toBe(false);
  });
});

describe('canonical manifests', () => {
  it('sorts paths and uses an explicit stable property order', () => {
    expect(
      canonicalManifestJson([
        entry({ fileId: 'file_2', path: 'Z.md', hash: HASH_B, mimeType: 'text/markdown' }),
        entry(),
      ]),
    ).toBe(
      `[{"fileId":"file_1","path":"Notes/A.md","hash":"${HASH_A}","size":12,"mtime":1788640000000,"kind":"markdown"},{"fileId":"file_2","path":"Z.md","hash":"${HASH_B}","size":12,"mtime":1788640000000,"mimeType":"text/markdown","kind":"markdown"}]`,
    );
  });

  it('produces the same Web Crypto hash independent of input ordering', async () => {
    const a = entry();
    const b = entry({ fileId: 'file_2', path: 'Z.md', hash: HASH_B });
    await expect(hashManifest([a, b])).resolves.toBe(await hashManifest([b, a]));
    expect(await hashManifest([a, b])).toMatch(/^[a-f0-9]{64}$/);
  });
});

describe('resolve responses', () => {
  it('accepts every match kind with optional move fields', () => {
    const file = {
      fileId: 'file_1',
      path: 'Notes/A.md',
      blobHash: HASH_A,
      size: 12,
      mtime: 1_788_640_000_000,
      kind: 'markdown' as const,
    };
    for (const match of ['exact', 'case', 'normalized', 'historic'] as const) {
      const result = resolveResponseSchema.safeParse({
        match,
        requestedPath: 'Old.md',
        canonicalPath: file.path,
        file,
        ...(match === 'historic' ? { movedFromPath: 'Old.md', movedAtRevision: 2 } : {}),
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects unknown match kinds', () => {
    const file = {
      fileId: 'file_1',
      path: 'Notes/A.md',
      blobHash: HASH_A,
      size: 12,
      mtime: 1_788_640_000_000,
      kind: 'markdown' as const,
    };
    expect(
      resolveResponseSchema.safeParse({
        match: 'fuzzy',
        requestedPath: 'A.md',
        canonicalPath: 'A.md',
        file,
      }).success,
    ).toBe(false);
  });
});
