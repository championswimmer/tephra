import { describe, expect, it } from 'vitest';

import { applyFilters, type FilterState } from '../src/filter';
import { buildGraphModel, type GraphModel } from '../src/model';

const baseFilters: FilterState = {
  search: '',
  showTags: true,
  showAttachments: true,
  existingOnly: false,
  showOrphans: true,
};

/** a -- b -- c, a tagged #x, d is an orphan, u is an unresolved target of c. */
function fixture(): GraphModel {
  return buildGraphModel({
    nodes: [
      { id: 'a', path: 'a.md', title: 'Alpha', kind: 'note', tags: ['x'] },
      { id: 'b', path: 'b.md', title: 'Beta', kind: 'note', tags: [] },
      { id: 'c', path: 'c.md', title: 'Gamma', kind: 'note', tags: [] },
      { id: 'd', path: 'd.md', title: 'Delta', kind: 'note', tags: [] },
      { id: 'img', path: 'img.png', title: null, kind: 'attachment', tags: [] },
      { id: 'tag:x', path: 'x', title: '#x', kind: 'tag', tags: [] },
      { id: 'unresolved:Missing', path: 'Missing', title: 'Missing', kind: 'unresolved', tags: [] },
    ],
    edges: [
      { s: 0, t: 1, count: 1, embeds: 0 },
      { s: 1, t: 2, count: 1, embeds: 0 },
      { s: 0, t: 5, count: 1, embeds: 0 },
      { s: 1, t: 4, count: 1, embeds: 1 },
      { s: 2, t: 6, count: 1, embeds: 0 },
    ],
  });
}

describe('applyFilters', () => {
  it('passes everything through with permissive defaults', () => {
    const { model, removedCount } = applyFilters(fixture(), baseFilters);
    expect(model.nodes).toHaveLength(7);
    expect(removedCount).toBe(0);
  });

  it('removes tag and attachment nodes when toggled off', () => {
    const { model } = applyFilters(fixture(), {
      ...baseFilters,
      showTags: false,
      showAttachments: false,
    });
    expect(model.nodes.every((node) => node.kind === 'note' || node.kind === 'unresolved')).toBe(
      true,
    );
    expect(model.indexById.has('tag:x')).toBe(false);
    expect(model.indexById.has('img')).toBe(false);
  });

  it('removes unresolved nodes with existingOnly', () => {
    const { model } = applyFilters(fixture(), { ...baseFilters, existingOnly: true });
    expect(model.indexById.has('unresolved:Missing')).toBe(false);
    expect(model.nodes.some((node) => node.kind === 'unresolved')).toBe(false);
  });

  it('removes orphans only after every other filter ran', () => {
    // Hiding attachments orphans nothing here, but hiding the search-mismatched
    // notes would; assert d (true orphan) goes first and b survives via a.
    const { model } = applyFilters(fixture(), { ...baseFilters, showOrphans: false });
    expect(model.indexById.has('d')).toBe(false);
    expect(model.indexById.has('a')).toBe(true);
  });

  it('treats a note orphaned only by hidden kinds as an orphan', () => {
    // Search keeps only a; with tags/attachments hidden and existingOnly,
    // a retains no surviving neighbours → removed as an orphan too.
    const { model } = applyFilters(fixture(), {
      ...baseFilters,
      showTags: false,
      showAttachments: false,
      existingOnly: true,
      showOrphans: false,
      search: 'alpha',
    });
    expect(model.nodes).toHaveLength(0);
  });

  it('keeps tag nodes that still touch a search-matching note', () => {
    const { model } = applyFilters(fixture(), { ...baseFilters, search: 'alpha' });
    expect(model.indexById.has('a')).toBe(true);
    expect(model.indexById.has('tag:x')).toBe(true);
    expect(model.indexById.has('b')).toBe(false);
  });

  it('reindexes links and reports a stable index map', () => {
    const { model, indexMap } = applyFilters(fixture(), { ...baseFilters, search: 'alpha' });
    expect(model.indexById.get('a')).toBe(0);
    expect(indexMap[0]).toBe(0);
    expect(indexMap[1]).toBe(-1);
    for (const link of model.links) {
      expect(link.source).toBeLessThan(model.nodes.length);
      expect(link.target).toBeLessThan(model.nodes.length);
    }
  });
});
