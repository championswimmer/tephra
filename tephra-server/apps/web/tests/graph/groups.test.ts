import { describe, expect, it } from 'vitest';

import { buildGraphModel } from '../../src/graph/model';
import { resolveGroupColors } from '../../src/graph/renderer/groups';

function fixture() {
  return buildGraphModel({
    nodes: [
      { id: 'a', path: 'projects/a.md', title: 'Alpha', kind: 'note', tags: ['x'], createdAt: 1 },
      { id: 'b', path: 'b.md', title: 'Beta', kind: 'note', tags: [], createdAt: 2 },
    ],
    edges: [],
  });
}

describe('resolveGroupColors', () => {
  it('returns nulls when there are no groups', () => {
    expect(resolveGroupColors(fixture(), [])).toEqual([null, null]);
  });

  it('applies the first matching group and skips empty queries', () => {
    expect(
      resolveGroupColors(fixture(), [
        { query: '', color: '#111111' },
        { query: 'tag:#x', color: '#ff0000' },
        { query: 'alpha', color: '#00ff00' },
      ]),
    ).toEqual(['#ff0000', null]);
  });
});
