import { describe, expect, it } from 'vitest';

import { createForceSimulation, DEFAULT_FORCE_PARAMS, mulberry32 } from '../src/engine/simulation';
import type { ForceSimulationInit } from '../src/engine/types';

function makeInit(
  count: number,
  edges: [number, number][],
  overrides: Partial<ForceSimulationInit> = {},
): ForceSimulationInit {
  return {
    count,
    edgeSource: Uint32Array.from(edges.map((e) => e[0])),
    edgeTarget: Uint32Array.from(edges.map((e) => e[1])),
    radii: new Float32Array(count).fill(5),
    forces: { ...DEFAULT_FORCE_PARAMS },
    seed: 42,
    ...overrides,
  };
}

function chain(n: number): [number, number][] {
  return Array.from({ length: n - 1 }, (_, i) => [i, i + 1] as [number, number]);
}

function runUntilSettled(sim: ReturnType<typeof createForceSimulation>, cap = 2000): number {
  let ticks = 0;
  while (!sim.isSettled() && ticks < cap) {
    sim.tick();
    ticks += 1;
  }
  return ticks;
}

function allFinite(sim: ReturnType<typeof createForceSimulation>): boolean {
  for (let i = 0; i < sim.count; i += 1) {
    if (!Number.isFinite(sim.x[i]!) || !Number.isFinite(sim.y[i]!)) return false;
  }
  return true;
}

function dist(sim: ReturnType<typeof createForceSimulation>, a: number, b: number): number {
  return Math.hypot(sim.x[a]! - sim.x[b]!, sim.y[a]! - sim.y[b]!);
}

