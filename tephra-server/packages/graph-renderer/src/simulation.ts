/**
 * Hand-rolled force simulation for the graph renderer.
 *
 * Zero dependencies on purpose: no d3, sigma, graphology, or pixi.
 * Main-thread friendly — repulsion is capped by a uniform grid so each
 * node only checks its own cell plus the eight neighbours, and the
 * simulation reports when it has settled so the renderer can idle at 0 CPU.
 *
 * Forces (all applied per {@link Simulation.tick}):
 * - repulsion: Coulomb `-repelK / d^2` between nearby pairs via the grid.
 * - springs: Hooke `linkForce * (d - linkDistance)` along each edge.
 * - center gravity: `centerForce * 0.02 * (centroid - pos)` per node.
 * - collision: positional push-apart when `d < r_i + r_j + 2`.
 *
 * Integration is semi-implicit Euler with velocity decay 0.7 and a
 * per-tick displacement clamp. Initial positions are deterministic:
 * nodes start on a seeded (mulberry32) circle of radius ~100 plus jitter,
 * so a given `seed` always produces the same layout.
 */

/** A simulated node: position, velocity, size, and pin state. */
export interface SimNode {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Render radius; also drives collision (kept in sync by the caller). */
  r: number;
  mass: number;
  pinned: boolean;
}

/** An edge endpoint pair: indices into the simulation's node array. */
export interface SimEdge {
  s: number;
  t: number;
}

/** Force sliders; mirrors the Forces section of `GraphSettings`. */
export interface SimulationForces {
  centerForce: number;
  repelForce: number;
  linkForce: number;
  linkDistance: number;
}

/** Node input: only `id` is required, everything else has a sane default. */
export interface SimNodeInput {
  id: string;
  x?: number | undefined;
  y?: number | undefined;
  r?: number | undefined;
  mass?: number | undefined;
  pinned?: boolean | undefined;
}

/** Edge input: indices into the node array passed to `createSimulation`. */
export interface SimEdgeInput {
  s: number;
  t: number;
}

export interface SimulationOptions {
  /** Seed for the deterministic initial circle layout. Defaults to 1. */
  seed?: number | undefined;
}

export interface Simulation {
  /** Live node states, in input order. Mutated in place by `tick()`. */
  readonly nodes: SimNode[];
  /**
   * Advance one step. Returns `true` when nodes moved enough to matter;
   * returns `false` once settled (renderer may then stop ticking).
   */
  tick(): boolean;
  /** Raise the temperature back up (e.g. after drag/settings change). */
  reheat(alpha?: number): void;
  /** Merge partial force updates; invalid values are ignored. */
  setForces(forces: Partial<SimulationForces>): void;
  /** Freeze a node (by index or id), optionally teleporting it first. */
  pin(indexOrId: number | string, x?: number, y?: number): void;
  /** Release a pinned node back to the simulation. */
  unpin(indexOrId: number | string): void;
  /** Interleaved `[x0, y0, x1, y1, …]` snapshot for the renderer/camera. */
  positions(): Float32Array;
}

/** Defaults match `DEFAULT_GRAPH_SETTINGS` Forces (settings.ts). */
export const DEFAULT_SIM_FORCES: SimulationForces = {
  centerForce: 0.5,
  repelForce: 1,
  linkForce: 0.5,
  linkDistance: 100,
};

/** Deterministic PRNG so the initial layout is stable for a given seed. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fraction of velocity retained per tick (semi-implicit Euler damping). */
const VELOCITY_DECAY = 0.7;
/** Max world-units a node may travel in one tick. */
const MAX_STEP = 10;
/** Per-tick cooling multiplier. */
const ALPHA_DECAY = 0.98;
/** Below this temperature the simulation reports settled. */
const ALPHA_MIN = 0.001;
/** Below this max displacement the simulation reports settled. */
const SETTLE_EPS = 0.01;
/** Repulsion strength: `repelK = repelForce * REPEL_SCALE`, `F = repelK/d^2`. */
const REPEL_SCALE = 2400;
/**
 * Spring softening: `F = linkForce * (d - linkDistance) * SPRING_SCALE`.
 * The raw slider value would explode the integrator, so it is scaled to a
 * stable stiffness range while keeping the slider's direction/intent.
 */
