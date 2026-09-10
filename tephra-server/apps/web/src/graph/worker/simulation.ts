/**
 * Worker-global-free d3-force simulation engine (plan 011 §7).
 *
 * This module never touches `postMessage`, `Worker`, `requestAnimationFrame`,
 * or the DOM, so `simulation.worker.ts` can drive it off-thread, the web UI
 * can fall back to it on the main thread, and vitest can import it directly.
 */
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum,
} from 'd3-force';

export interface ForceParameters {
  /** Obsidian Center force slider, 0..1. */
  centerForce: number;
  /** Obsidian Repel force slider, 0..2. */
  repelForce: number;
  /** Obsidian Link force slider, 0..1. */
  linkForce: number;
  /** Obsidian Link distance slider, px. */
  linkDistance: number;
}

export interface GraphTopology {
  nodeCount: number;
  links: Array<{ source: number; target: number }>;
  /** Per-node collision radius (see `nodeRadius` in model.ts). */
  radii: ArrayLike<number>;
}

export interface EngineGraphInput extends GraphTopology {
  /** Initial x/y pairs; randomly seeded when omitted. */
  initialPositions?: Float32Array | null;
  /** Deterministic seed for the initial layout. */
  seed?: number;
}

interface EngineNode extends SimulationNodeDatum {
  index: number;
}

type EngineLink = SimulationLinkDatum<EngineNode>;

/** Strength mapping from the plan: repel slider → many-body charge. */
export function repelStrength(repelForce: number): number {
  return -100 * repelForce;
}

/** Deterministic PRNG for initial layouts. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class ForceEngine {
  private simulation: Simulation<EngineNode, EngineLink> | null = null;
  private nodes: EngineNode[] = [];
  private engineLinks: EngineLink[] = [];
  private radii: ArrayLike<number> = [];
  private forces: ForceParameters = { centerForce: 0.5, repelForce: 1, linkForce: 0.5, linkDistance: 100 };

  get nodeCount(): number {
    return this.nodes.length;
  }

  get alpha(): number {
    return this.simulation?.alpha() ?? 0;
  }

  setForces(forces: ForceParameters): void {
    this.forces = forces;
    this.applyForces();
  }

  private applyForces(): void {
    const simulation = this.simulation;
    if (!simulation) return;
    const radii = this.radii;
    simulation
      .force('center', forceCenter<EngineNode>(0, 0).strength(this.forces.centerForce))
      .force('charge', forceManyBody<EngineNode>().strength(repelStrength(this.forces.repelForce)))
      .force(
        'collide',
        forceCollide<EngineNode>()
          .radius((node) => (radii[node.index] ?? 2) + 1)
          .strength(0.8),
      )
      .force(
        'link',
        forceLink<EngineNode, EngineLink>(this.engineLinks)
          .strength(this.forces.linkForce)
          .distance(this.forces.linkDistance),
      );
  }

  setGraph(input: EngineGraphInput): void {
    const { nodeCount, links, radii, seed = 1 } = input;
    const random = mulberry32(seed);
    const spread = 40 * Math.sqrt(Math.max(1, nodeCount));
    this.nodes = Array.from({ length: nodeCount }, (_, index) => {
      const node: EngineNode = { index };
      if (input.initialPositions && input.initialPositions.length >= (index + 1) * 2) {
        node.x = input.initialPositions[index * 2];
        node.y = input.initialPositions[index * 2 + 1];
      } else {
        const angle = random() * Math.PI * 2;
        const radius = spread * Math.sqrt(random());
        node.x = Math.cos(angle) * radius;
        node.y = Math.sin(angle) * radius;
      }
      return node;
    });
    const engineLinks: EngineLink[] = links
      .filter((link) => link.source < nodeCount && link.target < nodeCount)
      .map((link) => ({ source: this.nodes[link.source]!, target: this.nodes[link.target]! }));
    this.engineLinks = engineLinks;
    this.radii = radii;
    this.simulation?.stop();
    this.simulation = forceSimulation<EngineNode, EngineLink>(this.nodes)
      .alphaMin(0.02)
      .alphaDecay(0.04)
      .stop();
    this.applyForces();
    this.simulation.alpha(1);
  }

  /**
   * Advance one tick. Returns true while more ticks are needed
   * (`alpha >= alphaMin`); the driver stops the frame loop on false.
   */
  tick(): boolean {
    const simulation = this.simulation;
    if (!simulation) return false;
    if (simulation.alpha() < simulation.alphaMin()) return false;
    simulation.tick();
    return simulation.alpha() >= simulation.alphaMin();
  }

  /** Copy current x/y pairs into `out` (length >= nodeCount * 2). */
  readPositions(out: Float32Array): void {
    for (let index = 0; index < this.nodes.length; index += 1) {
      const node = this.nodes[index]!;
      out[index * 2] = node.x ?? 0;
      out[index * 2 + 1] = node.y ?? 0;
    }
  }

  pin(index: number, x: number, y: number): void {
    const node = this.nodes[index];
    if (!node) return;
    node.fx = x;
    node.fy = y;
    this.reheat(0.3);
  }

  unpin(index: number): void {
    const node = this.nodes[index];
    if (!node) return;
    node.fx = null;
    node.fy = null;
    this.reheat(0.3);
  }

  reheat(alpha = 0.6): void {
    this.simulation?.alpha(Math.max(this.simulation.alpha(), alpha));
  }

  stop(): void {
    this.simulation?.alpha(0);
  }
}

/**
 * Carry positions across a filter change: surviving nodes keep their
 * coordinates (mapped through the filter's old→new `indexMap`), new nodes
 * are seeded next to the origin. The simulation can reposition on top of
 * this instead of restarting from a random scatter.
 */
export function remapPositions(
  previous: Float32Array,
  oldToNew: Int32Array,
  newCount: number,
  seed = 1,
): Float32Array<ArrayBuffer> {
  const next = new Float32Array(newCount * 2);
  const random = mulberry32(seed);
  const placed = new Uint8Array(newCount);
  for (let old = 0; old < oldToNew.length; old += 1) {
    const mapped = oldToNew[old];
    if (mapped === undefined || mapped! < 0 || mapped! >= newCount) continue;
    if (old * 2 + 1 < previous.length) {
      next[mapped! * 2] = previous[old * 2]!;
      next[mapped! * 2 + 1] = previous[old * 2 + 1]!;
      placed[mapped!] = 1;
    }
  }
  for (let index = 0; index < newCount; index += 1) {
    if (placed[index] === 1) continue;
    next[index * 2] = (random() - 0.5) * 40;
    next[index * 2 + 1] = (random() - 0.5) * 40;
  }
  return next;
}
