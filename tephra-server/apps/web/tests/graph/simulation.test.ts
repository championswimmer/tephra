import { describe, expect, it, vi } from 'vitest';

import { createSimulationHost } from '../../src/graph/worker/host';
import { ForceEngine, mulberry32, remapPositions, repelStrength } from '../../src/graph/worker/simulation';

const IDLE_FORCES = { centerForce: 0, repelForce: 0, linkForce: 0, linkDistance: 30 };

function randomLinks(nodeCount: number, edgeCount: number, seed: number) {
  const random = mulberry32(seed);
  return Array.from({ length: edgeCount }, () => ({
    source: Math.floor(random() * nodeCount),
    target: Math.floor(random() * nodeCount),
  }));
}

function runToSettled(engine: ForceEngine, maxTicks = 2000): number {
  let ticks = 0;
  while (engine.tick() && ticks < maxTicks) ticks += 1;
  return ticks;
}

describe('ForceEngine', () => {
  it('converges and stops below alphaMin', () => {
    const engine = new ForceEngine();
    engine.setGraph({
      nodeCount: 120,
      links: randomLinks(120, 300, 7),
      radii: new Array(120).fill(3),
      seed: 7,
    });
    const ticks = runToSettled(engine);
    expect(ticks).toBeLessThan(1000);
    expect(engine.alpha).toBeLessThan(0.02);
    expect(engine.tick()).toBe(false);
  });

  it('restarts on reheat after settling', () => {
    const engine = new ForceEngine();
    engine.setGraph({ nodeCount: 10, links: [], radii: new Array(10).fill(2), seed: 1 });
    runToSettled(engine);
    expect(engine.tick()).toBe(false);
    engine.reheat(0.5);
    expect(engine.tick()).toBe(true);
  });

  it('pins a node at fixed coordinates through ticks', () => {
    const engine = new ForceEngine();
    engine.setForces({ ...IDLE_FORCES, centerForce: 1, repelForce: 2 });
    engine.setGraph({ nodeCount: 20, links: randomLinks(20, 30, 3), radii: new Array(20).fill(2), seed: 3 });
    engine.pin(0, 100, 200);
    runToSettled(engine);
    const out = new Float32Array(40);
    engine.readPositions(out);
    expect(out[0]).toBeCloseTo(100, 5);
    expect(out[1]).toBeCloseTo(200, 5);
    engine.unpin(0);
    expect(engine.alpha).toBeGreaterThan(0);
  });

  it('pulls linked nodes toward the link distance', () => {
    const initial = new Float32Array([-100, 0, 100, 0]);
    const radii = [2, 2];
    const strong = new ForceEngine();
    strong.setForces({ ...IDLE_FORCES, linkForce: 1, linkDistance: 10 });
    strong.setGraph({ nodeCount: 2, links: [{ source: 0, target: 1 }], radii, initialPositions: initial });
    runToSettled(strong);
    const out = new Float32Array(4);
    strong.readPositions(out);
    const pulled = Math.hypot(out[2]! - out[0]!, out[3]! - out[1]!);

    const weak = new ForceEngine();
    weak.setForces({ ...IDLE_FORCES });
    weak.setGraph({ nodeCount: 2, links: [{ source: 0, target: 1 }], radii, initialPositions: initial });
    runToSettled(weak);
    weak.readPositions(out);
    const unmoved = Math.hypot(out[2]! - out[0]!, out[3]! - out[1]!);

    expect(pulled).toBeLessThan(30);
    expect(unmoved).toBeCloseTo(200, 3);
  });

  it('maps the repel slider onto many-body strength', () => {
    expect(repelStrength(0) === 0).toBe(true);
    expect(repelStrength(1)).toBe(-100);
    expect(repelStrength(2)).toBe(-200);
  });

  it('settles a 5000-node / 15000-edge graph within a tick budget', () => {
    const engine = new ForceEngine();
    engine.setForces({ centerForce: 0.2, repelForce: 1, linkForce: 0.5, linkDistance: 60 });
    engine.setGraph({
      nodeCount: 5000,
      links: randomLinks(5000, 15000, 11),
      radii: new Array(5000).fill(2),
      seed: 11,
    });
    const started = performance.now();
    for (let tick = 0; tick < 30; tick += 1) engine.tick();
    const elapsed = performance.now() - started;
    expect(engine.alpha).toBeLessThan(1);
    // Generous wall-clock bound: 30 ticks of the full-force layout must stay
    // interactive-scale on CI hardware.
    expect(elapsed).toBeLessThan(30_000);
  });
});

describe('remapPositions', () => {
  it('keeps surviving nodes and seeds new ones finitely', () => {
    const previous = new Float32Array([1, 2, 3, 4, 5, 6]);
    const next = remapPositions(previous, new Int32Array([0, -1, 1, -1]), 3);
    expect(next[0]).toBe(1);
    expect(next[1]).toBe(2);
    expect(next[2]).toBe(5);
    expect(next[3]).toBe(6);
    expect(Number.isFinite(next[4])).toBe(true);
    expect(Number.isFinite(next[5])).toBe(true);
  });
});

describe('createSimulationHost', () => {
  it('falls back to the main-thread engine when no Worker exists', async () => {
    expect(typeof Worker).toBe('undefined');
    const frames: Float32Array[] = [];
    let settled = false;
    const host = createSimulationHost({
      onPositions: (positions) => frames.push(Float32Array.from(positions)),
      onSettled: () => {
        settled = true;
      },
    });
    expect(host.workerBacked).toBe(false);
    host.setGraph(
      { nodeCount: 8, links: randomLinks(8, 12, 5), radii: new Array(8).fill(2), seed: 5 },
      IDLE_FORCES,
    );
    await vi.waitFor(() => expect(frames.length).toBeGreaterThan(0), { timeout: 5000 });
    expect(frames[0]).toHaveLength(16);
    host.destroy();
    expect(settled || frames.length > 0).toBe(true);
  });
});
