import { describe, expect, it } from 'vitest';

import { nodesWithinDepth, subgraph } from '../src/depth';
import { buildGraphModel, type GraphModel } from '../src/model';

// a - b - c - d, plus a cycle a - d.
function fixture(): GraphModel {
  return buildGraphModel({
    nodes: ['a', 'b', 'c', 'd'].map((id) => ({
      id,
      path: `${id}.md`,
      title: null,
      kind: 'note' as const,
      tags: [],
    })),
    edges: [
      { s: 0, t: 1, count: 1, embeds: 0 },
      { s: 1, t: 2, count: 1, embeds: 0 },
      { s: 2, t: 3, count: 1, embeds: 0 },
      { s: 0, t: 3, count: 1, embeds: 0 },
    ],
  });
}

describe('nodesWithinDepth', () => {
  it('returns only the root at depth 0', () => {
    const ids = [...nodesWithinDepth(fixture(), 'a', 0)];
    expect(ids).toEqual([0]);
  });

  it('reaches direct neighbours at depth 1', () => {
    const model = fixture();
    const ids = [...nodesWithinDepth(model, 'a', 1)].sort();
    expect(ids).toEqual([0, 1, 3]); // b and d, via the cycle
  });

  it('expands hop by hop and terminates on cycles', () => {
    const model = fixture();
    expect([...nodesWithinDepth(model, 'a', 2)].sort()).toEqual([0, 1, 2, 3]);
    expect([...nodesWithinDepth(model, 'a', 3)].sort()).toEqual([0, 1, 2, 3]);
  });

  it('returns an empty set for an unknown root', () => {
    expect(nodesWithinDepth(fixture(), 'missing', 2).size).toBe(0);
  });
});

describe('subgraph', () => {
  it('reindexes nodes and links compactly', () => {
    const model = fixture();
    const sub = subgraph(model, new Set([1, 2, 3]));
    expect(sub.nodes.map((node) => node.id)).toEqual(['b', 'c', 'd']);
    expect(sub.links).toEqual([
      { source: 0, target: 1, count: 1, embeds: 0 },
      { source: 1, target: 2, count: 1, embeds: 0 },
    ]);
    expect([...sub.adjacency[1]!].sort()).toEqual([0, 2]);
  });
});
