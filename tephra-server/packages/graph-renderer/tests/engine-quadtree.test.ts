import { describe, expect, it } from 'vitest';

import { createQuadtree } from '../src/engine/quadtree';
import { mulberry32 } from '../src/engine/simulation';

function randomPoints(count: number, seed: number, spread = 1000) {
  const rand = mulberry32(seed);
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const r = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    x[i] = (rand() - 0.5) * spread;
    y[i] = (rand() - 0.5) * spread;
    r[i] = rand() * 10;
  }
  return { x, y, r };
}

/** Collect every point index reachable under cell `c`. */
function pointsUnder(tree: ReturnType<typeof createQuadtree>, c: number, out: number[]): number[] {
  if (tree.cellInternal[c] === 1) {
    for (let q = 0; q < 4; q += 1) {
      const child = tree.cellChildren[c * 4 + q]!;
      if (child >= 0) pointsUnder(tree, child, out);
    }
  } else {
    for (let j = tree.cellHead[c]!; j >= 0; j = tree.pointNext[j]!) out.push(j);
  }
  return out;
}

describe('engine quadtree', () => {
  it('indexes every point exactly once inside its cell bounds', () => {
    const { x, y } = randomPoints(500, 1);
    const tree = createQuadtree();
    tree.rebuild(x, y, 500);
    const seen = pointsUnder(tree, 0, []).sort((a, b) => a - b);
    expect(seen).toEqual(Array.from({ length: 500 }, (_, i) => i));
    for (let c = 0; c < tree.cellCount; c += 1) {
      if (tree.cellInternal[c] === 1) continue;
      const x0 = tree.cellX0[c]!;
      const y0 = tree.cellY0[c]!;
      const s = tree.cellSize[c]!;
      for (let j = tree.cellHead[c]!; j >= 0; j = tree.pointNext[j]!) {
        expect(x[j]!).toBeGreaterThanOrEqual(x0 - 1e-9);
        expect(x[j]!).toBeLessThanOrEqual(x0 + s + 1e-9);
        expect(y[j]!).toBeGreaterThanOrEqual(y0 - 1e-9);
        expect(y[j]!).toBeLessThanOrEqual(y0 + s + 1e-9);
      }
    }
  });

  it('Barnes–Hut aggregates match brute force for every cell', () => {
    const { x, y, r } = randomPoints(300, 2);
    const rand = mulberry32(99);
    const weights = new Float64Array(300).map(() => 0.5 + rand() * 2);
    const tree = createQuadtree();
    tree.rebuild(x, y, 300, { weights, radii: r });
    for (let c = 0; c < tree.cellCount; c += 1) {
      const pts = pointsUnder(tree, c, []);
      let charge = 0;
      let mx = 0;
      let my = 0;
      let maxR = 0;
      for (const j of pts) {
        charge += weights[j]!;
        mx += weights[j]! * x[j]!;
        my += weights[j]! * y[j]!;
        maxR = Math.max(maxR, r[j]!);
      }
      expect(tree.cellCharge[c]!).toBeCloseTo(charge, 9);
      expect(tree.cellMassX[c]!).toBeCloseTo(mx / charge, 6);
      expect(tree.cellMassY[c]!).toBeCloseTo(my / charge, 6);
      expect(tree.cellMaxRadius[c]!).toBe(maxR);
    }
    // Root sees everything; default weights count points.
    tree.rebuild(x, y, 300);
    expect(tree.cellCharge[0]).toBe(300);
  });

  it('chains coincident points instead of subdividing forever', () => {
    const x = new Float64Array([5, 5, 5, 5, 7]);
    const y = new Float64Array([5, 5, 5, 5, 7]);
    const tree = createQuadtree();
    tree.rebuild(x, y, 5);
    expect(pointsUnder(tree, 0, []).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(tree.cellCharge[0]).toBe(5);
    expect(tree.cellCount).toBeLessThan(20);
  });

  it('nearest() matches brute force (centres)', () => {
    const { x, y } = randomPoints(400, 3);
    const tree = createQuadtree();
    tree.rebuild(x, y, 400);
    const rand = mulberry32(7);
    for (let q = 0; q < 300; q += 1) {
      const px = (rand() - 0.5) * 1200;
      const py = (rand() - 0.5) * 1200;
      const maxD = rand() * 80;
      let best = -1;
      let bestD = Infinity;
      for (let i = 0; i < 400; i += 1) {
        const d = Math.hypot(x[i]! - px, y[i]! - py);
        if (d <= maxD && d < bestD) {
          best = i;
          bestD = d;
        }
      }
      const got = tree.nearest(px, py, maxD);
      if (best < 0) expect(got).toBe(-1);
      else expect(Math.hypot(x[got]! - px, y[got]! - py)).toBeCloseTo(bestD, 9);
    }
  });

  it('nearest() respects per-node radii (rim distance)', () => {
    const { x, y, r } = randomPoints(400, 4);
    const tree = createQuadtree();
    tree.rebuild(x, y, 400, { radii: r });
    const rand = mulberry32(8);
    for (let q = 0; q < 300; q += 1) {
      const px = (rand() - 0.5) * 1200;
      const py = (rand() - 0.5) * 1200;
      const maxD = rand() * 40;
      let best = -1;
      let bestScore = Infinity;
      for (let i = 0; i < 400; i += 1) {
        const s = Math.hypot(x[i]! - px, y[i]! - py) - r[i]!;
        if (s <= maxD && s < bestScore) {
          best = i;
          bestScore = s;
        }
      }
      const got = tree.nearest(px, py, maxD);
      if (best < 0) expect(got).toBe(-1);
      else expect(Math.hypot(x[got]! - px, y[got]! - py) - r[got]!).toBeCloseTo(bestScore, 9);
    }
    // A point inside a big circle picks that circle even if another centre is closer.
    const bx = new Float32Array([0, 30]);
    const by = new Float32Array([0, 0]);
    tree.rebuild(bx, by, 2, { radii: new Float32Array([25, 1]) });
    expect(tree.nearest(20, 0, 0)).toBe(0);
    expect(tree.nearest(100, 100, 5)).toBe(-1);
  });

  it('visitWithin() matches brute force', () => {
    const { x, y, r } = randomPoints(300, 5);
    const tree = createQuadtree();
    tree.rebuild(x, y, 300, { radii: r });
    const found: number[] = [];
    const visit = (i: number) => {
      found.push(i);
    };
    tree.visitWithin(10, -20, 120, visit);
    const expected: number[] = [];
    for (let i = 0; i < 300; i += 1) {
      if (Math.hypot(x[i]! - 10, y[i]! + 20) - r[i]! <= 120) expected.push(i);
    }
    expect(found.sort((a, b) => a - b)).toEqual(expected);
  });

  it('handles empty input, non-finite points, and reuse across rebuilds', () => {
    const tree = createQuadtree();
    tree.rebuild(new Float64Array(0), new Float64Array(0), 0);
    expect(tree.cellCount).toBe(0);
    expect(tree.nearest(0, 0, 100)).toBe(-1);

    tree.rebuild(new Float64Array([NaN, 1, Infinity]), new Float64Array([0, 1, 2]), 3);
    expect(pointsUnder(tree, 0, [])).toEqual([1]);
    expect(tree.nearest(0, 0, 10)).toBe(1);

    const big = randomPoints(2000, 6);
    tree.rebuild(big.x, big.y, 2000);
    expect(pointsUnder(tree, 0, []).length).toBe(2000);
    const small = randomPoints(10, 7);
    tree.rebuild(small.x, small.y, 10);
    expect(pointsUnder(tree, 0, []).length).toBe(10);
    expect(tree.pointCount).toBe(10);
  });
});