const SPRING_SCALE = 0.02;
/** Center pull: `F = centerForce * 0.02 * (centroid - pos)`. */
const CENTER_SCALE = 0.02;
/** Extra padding added to `r_i + r_j` for collision. */
const COLLIDE_PADDING = 2;

function toFinite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function createSimulation(
  nodeInputs: readonly SimNodeInput[],
  edgeInputs: readonly SimEdgeInput[],
  forces: Partial<SimulationForces> = {},
  options: SimulationOptions = {},
): Simulation {
  const count = nodeInputs.length;
  const random = mulberry32(options.seed ?? 1);

  const nodes: SimNode[] = nodeInputs.map((input, index) => {
    let x = toFinite(input.x, Number.NaN);
    let y = toFinite(input.y, Number.NaN);
    if (Number.isNaN(x) || Number.isNaN(y)) {
      // Seeded circle start with jitter: deterministic, overlap-free.
      const angle = (index / Math.max(1, count)) * Math.PI * 2;
      const radius = 100 + random() * 50;
      x = Math.cos(angle) * radius + (random() - 0.5) * 20;
      y = Math.sin(angle) * radius + (random() - 0.5) * 20;
    }
    return {
      id: input.id,
      x,
      y,
      vx: 0,
      vy: 0,
      r: Math.max(0.5, toFinite(input.r, 3)),
      mass: Math.max(0.1, toFinite(input.mass, 1)),
      pinned: input.pinned === true,
    };
  });
  const indexById = new Map(nodes.map((node, index) => [node.id, index] as const));

  // Keep only well-formed, non-self-loop edges for springs.
  const edges: SimEdge[] = [];
  for (const edge of edgeInputs) {
    if (
      Number.isInteger(edge.s) &&
      Number.isInteger(edge.t) &&
      edge.s >= 0 &&
      edge.t >= 0 &&
      edge.s < count &&
      edge.t < count &&
      edge.s !== edge.t
    ) {
      edges.push({ s: edge.s, t: edge.t });
    }
  }

  let current: SimulationForces = { ...DEFAULT_SIM_FORCES, ...sanitizeForces(forces, DEFAULT_SIM_FORCES) };
  let alpha = 1;

  const fx = new Float64Array(count);
  const fy = new Float64Array(count);

  function sanitizeForces(
    partial: Partial<SimulationForces>,
    fallback: SimulationForces,
  ): Partial<SimulationForces> {
    const out: Partial<SimulationForces> = {};
    if (partial.centerForce !== undefined) {
      const v = toFinite(partial.centerForce, fallback.centerForce);
      out.centerForce = Math.min(2, Math.max(0, v));
    }
    if (partial.repelForce !== undefined) {
      const v = toFinite(partial.repelForce, fallback.repelForce);
      out.repelForce = Math.min(4, Math.max(0, v));
    }
    if (partial.linkForce !== undefined) {
      const v = toFinite(partial.linkForce, fallback.linkForce);
      out.linkForce = Math.min(2, Math.max(0, v));
    }
    if (partial.linkDistance !== undefined) {
      const v = toFinite(partial.linkDistance, fallback.linkDistance);
      out.linkDistance = Math.min(600, Math.max(10, v));
    }
    return out;
  }

  function resolveIndex(indexOrId: number | string): number {
    if (typeof indexOrId === 'number') {
      return Number.isInteger(indexOrId) && indexOrId >= 0 && indexOrId < count
        ? indexOrId
        : -1;
    }
    return indexById.get(indexOrId) ?? -1;
  }

  /** Uniform-grid bucketing: each node only interacts with ~9 cells. */
  function buildGrid(cellSize: number): Map<number, number[]> {
    const grid = new Map<number, number[]>();
    for (let i = 0; i < count; i += 1) {
      const node = nodes[i]!;
      const cx = Math.floor(node.x / cellSize);
      const cy = Math.floor(node.y / cellSize);
      // Integer hash of the cell coords (collisions across far-apart
      // cells are acceptable: pairs are still filtered by true distance).
      const hash = ((cx * 73856093) ^ (cy * 19349663)) | 0;
      let bucket = grid.get(hash);
      if (bucket === undefined) {
        bucket = [];
        grid.set(hash, bucket);
      }
      bucket.push(i);
    }
    return grid;
  }

  function tick(): boolean {
    if (count === 0 || alpha < ALPHA_MIN) return false;
    fx.fill(0);
    fy.fill(0);

    const { centerForce, repelForce, linkForce, linkDistance } = current;
    const repelK = repelForce * REPEL_SCALE;
    const springK = linkForce * SPRING_SCALE;
    const centerK = centerForce * CENTER_SCALE;
    const cutoff = Math.max(60, linkDistance * 2);
    const cutoff2 = cutoff * cutoff;
    const cellSize = Math.max(60, cutoff);

    // Centroid for the gravity term.
    let cx = 0;
    let cy = 0;
    for (const node of nodes) {
      cx += node.x;
      cy += node.y;
    }
    cx /= Math.max(1, count);
    cy /= Math.max(1, count);

    // Repulsion via the grid: each node checks its own + 8 neighbour cells.
    // Pairs are processed once (j > i) with symmetric force application.
    if (repelK > 0 && count > 1) {
      const grid = buildGrid(cellSize);
      const seen = new Set<number>();
      for (let i = 0; i < count; i += 1) {
        const a = nodes[i]!;
        const acx = Math.floor(a.x / cellSize);
        const acy = Math.floor(a.y / cellSize);
        for (let ox = -1; ox <= 1; ox += 1) {
          for (let oy = -1; oy <= 1; oy += 1) {
            const hash = (((acx + ox) * 73856093) ^ ((acy + oy) * 19349663)) | 0;
            const bucket = grid.get(hash);
            if (bucket === undefined) continue;
            for (const j of bucket) {
              if (j <= i) continue;
              const pair = i * count + j;
              if (seen.has(pair)) continue;
              seen.add(pair);
              const b = nodes[j]!;
              let dx = a.x - b.x;
              let dy = a.y - b.y;
              let d2 = dx * dx + dy * dy;
              if (d2 >= cutoff2) continue;
              if (d2 < 0.01) {
                dx = 0.1;
                dy = 0;
                d2 = 0.01;
              }
              const d = Math.sqrt(d2);
              const f = repelK / d2 / d; // Coulomb, normalized to a unit vector
              const am = b.mass / (a.mass + b.mass);
              const bm = a.mass / (a.mass + b.mass);
              fx[i]! += dx * f * am * 2;
              fy[i]! += dy * f * am * 2;
              fx[j]! -= dx * f * bm * 2;
              fy[j]! -= dy * f * bm * 2;
            }
          }
        }
      }
    }

    // Springs along edges: F = linkForce * (d - linkDistance).
    for (const edge of edges) {
      const a = nodes[edge.s]!;
      const b = nodes[edge.t]!;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < 1e-6) continue;
      const f = (springK * (d - linkDistance)) / d;
      const am = b.mass / (a.mass + b.mass);
      const bm = a.mass / (a.mass + b.mass);
      fx[edge.s]! += dx * f * am * 2;
      fy[edge.s]! += dy * f * am * 2;
      fx[edge.t]! -= dx * f * bm * 2;
      fy[edge.t]! -= dy * f * bm * 2;
    }

    // Center gravity toward the centroid.
    if (centerK > 0) {
      for (let i = 0; i < count; i += 1) {
        fx[i]! += (cx - nodes[i]!.x) * centerK;
        fy[i]! += (cy - nodes[i]!.y) * centerK;
      }
    }

    // Semi-implicit Euler: velocity first (with decay), then position.
    let maxDisp = 0;
    for (let i = 0; i < count; i += 1) {
      const node = nodes[i]!;
      if (node.pinned) {
        node.vx = 0;
        node.vy = 0;
        continue;
      }
      let vx = (node.vx + (fx[i]! / node.mass) * alpha) * VELOCITY_DECAY;
      let vy = (node.vy + (fy[i]! / node.mass) * alpha) * VELOCITY_DECAY;
      const step = Math.sqrt(vx * vx + vy * vy);
      if (step > MAX_STEP) {
        const scale = MAX_STEP / step;
        vx *= scale;
        vy *= scale;
      }
      node.vx = vx;
      node.vy = vy;
      node.x += vx;
      node.y += vy;
      const disp = Math.sqrt(vx * vx + vy * vy);
      if (disp > maxDisp) maxDisp = disp;
    }

    // Collision: positional push-apart for overlapping pairs.
    const collideGrid = buildGrid(cellSize);
    const collideSeen = new Set<number>();
    for (let i = 0; i < count; i += 1) {
      const a = nodes[i]!;
      const acx = Math.floor(a.x / cellSize);
      const acy = Math.floor(a.y / cellSize);
      for (let ox = -1; ox <= 1; ox += 1) {
        for (let oy = -1; oy <= 1; oy += 1) {
          const hash = (((acx + ox) * 73856093) ^ ((acy + oy) * 19349663)) | 0;
          const bucket = collideGrid.get(hash);
          if (bucket === undefined) continue;
          for (const j of bucket) {
            if (j <= i) continue;
            const pair = i * count + j;
            if (collideSeen.has(pair)) continue;
            collideSeen.add(pair);
            const b = nodes[j]!;
            if (a.pinned && b.pinned) continue;
            const minDist = a.r + b.r + COLLIDE_PADDING;
            let dx = b.x - a.x;
            let dy = b.y - a.y;
            const d = Math.sqrt(dx * dx + dy * dy);
            if (d >= minDist || d < 1e-6) continue;
            dx /= d;
            dy /= d;
            const overlap = ((minDist - d) / 2) * Math.min(1, alpha * 2);
            if (!a.pinned) {
              a.x -= dx * overlap;
              a.y -= dy * overlap;
            }
            if (!b.pinned) {
              b.x += dx * overlap;
              b.y += dy * overlap;
            }
            if (overlap > maxDisp) maxDisp = overlap;
          }
        }
      }
    }

    alpha *= ALPHA_DECAY;
    return maxDisp > SETTLE_EPS && alpha >= ALPHA_MIN;
  }

  return {
    nodes,
    tick,
    reheat(next: number = 1): void {
      alpha = Math.min(1, Math.max(0.01, toFinite(next, 1)));
    },
    setForces(partial: Partial<SimulationForces>): void {
      current = { ...current, ...sanitizeForces(partial, current) };
      alpha = Math.max(alpha, 0.3);
    },
    pin(indexOrId: number | string, x?: number, y?: number): void {
      const index = resolveIndex(indexOrId);
      if (index < 0) return;
      const node = nodes[index]!;
      if (x !== undefined && Number.isFinite(x)) node.x = x;
      if (y !== undefined && Number.isFinite(y)) node.y = y;
      node.vx = 0;
      node.vy = 0;
      node.pinned = true;
    },
    unpin(indexOrId: number | string): void {
      const index = resolveIndex(indexOrId);
      if (index < 0) return;
      nodes[index]!.pinned = false;
    },
    positions(): Float32Array {
      const out = new Float32Array(count * 2);
      for (let i = 0; i < count; i += 1) {
        out[i * 2] = nodes[i]!.x;
        out[i * 2 + 1] = nodes[i]!.y;
      }
      return out;
    },
  };
}
