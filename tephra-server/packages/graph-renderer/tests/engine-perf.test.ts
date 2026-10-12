import { describe, expect, it } from 'vitest';

import { createForceSimulation, DEFAULT_FORCE_PARAMS, mulberry32 } from '../src/engine/simulation';

/**
 * Synthetic vault-like graph: preferential attachment so a few hubs collect
 * many links (like index notes), seeded so the run is reproducible.
 */
function syntheticGraph(nodes: number, edges: number, seed: number) {
  const rand = mulberry32(seed);
  const source = new Uint32Array(edges);
  const target = new Uint32Array(edges);
  for (let e = 0; e < edges; e += 1) {
    const s = Math.floor(rand() * nodes);
    // Bias targets toward low indices (hubs).
    let t = Math.floor(rand() * rand() * nodes);
    if (t === s) t = (t + 1) % nodes;
    source[e] = s;
    target[e] = t;
  }
  const radii = new Float32Array(nodes);
  for (let i = 0; i < nodes; i += 1) radii[i] = 3 + rand() * 6;
  return { source, target, radii };
}

describe('engine simulation performance', () => {
  it('runs 300 ticks of a 1 000-node / 2 000-edge graph quickly and settles', () => {
    const { source, target, radii } = syntheticGraph(1000, 2000, 1234);
    const sim = createForceSimulation({
      count: 1000,
      edgeSource: source,
      edgeTarget: target,
      radii,
      forces: { ...DEFAULT_FORCE_PARAMS },
      seed: 1,
    });

    // Warm up the JIT on a separate instance so timing reflects steady state.
    createForceSimulation({
      count: 1000,
      edgeSource: source,
      edgeTarget: target,
      radii,
      forces: { ...DEFAULT_FORCE_PARAMS },
      seed: 2,
    }).tick(20);

    const start = performance.now();
    let ticks = 0;
    while (!sim.isSettled() && ticks < 400) {
      sim.tick();
      ticks += 1;
    }
    const elapsed = performance.now() - start;
    const perTick = elapsed / ticks;

    expect(sim.isSettled()).toBe(true);
    expect(ticks).toBeLessThanOrEqual(310);
    // Generous CI bound; locally this is ~1 ms/tick.
    expect(elapsed).toBeLessThan(3000);
    expect(perTick).toBeLessThan(10);

    let spreadX = 0;
    for (let i = 0; i < 1000; i += 1) {
      expect(Number.isFinite(sim.x[i]!)).toBe(true);
      expect(Number.isFinite(sim.y[i]!)).toBe(true);
      spreadX = Math.max(spreadX, Math.abs(sim.x[i]!));
    }
    // The layout actually expanded from the ~316-unit phyllotaxis start.
    expect(spreadX).toBeGreaterThan(300);
  });
});
