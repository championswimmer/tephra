/**
 * d3-force-equivalent force simulation on flat typed arrays (plan 018).
 *
 * Zero dependencies and browser-safe. Semantics follow d3-force so layouts
 * look like Obsidian's graph view (which uses d3-force under the hood):
 *
 * - Start: phyllotaxis `r = 10·√(0.5 + i)`, `θ = i·π(3 − √5)` plus a tiny
 *   seeded jitter; finite `initialX/Y` entries are kept as-is.
 * - Cooling: `alpha` starts at 1 and each tick moves toward `alphaTarget` by
 *   `alphaDecay = 1 − alphaMin^(1/300)`; settled once both drop below
 *   `alphaMin = 0.001` (≈300 ticks). Velocities decay by 0.4 per tick.
 * - Forces, applied in this order every tick (same as registering them on a
 *   d3 simulation in this order):
 *   1. link: d3 `forceLink` — distance `linkDistance`, strength
 *      `linkForce / min(deg(s), deg(t))`, bias `deg(s) / (deg(s) + deg(t))`,
 *      one iteration, self-loops ignored;
 *   2. many-body: d3 `forceManyBody` via Barnes–Hut (θ = 0.9, compared as
 *      θ² like d3), strength `−(repelForce·300 + 30)`, `distanceMin² = 1`,
 *      no `distanceMax`;
 *   3. centering: d3 `forceX(0)` + `forceY(0)` with strength
 *      `centerForce·0.1`;
 *   4. collide: d3 `forceCollide` with radius `r_i + 2`, strength 0.7, one
 *      iteration.
 * - Pinned nodes keep their position and have their velocity zeroed.
 *
 * Performance: all state lives in typed arrays allocated at construction;
 * the shared quadtree pools are reused across rebuilds, so a steady-state
 * tick allocates nothing. Coincident points are separated with d3's
 * `jiggle` driven by a seeded PRNG, so a given seed is fully deterministic.
 * Every integration step is guarded against NaN / Infinity.
 */

import { createQuadtree } from './quadtree';
import type { ForceParams, ForceSimulation, ForceSimulationInit } from './types';

/** Default force sliders; matches `DEFAULT_GRAPH_SETTINGS`. */
export const DEFAULT_FORCE_PARAMS: ForceParams = {
  centerForce: 0.5,
  repelForce: 1,
  linkForce: 0.5,
  linkDistance: 100,
};

/** Small, fast, seedable PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHA_MIN = 0.001;
const ALPHA_DECAY = 1 - Math.pow(ALPHA_MIN, 1 / 300);
const VELOCITY_KEEP = 1 - 0.4;
const THETA2 = 0.9 * 0.9;
const DISTANCE_MIN2 = 1;
const COLLIDE_STRENGTH = 0.7;
const COLLIDE_PADDING = 2;
const INITIAL_RADIUS = 10;
const INITIAL_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** World units of seeded jitter added to phyllotaxis starts. */
const START_JITTER = 0.5;
/** Velocity magnitude cap (world units / tick) — only reached on blow-ups. */
const MAX_VELOCITY = 1e5;

/** Sanity bounds for force sliders (wider than the UI's slider ranges). */
const FORCE_LIMITS: Record<keyof ForceParams, { min: number; max: number }> = {
  centerForce: { min: 0, max: 10 },
  repelForce: { min: 0, max: 100 },
  linkForce: { min: 0, max: 1 },
  linkDistance: { min: 1, max: 10_000 },
};