describe('mulberry32', () => {
  it('is deterministic and in [0, 1)', () => {
    const a = mulberry32(7);
    const b = mulberry32(7);
    for (let i = 0; i < 100; i += 1) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('engine force simulation', () => {
  it('starts on a phyllotaxis spiral and keeps finite initial positions', () => {
    const initialX = new Float32Array([NaN, 500, NaN]);
    const initialY = new Float32Array([NaN, -200, NaN]);
    const sim = createForceSimulation(makeInit(3, [], { initialX, initialY }));
    expect(sim.alpha).toBe(1);
    expect(sim.x[1]).toBe(500);
    expect(sim.y[1]).toBe(-200);
    // Node 0: r = 10·√0.5 ≈ 7.07 at θ = 0, plus ≤ 0.5 jitter per axis.
    expect(Math.hypot(sim.x[0]!, sim.y[0]!)).toBeGreaterThan(6);
    expect(Math.hypot(sim.x[0]!, sim.y[0]!)).toBeLessThan(8.2);
    // Node 2: r = 10·√2.5 ≈ 15.8.
    expect(Math.hypot(sim.x[2]!, sim.y[2]!)).toBeGreaterThan(14.5);
    expect(Math.hypot(sim.x[2]!, sim.y[2]!)).toBeLessThan(17.2);
  });

  it('is deterministic for a given seed and differs across seeds', () => {
    const edges = chain(30);
    const a = createForceSimulation(makeInit(30, edges));
    const b = createForceSimulation(makeInit(30, edges));
    const c = createForceSimulation(makeInit(30, edges, { seed: 43 }));
    a.tick(200);
    b.tick(200);
    c.tick(200);
    expect(Array.from(a.x)).toEqual(Array.from(b.x));
    expect(Array.from(a.y)).toEqual(Array.from(b.y));
    expect(Array.from(a.x)).not.toEqual(Array.from(c.x));
  });

  it('never produces NaN with coincident starting points', () => {
    const n = 40;
    const initialX = new Float32Array(n).fill(3);
    const initialY = new Float32Array(n).fill(3);
    const edges: [number, number][] = [...chain(n), [0, 0], [5, 5], [1, 2], [1, 2]];
    const sim = createForceSimulation(makeInit(n, edges, { initialX, initialY }));
    for (let t = 0; t < 500; t += 1) {
      sim.reheat(Math.max(sim.alpha, 0.01));
      sim.tick();
    }
    expect(allFinite(sim)).toBe(true);
    // The pile actually spread out.
    let minD = Infinity;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) minD = Math.min(minD, dist(sim, i, j));
    }
    expect(minD).toBeGreaterThan(1);
  });

  it('settles within ~300 ticks and tick() is a no-op afterwards', () => {
    const sim = createForceSimulation(makeInit(50, chain(50)));
    const ticks = runUntilSettled(sim);
    expect(ticks).toBeGreaterThanOrEqual(290);
    expect(ticks).toBeLessThanOrEqual(400);
    expect(sim.isSettled()).toBe(true);
    const before = Array.from(sim.x);
    sim.tick(10);
    expect(Array.from(sim.x)).toEqual(before);
  });

  it('alphaTarget keeps the simulation hot', () => {
    const sim = createForceSimulation(makeInit(10, chain(10)));
    sim.setAlphaTarget(0.3);
    sim.tick(1000);
    expect(sim.isSettled()).toBe(false);
    expect(sim.alpha).toBeCloseTo(0.3, 2);
    sim.setAlphaTarget(0);
    expect(runUntilSettled(sim)).toBeLessThan(400);
  });

  it('reheat() restarts a settled simulation', () => {
    const sim = createForceSimulation(makeInit(5, chain(5)));
    runUntilSettled(sim);
    sim.reheat();
    expect(sim.alpha).toBe(1);
    expect(sim.isSettled()).toBe(false);
  });

  it('pinned nodes stay fixed while the rest moves', () => {
    const sim = createForceSimulation(makeInit(20, chain(20)));
    sim.pin(3, 250, -125);
    expect(sim.isPinned(3)).toBe(true);
    const before = sim.x[10]!;
    sim.tick(100);
    expect(sim.x[3]).toBe(250);
    expect(sim.y[3]).toBe(-125);
    expect(sim.x[10]).not.toBe(before);
    sim.unpin(3);
    expect(sim.isPinned(3)).toBe(false);
    sim.reheat();
    sim.tick(50);
    expect(sim.x[3]).not.toBe(250);
    // Invalid indices are ignored.
    sim.pin(-1, 0, 0);
    sim.pin(99, 0, 0);
    expect(sim.isPinned(99)).toBe(false);
  });

  it('a connected pair ends near linkDistance', () => {
    const sim = createForceSimulation(makeInit(2, [[0, 1]]));
    runUntilSettled(sim);
    const d = dist(sim, 0, 1);
    expect(d).toBeGreaterThan(70);
    expect(d).toBeLessThan(160);
  });

  it('linkDistance changes the settled edge length', () => {
    const short = createForceSimulation(
      makeInit(2, [[0, 1]], { forces: { ...DEFAULT_FORCE_PARAMS, linkDistance: 50 } }),
    );
    const long = createForceSimulation(
      makeInit(2, [[0, 1]], { forces: { ...DEFAULT_FORCE_PARAMS, linkDistance: 250 } }),
    );
    runUntilSettled(short);
    runUntilSettled(long);
    expect(dist(long, 0, 1)).toBeGreaterThan(dist(short, 0, 1) + 100);
  });

  it('unconnected components separate', () => {
    // Two 6-cliques with no edge between them.
    const edges: [number, number][] = [];
    for (const base of [0, 6]) {
      for (let i = 0; i < 6; i += 1) {
        for (let j = i + 1; j < 6; j += 1) edges.push([base + i, base + j]);
      }
    }
    const sim = createForceSimulation(makeInit(12, edges));
    runUntilSettled(sim);
    const centroid = (base: number) => {
      let cx = 0;
      let cy = 0;
      for (let i = base; i < base + 6; i += 1) {
        cx += sim.x[i]!;
        cy += sim.y[i]!;
      }
      return [cx / 6, cy / 6] as const;
    };
    const [ax, ay] = centroid(0);
    const [bx, by] = centroid(6);
    let intra = 0;
    for (let i = 0; i < 6; i += 1)
      intra = Math.max(intra, Math.hypot(sim.x[i]! - ax, sim.y[i]! - ay));
    expect(Math.hypot(ax - bx, ay - by)).toBeGreaterThan(intra * 1.5);
  });

  it('collision keeps big nodes from overlapping', () => {
    const n = 30;
    const radii = new Float32Array(n).fill(30);
    const sim = createForceSimulation(
      makeInit(n, [], { radii, forces: { ...DEFAULT_FORCE_PARAMS, repelForce: 0 } }),
    );
    runUntilSettled(sim);
    let overlaps = 0;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) if (dist(sim, i, j) < 50) overlaps += 1;
    }
    expect(overlaps).toBe(0);
  });

  it('setRadii and setForces do not reset positions', () => {
    const sim = createForceSimulation(makeInit(15, chain(15)));
    runUntilSettled(sim);
    const x = Array.from(sim.x);
    const y = Array.from(sim.y);
    const xs = sim.x;
    sim.setRadii(new Float32Array(15).fill(9));
    expect(Array.from(sim.x)).toEqual(x);
    expect(() => sim.setRadii(new Float32Array(3))).toThrow(RangeError);

    // Unchanged / invalid forces do not reheat.
    sim.setForces({ ...DEFAULT_FORCE_PARAMS });
    sim.setForces({ repelForce: NaN, linkDistance: Infinity });
    expect(sim.isSettled()).toBe(true);

    sim.setForces({ repelForce: 1.5 });
    expect(sim.alpha).toBeGreaterThanOrEqual(0.3);
    expect(sim.isSettled()).toBe(false);
    expect(Array.from(sim.x)).toEqual(x);
    expect(Array.from(sim.y)).toEqual(y);
    expect(sim.x).toBe(xs); // never reallocated

    sim.reheat(0.8);
    sim.setForces({ centerForce: 0.9 });
    expect(sim.alpha).toBe(0.8); // reheat only raises alpha
  });

  it('clamps absurd force values instead of blowing up', () => {
    const sim = createForceSimulation(
      makeInit(20, chain(20), {
        forces: { centerForce: 1e9, repelForce: -5, linkForce: 50, linkDistance: -10 },
      }),
    );
    sim.tick(300);
    expect(allFinite(sim)).toBe(true);
  });

  it('handles empty graphs and out-of-range edges', () => {
    const empty = createForceSimulation(makeInit(0, []));
    empty.tick(5);
    expect(empty.x.length).toBe(0);
    const sim = createForceSimulation(
      makeInit(3, [
        [0, 7],
        [1, 2],
      ]),
    );
    sim.tick(100);
    expect(allFinite(sim)).toBe(true);
  });
});
