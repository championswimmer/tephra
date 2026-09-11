import { describe, expect, it } from 'vitest';

import { buildGraphModel, nodeRadius } from '../src/model';

describe('buildGraphModel', () => {
  const payload = {
    nodes: [
      { id: 'a', path: 'a.md', title: 'A', kind: 'note' as const, tags: ['x'] },
      { id: 'b', path: 'b.md', title: null, kind: 'note' as const, tags: [] },
      { id: 'c', path: 'c.md', title: null, kind: 'note' as const, tags: [] },
    ],
    edges: [
      { s: 0, t: 1, count: 2, embeds: 0 },
      { s: 1, t: 2, count: 1, embeds: 0 },
      { s: 2, t: 2, count: 1, embeds: 0 }, // self-loop
    ],
  };

  it('precomputes degree weighted by link count', () => {
    const model = buildGraphModel(payload);
    expect(model.nodes.map((node) => node.degree)).toEqual([2, 3, 3]);
  });

  it('builds undirected adjacency without self-loop duplicates', () => {
    const model = buildGraphModel(payload);
    expect([...model.adjacency[0]!]).toEqual([1]);
    expect([...model.adjacency[1]!].sort()).toEqual([0, 2]);
    // Self-loop appears once in the adjacency list.
    expect([...model.adjacency[2]!]).toEqual([1, 2]);
  });

  it('indexes nodes by id and drops out-of-range edges defensively', () => {
    const model = buildGraphModel({
      ...payload,
      edges: [...payload.edges, { s: 0, t: 99, count: 1, embeds: 0 }],
    });
    expect(model.indexById.get('b')).toBe(1);
    expect(model.links).toHaveLength(3);
  });
});

describe('nodeRadius', () => {
  it('grows with the square root of degree, scaled by nodeSize', () => {
    expect(nodeRadius(0, 1)).toBe(2);
    expect(nodeRadius(4, 1)).toBe(4);
    expect(nodeRadius(4, 2)).toBe(8);
    expect(nodeRadius(9, 1)).toBe(5);
  });
});
