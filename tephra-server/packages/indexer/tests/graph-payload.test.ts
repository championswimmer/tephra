import { describe, expect, it } from 'vitest';
import type { CurrentVaultFile, NoteLink, NoteMetadata } from '@tephra/vault-model';
import { buildGraphPayload, GRAPH_NODE_LIMIT } from '../src/index.js';

const file = (fileId: string, path: string, mtime = 100, kind: 'markdown' | 'attachment' = 'markdown'): CurrentVaultFile => ({
  fileId, vaultId: 'vault', path, kind, blobHash: `hash-${fileId}`, size: 1, mtime, updatedRevision: 1,
});
const meta = (fileId: string, title: string | null, tags: string[] = []): NoteMetadata => ({
  fileId, vaultId: 'vault', indexedBlobHash: `hash-${fileId}`, title, frontmatter: {}, headings: [], tags, blocks: [], indexedAt: 1,
});
const link = (overrides: Partial<NoteLink> & { id: string; linkPath: string }): NoteLink => ({
  vaultId: 'vault', sourceFileId: 'file-a', rawText: '', subpath: null, displayText: null,
  isEmbed: false, targetFileId: null, createdAt: 1, ...overrides,
});

describe('buildGraphPayload', () => {
  it('synthesizes attachment, tag, and unresolved nodes with index-based edges', () => {
    const files = [file('file-a', 'A.md'), file('file-b', 'B.md'), file('file-img', 'img.png', 100, 'attachment')];
    const payload = buildGraphPayload({
      files,
      metadataRows: [meta('file-a', 'Alpha', ['foo']), meta('file-b', 'Beta')],
      links: [
        link({ id: 'l1', linkPath: 'B', targetFileId: 'file-b' }),
        link({ id: 'l2', linkPath: 'img.png', targetFileId: 'file-img', isEmbed: true }),
        link({ id: 'l3', linkPath: 'Missing Note' }),
        link({ id: 'l4', sourceFileId: 'file-b', linkPath: 'Missing Note' }),
      ],
      latestRevision: 1,
      indexedRevision: 1,
    });
    expect(payload.revision).toBe(1);
    expect(payload.truncated).toBe(false);
    expect(payload).not.toHaveProperty('indexPending');
    const byId = new Map(payload.nodes.map((node, index) => [node.id, { ...node, index }]));
    expect([...byId.keys()].sort()).toEqual(['file-a', 'file-b', 'file-img', 'tag:foo', 'unresolved:Missing Note']);
    expect(byId.get('file-a')).toMatchObject({ kind: 'note', tags: ['foo'], createdAt: 100 });
    expect(byId.get('file-img')).toMatchObject({ kind: 'attachment', tags: [], createdAt: 100 });
    expect(byId.get('tag:foo')).toMatchObject({ kind: 'tag', title: '#foo', createdAt: 100 });
    expect(byId.get('unresolved:Missing Note')).toMatchObject({ kind: 'unresolved', title: 'Missing Note' });
    // Markdown notes come first so trimming prefers them.
    expect(payload.nodes.slice(0, 3).every((node) => node.kind !== 'tag' && node.kind !== 'unresolved')).toBe(true);
    const edge = (a: string, b: string) =>
      payload.edges.find((item) => item.s === byId.get(a)!.index && item.t === byId.get(b)!.index);
    expect(edge('file-a', 'file-b')).toMatchObject({ count: 1, embeds: 0 });
    expect(edge('file-a', 'file-img')).toMatchObject({ count: 1, embeds: 1 });
    expect(edge('file-a', 'tag:foo')).toMatchObject({ count: 1, embeds: 0 });
    expect(edge('file-a', 'unresolved:Missing Note')).toMatchObject({ count: 1, embeds: 0 });
    expect(edge('file-b', 'unresolved:Missing Note')).toMatchObject({ count: 1, embeds: 0 });
    for (const item of payload.edges) {
      expect(item.s).toBeLessThan(payload.nodes.length);
      expect(item.t).toBeLessThan(payload.nodes.length);
    }
  });

  it('aggregates duplicate edges and counts embeds', () => {
    const payload = buildGraphPayload({
      files: [file('file-a', 'A.md'), file('file-b', 'B.md')],
      metadataRows: [meta('file-a', 'Alpha'), meta('file-b', 'Beta')],
      links: [
        link({ id: 'l1', linkPath: 'B', targetFileId: 'file-b' }),
        link({ id: 'l2', linkPath: 'B', targetFileId: 'file-b' }),
        link({ id: 'l3', linkPath: 'B', targetFileId: 'file-b', isEmbed: true }),
      ],
      latestRevision: 2,
      indexedRevision: 2,
    });
    expect(payload.edges).toEqual([{ s: 0, t: 1, count: 3, embeds: 1 }]);
  });

  it('flags indexPending when the index lags the vault revision', () => {
    const input = {
      files: [file('file-a', 'A.md')],
      metadataRows: [meta('file-a', 'Alpha')],
      links: [],
      latestRevision: 3,
    };
    expect(buildGraphPayload({ ...input, indexedRevision: 2 })).toMatchObject({ revision: 3, indexPending: true });
    expect(buildGraphPayload({ ...input, indexedRevision: 3 })).not.toHaveProperty('indexPending');
  });

  it('dedupes unresolved targets by normalized path and skips blank links', () => {
    const payload = buildGraphPayload({
      files: [file('file-a', 'A.md', 50), file('file-b', 'B.md', 30)],
      metadataRows: [meta('file-a', 'Alpha'), meta('file-b', 'Beta')],
      links: [
        link({ id: 'l1', linkPath: '  Missing  ' }),
        link({ id: 'l2', sourceFileId: 'file-b', linkPath: 'Missing' }),
        link({ id: 'l3', linkPath: '   ' }),
      ],
      latestRevision: 1,
      indexedRevision: 1,
    });
    const unresolved = payload.nodes.filter((node) => node.kind === 'unresolved');
    expect(unresolved.map((node) => node.id)).toEqual(['unresolved:Missing']);
    // createdAt inherits the oldest referencing note.
    expect(unresolved[0]).toMatchObject({ createdAt: 30 });
  });

  it('truncates to the node limit with markdown notes first', () => {
    const count = GRAPH_NODE_LIMIT + 500;
    const files = Array.from({ length: count }, (_, index) => file(`note-${index}`, `Note-${index}.md`, index));
    const payload = buildGraphPayload({
      files,
      metadataRows: files.map((entry) => meta(entry.fileId, null)),
      links: [],
      latestRevision: 1,
      indexedRevision: 1,
    });
    expect(payload.truncated).toBe(true);
    expect(payload.nodes).toHaveLength(GRAPH_NODE_LIMIT);
    expect(payload.nodes.every((node) => node.kind === 'note')).toBe(true);
  });
});
