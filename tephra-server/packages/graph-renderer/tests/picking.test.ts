import { describe, expect, it } from 'vitest';

import { createCamera } from '../src/camera';
import { createNodePicker, isNodeInViewport } from '../src/picking';

const IDENTITY = createCamera();

describe('hitTest', () => {
  it('returns null on an empty index', () => {
    const picker = createNodePicker();
    expect(picker.size).toBe(0);
    expect(picker.hitTest(10, 10, IDENTITY)).toBeNull();
  });

  it('hits a node center and misses outside its radius', () => {
    const picker = createNodePicker();
    picker.rebuild([{ id: 'a', x: 100, y: 100, r: 10 }]);
    expect(picker.size).toBe(1);
    expect(picker.hitTest(100, 100, IDENTITY)).toBe('a');
    expect(picker.hitTest(105, 100, IDENTITY)).toBe('a');
    expect(picker.hitTest(111, 100, IDENTITY)).toBeNull();
  });

  it('prefers the nearest center on overlap', () => {
    const picker = createNodePicker();
    picker.rebuild([
      { id: 'a', x: 0, y: 0, r: 20 },
      { id: 'b', x: 10, y: 0, r: 20 },
    ]);
    expect(picker.hitTest(9, 0, IDENTITY)).toBe('b');
    expect(picker.hitTest(1, 0, IDENTITY)).toBe('a');
  });

  it('finds nodes far from the origin via the grid', () => {
    const picker = createNodePicker();
    const nodes = Array.from({ length: 500 }, (_, i) => ({
      id: `n${i}`,
      x: i * 100,
      y: -i * 50,
      r: 8,
    }));
    picker.rebuild(nodes);
    expect(picker.hitTest(25000, -12500, IDENTITY)).toBe('n250');
    expect(picker.hitTest(25050, -12500, IDENTITY)).toBeNull();
  });

  it('accounts for the camera transform (zoom + pan)', () => {
    const picker = createNodePicker();
    picker.rebuild([{ id: 'a', x: 10, y: 10, r: 5 }]);
    const cam = createCamera({ x: 100, y: 0, k: 2 });
    // World (10,10) -> screen (120, 20).
    expect(picker.hitTest(120, 20, cam)).toBe('a');
    expect(picker.hitTest(0, 0, cam)).toBeNull();
  });

  it('supports slop tolerance for tiny nodes', () => {
    const picker = createNodePicker();
    picker.rebuild([{ id: 'a', x: 0, y: 0, r: 2 }]);
    expect(picker.hitTest(5, 0, IDENTITY)).toBeNull();
    expect(picker.hitTest(5, 0, IDENTITY, 4)).toBe('a');
  });

  it('rebuild replaces the previous index', () => {
    const picker = createNodePicker();
    picker.rebuild([{ id: 'a', x: 0, y: 0, r: 10 }]);
    picker.rebuild([{ id: 'b', x: 50, y: 50, r: 10 }]);
    expect(picker.size).toBe(1);
    expect(picker.hitTest(0, 0, IDENTITY)).toBeNull();
    expect(picker.hitTest(50, 50, IDENTITY)).toBe('b');
  });
});

describe('nodesInViewport', () => {
  const nodes = [
    { id: 'center', x: 400, y: 300, r: 10 },
    { id: 'corner', x: 790, y: 590, r: 5 },
    { id: 'far', x: 5000, y: 5000, r: 10 },
    { id: 'rim', x: 815, y: 300, r: 20 }, // rim overlaps the right edge
  ];
  const viewport = { width: 800, height: 600 };

  it('culls off-screen nodes but keeps rim-overlapping ones', () => {
    const picker = createNodePicker();
    picker.rebuild(nodes);
    expect(picker.nodesInViewport(IDENTITY, viewport)).toEqual([
      'center',
      'corner',
      'rim',
    ]);
  });

  it('follows the camera', () => {
    const picker = createNodePicker();
    picker.rebuild(nodes);
    const cam = createCamera({ x: -4900, y: -4900, k: 1 });
    expect(picker.nodesInViewport(cam, viewport)).toEqual(['far']);
  });

  it('returns empty for an empty index', () => {
    expect(createNodePicker().nodesInViewport(IDENTITY, viewport)).toEqual([]);
  });

  it('handles zoomed-out views covering everything', () => {
    const picker = createNodePicker();
    picker.rebuild(nodes);
    // Zoomed out 10x from the origin: visible world spans 8000x6000.
    const cam = createCamera({ x: 0, y: 0, k: 0.1 });
    const visible = picker.nodesInViewport(cam, viewport);
    expect(visible).toContain('far');
  });
});

describe('isNodeInViewport', () => {
  const viewport = { width: 800, height: 600 };

  it('matches the picker culling for inside/outside/rim nodes', () => {
    expect(isNodeInViewport({ id: 'a', x: 10, y: 10, r: 5 }, IDENTITY, viewport)).toBe(true);
    expect(
      isNodeInViewport({ id: 'b', x: 5000, y: 5000, r: 5 }, IDENTITY, viewport),
    ).toBe(false);
    // Center off-screen but radius overlaps the edge.
    expect(isNodeInViewport({ id: 'c', x: 805, y: 10, r: 10 }, IDENTITY, viewport)).toBe(
      true,
    );
  });
});
