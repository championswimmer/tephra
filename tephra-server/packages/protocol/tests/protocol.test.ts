import { describe, expect, it } from 'vitest';
import {
  canonicalManifestJson,
  hashManifest,
  isCanonicalVaultPath,
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
  ])('rejects %s', (path) => expect(isCanonicalVaultPath(path)).toBe(false));
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
