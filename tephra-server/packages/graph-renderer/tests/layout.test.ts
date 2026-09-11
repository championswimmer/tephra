import { describe, expect, it } from 'vitest';

import { forcesToFA2Settings } from '../src/layout';
import { DEFAULT_GRAPH_SETTINGS } from '../src/settings';

describe('forcesToFA2Settings', () => {
  it('maps Obsidian defaults to sane ForceAtlas2 settings', () => {
    const settings = forcesToFA2Settings(DEFAULT_GRAPH_SETTINGS);
    expect(settings).toEqual({
      gravity: 1,
      scalingRatio: 1 + 2 + ((100 - 30) / (300 - 30)) * 4,
      edgeWeightInfluence: 0.5,
      slowDown: 10,
      barnesHutOptimize: true,
    });
  });

  it('is monotonic in every slider', () => {
    const base = { ...DEFAULT_GRAPH_SETTINGS };
    const low = forcesToFA2Settings({
      ...base,
      centerForce: 0,
      repelForce: 0,
      linkForce: 0,
      linkDistance: 30,
    });
    const high = forcesToFA2Settings({
      ...base,
      centerForce: 1,
      repelForce: 2,
      linkForce: 1,
      linkDistance: 300,
    });
    expect(high.gravity).toBeGreaterThan(low.gravity);
    expect(high.scalingRatio).toBeGreaterThan(low.scalingRatio);
    expect(high.edgeWeightInfluence).toBeGreaterThan(low.edgeWeightInfluence);
  });
});
