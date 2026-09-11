import { describe, expect, it } from 'vitest';

import { buildGraphModel } from '../src/model';
import { resolveGroupColors } from '../src/groups';

function fixture() {
  return buildGraphModel({
    nodes: [
      { id: 'a', path: 'projects/a.md', title: 'Alpha', kind: 'note', tags: ['x'] },
      { id: 'b', path: 'b.md', title: 'Beta', kind: 'note', tags: [] },
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
