import { describe, expect, it } from 'vitest';

import { createSimulation } from '../src/simulation';

function chainInputs(n: number) {
  const nodes = Array.from({ length: n }, (_, i) => ({ id: `n${i}` }));
  const edges = Array.from({ length: n - 1 }, (_, i) => ({ s: i, t: i + 1 }));
  return { nodes, edges };
}

/** Run until settled; returns the number of ticks that reported movement. */
function runUntilSettled(sim: ReturnType<typeof createSimulation>, cap = 2000): number {
  let moving = 0;
  for (let i = 0; i < cap; i += 1) {
    if (!sim.tick()) break;
    moving += 1;
  }
  return moving;
}

function edgeLengths(sim: ReturnType<typeof createSimulation>, edges: { s: number; t: number }[]) {
  return edges.map(({ s, t }) => {
    const a = sim.nodes[s]!;
    const b = sim.nodes[t]!;
    return Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2);
  });
}

describe('simulation', () => {
  it('converges: linked nodes settle near linkDistance', () => {
    const { nodes, edges } = chainInputs(8);
    const sim = createSimulation(nodes, edges, { linkDistance: 100 });
    runUntilSettled(sim);
    // One extra tick from the settled state stays settled.
    expect(sim.tick()).toBe(false);
    const lengths = edgeLengths(sim, edges);
    const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
    expect(mean).toBeGreaterThan(30);
    expect(mean).toBeLessThan(250);
    for (const length of lengths) {
      expect(Number.isFinite(length)).toBe(true);
      expect(length).toBeGreaterThan(5);
    }
  });

  it('settles: tick() eventually returns false', () => {
    const { nodes, edges } = chainInputs(12);
    const sim = createSimulation(nodes, edges);
    const moving = runUntilSettled(sim, 2000);
    expect(moving).toBeGreaterThan(0); // it actually simulated something
    expect(moving).toBeLessThan(2000); // …and then settled on its own
    expect(sim.tick()).toBe(false);
  });

  it('is deterministic: same seed gives identical positions', () => {
    const { nodes, edges } = chainInputs(10);
    const a = createSimulation(nodes, edges, {}, { seed: 42 });
    const b = createSimulation(nodes, edges, {}, { seed: 42 });
    runUntilSettled(a);
    runUntilSettled(b);
    expect([...a.positions()]).toEqual([...b.positions()]);
  });

  it('seeds matter: different seeds give different starts', () => {
    const { nodes, edges } = chainInputs(6);
    const a = createSimulation(nodes, edges, {}, { seed: 1 });
    const b = createSimulation(nodes, edges, {}, { seed: 2 });
    expect([...a.positions()]).not.toEqual([...b.positions()]);
  });

  it('pin freezes a node; unpin releases it', () => {
    const { nodes, edges } = chainInputs(5);
    const sim = createSimulation(nodes, edges, {}, { seed: 7 });
    sim.pin(0, 500, 500);
    runUntilSettled(sim);
    expect(sim.nodes[0]!.x).toBe(500);
    expect(sim.nodes[0]!.y).toBe(500);
    sim.unpin(0);
    sim.reheat();
    expect(sim.tick()).toBe(true);
  });

  it('reheat restarts a settled simulation and setForces applies', () => {
    const { nodes, edges } = chainInputs(6);
    const sim = createSimulation(nodes, edges, {}, { seed: 3 });
    runUntilSettled(sim);
    expect(sim.tick()).toBe(false);
    sim.setForces({ linkDistance: 200 });
    sim.reheat();
    expect(sim.tick()).toBe(true);
    // Garbage force updates are ignored, never NaN.
    sim.setForces({ linkDistance: Number.NaN, repelForce: Number.POSITIVE_INFINITY });
    for (let i = 0; i < 50; i += 1) sim.tick();
    for (const node of sim.nodes) {
      expect(Number.isFinite(node.x)).toBe(true);
      expect(Number.isFinite(node.y)).toBe(true);
    }
  });

  it('handles empty and single-node graphs without crashing', () => {
    expect(createSimulation([], []).tick()).toBe(false);
    const single = createSimulation([{ id: 'only' }], []);
    runUntilSettled(single);
    expect(single.positions()).toHaveLength(2);
  });
});