const FORCE_KEYS = ['centerForce', 'repelForce', 'linkForce', 'linkDistance'] as const;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Merge `patch` into `base`, ignoring non-finite values and clamping. */
function sanitizeForces(base: ForceParams, patch: Partial<ForceParams>): ForceParams {
  const out: ForceParams = { ...base };
  for (const key of FORCE_KEYS) {
    const value = patch[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[key] = clamp(value, FORCE_LIMITS[key].min, FORCE_LIMITS[key].max);
  }
  return out;
}

function sanitizeRadius(r: number): number {
  return Number.isFinite(r) && r > 0 ? r : 0;
}

/** Create a simulation; positions are initialized immediately (alpha = 1). */
export function createForceSimulation(init: ForceSimulationInit): ForceSimulation {
  const n = Math.max(0, Math.floor(Number.isFinite(init.count) ? init.count : 0));
  const random = mulberry32(init.seed);
  const jiggle = (): number => (random() - 0.5) * 1e-6;

  let forces = sanitizeForces(DEFAULT_FORCE_PARAMS, init.forces);
  let alpha = 1;
  let alphaTarget = 0;

  const x = new Float32Array(n);
  const y = new Float32Array(n);
  const vx = new Float64Array(n);
  const vy = new Float64Array(n);
  /** Float64 scratch: positions for the many-body tree, x+vx for collide. */
  const qx = new Float64Array(n);
  const qy = new Float64Array(n);
  const collideR = new Float64Array(n);
  const pinned = new Uint8Array(n);
  const pinX = new Float64Array(n);
  const pinY = new Float64Array(n);

  // --- Edges (self-loops and out-of-range endpoints dropped) ---------------
  const rawEdges = Math.min(init.edgeSource.length, init.edgeTarget.length);
  const degree = new Uint32Array(n);
  let m = 0;
  for (let e = 0; e < rawEdges; e += 1) {
    const s = init.edgeSource[e]!;
    const t = init.edgeTarget[e]!;
    if (s >= n || t >= n || s === t) continue;
    degree[s] = degree[s]! + 1;
    degree[t] = degree[t]! + 1;
    m += 1;
  }
  const linkS = new Uint32Array(m);
  const linkT = new Uint32Array(m);
  const linkBias = new Float64Array(m);
  /** `1 / min(deg(s), deg(t))`; multiplied by `linkForce` each tick. */
  const linkInvMin = new Float64Array(m);
  {
    let k = 0;
    for (let e = 0; e < rawEdges; e += 1) {
      const s = init.edgeSource[e]!;
      const t = init.edgeTarget[e]!;
      if (s >= n || t >= n || s === t) continue;
      const ds = degree[s]!;
      const dt = degree[t]!;
      linkS[k] = s;
      linkT[k] = t;
      linkBias[k] = ds / (ds + dt);
      linkInvMin[k] = 1 / Math.min(ds, dt);
      k += 1;
    }
  }

  // --- Radii ----------------------------------------------------------------
  for (let i = 0; i < n; i += 1) {
    collideR[i] = sanitizeRadius(i < init.radii.length ? init.radii[i]! : 0) + COLLIDE_PADDING;
  }

  // --- Initial positions ----------------------------------------------------
  const { initialX, initialY } = init;
  for (let i = 0; i < n; i += 1) {
    // Always draw the jitter so a node's start does not depend on whether
    // other nodes were given initial positions.
    const jx = (random() - 0.5) * 2 * START_JITTER;
    const jy = (random() - 0.5) * 2 * START_JITTER;
    const ix = initialX && i < initialX.length ? initialX[i]! : NaN;
    const iy = initialY && i < initialY.length ? initialY[i]! : NaN;
    if (Number.isFinite(ix) && Number.isFinite(iy)) {
      x[i] = ix;
      y[i] = iy;
    } else {
      const radius = INITIAL_RADIUS * Math.sqrt(0.5 + i);
      const angle = i * INITIAL_ANGLE;
      x[i] = radius * Math.cos(angle) + jx;
      y[i] = radius * Math.sin(angle) + jy;
    }
  }

  const tree = createQuadtree();
  // Hoisted so the per-tick rebuild does not allocate an options object.
  const collideBuild = { radii: collideR };
  let stack = new Int32Array(64);

  function ensureStack(cells: number): void {
    if (stack.length < cells + 4) stack = new Int32Array(Math.max(cells + 4, stack.length * 2));
  }

  function applyLinks(): void {
    const strength = forces.linkForce;
    if (strength <= 0 || m === 0) return;
    const distance = forces.linkDistance;
    for (let k = 0; k < m; k += 1) {
      const s = linkS[k]!;
      const t = linkT[k]!;
      let dx = x[t]! + vx[t]! - x[s]! - vx[s]!;
      let dy = y[t]! + vy[t]! - y[s]! - vy[s]!;
      if (dx === 0) dx = jiggle();
      if (dy === 0) dy = jiggle();
      let l = Math.sqrt(dx * dx + dy * dy);
      l = ((l - distance) / l) * alpha * strength * linkInvMin[k]!;
      dx *= l;
      dy *= l;
      const b = linkBias[k]!;
      vx[t] = vx[t]! - dx * b;
      vy[t] = vy[t]! - dy * b;
      vx[s] = vx[s]! + dx * (1 - b);
      vy[s] = vy[s]! + dy * (1 - b);
    }
  }

  function applyManyBody(): void {
    const strength = -(forces.repelForce * 300 + 30);
    for (let i = 0; i < n; i += 1) {
      qx[i] = x[i]!;
      qy[i] = y[i]!;
    }
    tree.rebuild(qx, qy, n);
    const cells = tree.cellCount;
    if (cells === 0) return;
    ensureStack(cells);
    const size = tree.cellSize;
    const children = tree.cellChildren;
    const internal = tree.cellInternal;
    const head = tree.cellHead;
    const next = tree.pointNext;
    const charge = tree.cellCharge;
    const massX = tree.cellMassX;
    const massY = tree.cellMassY;
    const st = stack;
    const scale = strength * alpha;

    for (let i = 0; i < n; i += 1) {
      const xi = qx[i]!;
      const yi = qy[i]!;
      let ax = 0;
      let ay = 0;
      let sp = 0;
      st[sp++] = 0;
      while (sp > 0) {
        const c = st[--sp]!;
        const value = charge[c]!;
        if (value === 0) continue;
        let dx = massX[c]! - xi;
        let dy = massY[c]! - yi;
        const w = size[c]!;
        let l = dx * dx + dy * dy;
        if ((w * w) / THETA2 < l) {
          // Far enough: treat the whole cell as one body.
          if (dx === 0) {
            dx = jiggle();
            l += dx * dx;
          }
          if (dy === 0) {
            dy = jiggle();
            l += dy * dy;
          }
          if (l < DISTANCE_MIN2) l = Math.sqrt(DISTANCE_MIN2 * l);
          const f = (value * scale) / l;
          ax += dx * f;
          ay += dy * f;
          continue;
        }
        if (internal[c] === 1) {
          const k = c * 4;
          for (let q = 3; q >= 0; q -= 1) {
            const child = children[k + q]!;
            if (child >= 0) st[sp++] = child;
          }
          continue;
        }
        // Leaf: exact interaction with every point in the chain but i.
        const first = head[c]!;
        if (first !== i || next[first]! >= 0) {
          if (dx === 0) {
            dx = jiggle();
            l += dx * dx;
          }
          if (dy === 0) {
            dy = jiggle();
            l += dy * dy;
          }
          if (l < DISTANCE_MIN2) l = Math.sqrt(DISTANCE_MIN2 * l);
        }
        const f = scale / l;
        for (let j = first; j >= 0; j = next[j]!) {
          if (j === i) continue;
          ax += dx * f;
          ay += dy * f;
        }
      }
      vx[i] = vx[i]! + ax;
      vy[i] = vy[i]! + ay;
    }
  }

  function applyCenter(): void {
    const k = forces.centerForce * 0.1 * alpha;
    if (k <= 0) return;
    for (let i = 0; i < n; i += 1) {
      vx[i] = vx[i]! - x[i]! * k;
      vy[i] = vy[i]! - y[i]! * k;
    }
  }

  function applyCollide(): void {
    for (let i = 0; i < n; i += 1) {
      qx[i] = x[i]! + vx[i]!;
      qy[i] = y[i]! + vy[i]!;
    }
    tree.rebuild(qx, qy, n, collideBuild);
    const cells = tree.cellCount;
    if (cells === 0) return;
    ensureStack(cells);
    const x0s = tree.cellX0;
    const y0s = tree.cellY0;
    const size = tree.cellSize;
    const children = tree.cellChildren;
    const internal = tree.cellInternal;
    const head = tree.cellHead;
    const next = tree.pointNext;
    const maxR = tree.cellMaxRadius;
    const st = stack;

    for (let i = 0; i < n; i += 1) {
      const ri = collideR[i]!;
      const ri2 = ri * ri;
      const xi = x[i]! + vx[i]!;
      const yi = y[i]! + vy[i]!;
      let sp = 0;
      st[sp++] = 0;
      while (sp > 0) {
        const c = st[--sp]!;
        if (internal[c] === 1) {
          const r = ri + maxR[c]!;
          const cx0 = x0s[c]!;
          const cy0 = y0s[c]!;
          const s = size[c]!;
          if (cx0 > xi + r || cx0 + s < xi - r || cy0 > yi + r || cy0 + s < yi - r) continue;
          const k = c * 4;
          for (let q = 3; q >= 0; q -= 1) {
            const child = children[k + q]!;
            if (child >= 0) st[sp++] = child;
          }
          continue;
        }
        for (let j = head[c]!; j >= 0; j = next[j]!) {
          if (j <= i) continue;
          const rj = collideR[j]!;
          const r = ri + rj;
          let dx = xi - x[j]! - vx[j]!;
          let dy = yi - y[j]! - vy[j]!;
          let l = dx * dx + dy * dy;
          if (l >= r * r) continue;
          if (dx === 0) {
            dx = jiggle();
            l += dx * dx;
          }
          if (dy === 0) {
            dy = jiggle();
            l += dy * dy;
          }
          l = Math.sqrt(l);
          l = ((r - l) / l) * COLLIDE_STRENGTH;
          dx *= l;
          dy *= l;
          const rj2 = rj * rj;
          const share = rj2 / (ri2 + rj2);
          vx[i] = vx[i]! + dx * share;
          vy[i] = vy[i]! + dy * share;
          vx[j] = vx[j]! - dx * (1 - share);
          vy[j] = vy[j]! - dy * (1 - share);
        }
      }
    }
  }

  function integrate(): void {
    for (let i = 0; i < n; i += 1) {
      if (pinned[i] === 1) {
        x[i] = pinX[i]!;
        y[i] = pinY[i]!;
        vx[i] = 0;
        vy[i] = 0;
        continue;
      }
      let vxi = vx[i]! * VELOCITY_KEEP;
      let vyi = vy[i]! * VELOCITY_KEEP;
      if (!Number.isFinite(vxi)) vxi = 0;
      else if (vxi > MAX_VELOCITY) vxi = MAX_VELOCITY;
      else if (vxi < -MAX_VELOCITY) vxi = -MAX_VELOCITY;
      if (!Number.isFinite(vyi)) vyi = 0;
      else if (vyi > MAX_VELOCITY) vyi = MAX_VELOCITY;
      else if (vyi < -MAX_VELOCITY) vyi = -MAX_VELOCITY;
      vx[i] = vxi;
      vy[i] = vyi;
      const nx = x[i]! + vxi;
      const ny = y[i]! + vyi;
      // Float32 storage can overflow to Infinity far out; keep the old value.
      if (Number.isFinite(nx) && Math.abs(nx) < 1e30) x[i] = nx;
      else vx[i] = 0;
      if (Number.isFinite(ny) && Math.abs(ny) < 1e30) y[i] = ny;
      else vy[i] = 0;
    }
  }

  function isSettled(): boolean {
    return alpha < ALPHA_MIN && alphaTarget < ALPHA_MIN;
  }

  function step(): void {
    alpha += (alphaTarget - alpha) * ALPHA_DECAY;
    applyLinks();
    applyManyBody();
    applyCenter();
    applyCollide();
    integrate();
  }

  function validIndex(index: number): boolean {
    return Number.isInteger(index) && index >= 0 && index < n;
  }

  return {
    count: n,
    x,
    y,
    get alpha() {
      return alpha;
    },
    tick(iterations = 1) {
      const steps = Number.isFinite(iterations) ? Math.max(0, Math.floor(iterations)) : 0;
      for (let s = 0; s < steps; s += 1) {
        if (isSettled()) return;
        step();
      }
    },
    isSettled,
    reheat(value = 1) {
      alpha = Number.isFinite(value) ? clamp(value, 0, 1) : 1;
    },
    setAlphaTarget(target) {
      alphaTarget = Number.isFinite(target) ? clamp(target, 0, 1) : 0;
    },
    setForces(patch) {
      const merged = sanitizeForces(forces, patch);
      let changed = false;
      for (const key of FORCE_KEYS) {
        if (merged[key] !== forces[key]) changed = true;
      }
      if (!changed) return;
      forces = merged;
      if (alpha < 0.3) alpha = 0.3;
    },
    setRadii(radii) {
      if (radii.length !== n) {
        throw new RangeError(`setRadii: expected ${n} radii, got ${radii.length}`);
      }
      for (let i = 0; i < n; i += 1) collideR[i] = sanitizeRadius(radii[i]!) + COLLIDE_PADDING;
    },
    pin(index, px, py) {
      if (!validIndex(index) || !Number.isFinite(px) || !Number.isFinite(py)) return;
      pinned[index] = 1;
      pinX[index] = px;
      pinY[index] = py;
      x[index] = px;
      y[index] = py;
      vx[index] = 0;
      vy[index] = 0;
    },
    unpin(index) {
      if (validIndex(index)) pinned[index] = 0;
    },
    isPinned(index) {
      return validIndex(index) && pinned[index] === 1;
    },
  };
}
