import { describe, expect, it } from 'vitest';
import { parseNote } from '@tephra/markdown';
import type { CurrentVaultFile } from '@tephra/vault-model';
import { buildGraph, buildIndexRows, planLinkReindex } from '../src/index.js';

const file = (fileId: string, path: string, kind: 'markdown' | 'attachment' = 'markdown'): CurrentVaultFile => ({
  fileId, vaultId: 'vault', path, kind, blobHash: `hash-${fileId}`, size: 1, mtime: 1, updatedRevision: 1,
});
const files = [file('a', 'A.md'), file('b', 'Folder/B.md'), file('image', 'image.png', 'attachment')];

describe('index utilities', () => {
  it('creates metadata and occurrence link rows against the current path index', () => {
    let id = 0;
    const rows = buildIndexRows({
      vaultId: 'vault', files, indexedAt: 10, generateId: () => `link-${String(++id)}`,
      notes: [
        { fileId: 'a', parsed: parseNote('---\ntitle: Alpha\ntags: [one]\n---\n# Heading\n[[Folder/B]] [[Folder/B]] ![[image.png]] [[Missing]]') },
        { fileId: 'b', parsed: parseNote('# Beta') },
      ],
    });
    expect(rows.metadata[0]).toMatchObject({ fileId: 'a', title: 'Alpha', tags: ['one'], indexedBlobHash: 'hash-a' });
    expect(rows.links.map((link) => link.targetFileId)).toEqual(['b', 'b', 'image', null]);
    expect(rows.links.map((link) => link.id)).toEqual(['link-1', 'link-2', 'link-3', 'link-4']);
  });

  it('aggregates graph edges and excludes attachment and unresolved targets', () => {
    let id = 0;
    const rows = buildIndexRows({
      vaultId: 'vault', files, indexedAt: 10, generateId: () => String(++id),
      notes: [{ fileId: 'a', parsed: parseNote('[[Folder/B]] [[Folder/B]] ![[Folder/B]] ![[image.png]] [[Missing]]') }],
    });
    const graph = buildGraph({ files, metadata: rows.metadata, links: rows.links });
    expect(graph.nodes.map((node) => node.id)).toEqual(['a', 'b']);
    expect(graph.edges).toEqual([{ source: 'a', target: 'b', count: 3, embedCount: 1 }]);
  });

  it('reindexes every source when target resolution can change', () => {
    expect(planLinkReindex({ previousFiles: files, currentFiles: [...files, file('new', 'B.md')] })).toEqual({
      sourceFileIds: ['a', 'b', 'new'], resolutionMayHaveChanged: true,
    });
    expect(planLinkReindex({ previousFiles: files, currentFiles: files, changedMarkdownFileIds: ['b'] })).toEqual({
      sourceFileIds: ['b'], resolutionMayHaveChanged: false,
    });
  });
});
