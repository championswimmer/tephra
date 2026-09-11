import { describe, expect, it } from 'vitest';

import { buildGraphologyGraph, SIGMA_SIZE_SCALE } from '../src/graphology';
import { buildGraphModel } from '../src/model';
import { FALLBACK_GRAPH_PALETTE } from '../src/palette';

const options = {
  nodeSize: 1,
  linkThickness: 1,
  palette: FALLBACK_GRAPH_PALETTE,
  seed: 7,
};

function twoNodes() {
  return buildGraphModel({
    nodes: [
      { id: 'a', path: 'a.md', title: 'Alpha', kind: 'note', tags: ['x'] },
      { id: 'tag:x', path: 'x', title: '#x', kind: 'tag', tags: [] },
    ],
    edges: [{ s: 0, t: 1, count: 2, embeds: 0 }],
  });
}

describe('buildGraphologyGraph', () => {
  it('creates one node and one edge per model entry', () => {
    const graph = buildGraphologyGraph(twoNodes(), { ...options, groupColors: [null, null] });
    expect(graph.order).toBe(2);
    expect(graph.size).toBe(1);
    expect(graph.getNodeAttribute('a', 'label')).toBe('Alpha');
  });

  it('prefers group colors over kind colors', () => {
    const graph = buildGraphologyGraph(twoNodes(), { ...options, groupColors: ['#ff0000', null] });
    expect(graph.getNodeAttribute('a', 'color')).toBe('#ff0000');
    expect(graph.getNodeAttribute('tag:x', 'color')).toBe(FALLBACK_GRAPH_PALETTE.tag);
  });

  it('scales node size with degree and edge size with link count', () => {
    const graph = buildGraphologyGraph(twoNodes(), { ...options, groupColors: [null, null] });
    // degree 2 -> (2 + sqrt(2)) * SIGMA_SIZE_SCALE; tag node same.
    expect(graph.getNodeAttribute('a', 'size')).toBeCloseTo((2 + Math.SQRT2) * SIGMA_SIZE_SCALE);
    expect(graph.getEdgeAttributes(graph.edge('a', 'tag:x')!).size).toBeCloseTo(2);
  });

  it('assigns deterministic initial positions for a seed', () => {
    const first = buildGraphologyGraph(twoNodes(), { ...options, groupColors: [null, null] });
    const second = buildGraphologyGraph(twoNodes(), { ...options, groupColors: [null, null] });
    expect(first.getNodeAttribute('a', 'x')).toBe(second.getNodeAttribute('a', 'x'));
    expect(first.getNodeAttribute('a', 'y')).toBe(second.getNodeAttribute('a', 'y'));
  });

  it('dedupes parallel edges and skips self loops', () => {
    const model = buildGraphModel({
      nodes: [{ id: 'a', path: 'a.md', title: null, kind: 'note', tags: [] }],
      edges: [
        { s: 0, t: 0, count: 1, embeds: 0 },
        { s: 0, t: 0, count: 1, embeds: 0 },
      ],
    });
    expect(buildGraphologyGraph(model, { ...options, groupColors: [null] }).size).toBe(0);
  });
});
