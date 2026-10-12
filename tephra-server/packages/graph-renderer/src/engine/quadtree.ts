/**
 * Flat typed-array quadtree for the graph engine (plan 018).
 *
 * Zero dependencies and zero per-node objects: every cell lives in parallel
 * typed arrays that are allocated once, grown geometrically when a rebuild
 * needs more room, and reused across rebuilds. A rebuild in steady state
 * therefore performs no heap allocation.
 *
 * One tree serves three consumers:
 * - Barnes–Hut many-body: every cell carries an aggregate charge (sum of
 *   point weights) and centre of mass (weighted by |weight|), mirroring
 *   d3-quadtree + d3-force `forceManyBody`.
 * - Collision: every cell carries the max point radius in its subtree, so
 *   `x0 > xi + ri + maxR` style pruning works exactly like d3 `forceCollide`.
 * - Picking: {@link Quadtree.nearest} and {@link Quadtree.visitWithin} answer
 *   point queries against the arrays passed to the last rebuild.
 *
 * Cell layout: cells are axis-aligned squares `[x0, x0 + size) × [y0, y0 + size)`.
 * A cell is either an empty root, a leaf holding a singly linked chain of
 * points (`head` → `next` → …, all exactly coincident unless the depth cap
 * was hit), or an internal cell with up to four children (quadrant
 * `q = (x >= midX ? 1 : 0) | (y >= midY ? 2 : 0)`). Children are always
 * allocated after their parent, so iterating cells in reverse index order is
 * a valid post-order — aggregates are computed without recursion.
 */

/** Coordinate / attribute arrays the tree can be built from. */
export type FloatArray = Float32Array | Float64Array;

/** Called for each point found by {@link Quadtree.visitWithin}. */
export type QuadtreeVisitor = (index: number, distance: number) => void;

export interface QuadtreeBuildOptions {
  /**
   * Per-point weight (charge) used by the Barnes–Hut aggregate. Defaults to
   * 1 for every point.
   */
  weights?: FloatArray | undefined;
  /**
   * Per-point radius. Drives `cellMaxRadius` (collision pruning) and makes
   * {@link Quadtree.nearest} / {@link Quadtree.visitWithin} measure distance
   * to the circle rim instead of the centre. Defaults to 0.
   */
  radii?: FloatArray | undefined;
}

export interface Quadtree {
  /**
   * Rebuild from point arrays (only the first `count` entries are used).
   * Points with non-finite coordinates are skipped. The arrays are kept by
   * reference for queries until the next rebuild; they must not be resized.
   */
  rebuild(x: FloatArray, y: FloatArray, count: number, options?: QuadtreeBuildOptions): void;
  /** Number of cells in use (0 when the tree holds no points). Root is cell 0. */
  readonly cellCount: number;
  /** Number of points the last rebuild was asked to index. */
  readonly pointCount: number;

  // Raw cell storage for hot loops (simulation forces). These getters may
  // return new arrays after a rebuild that grew the pools, so callers should
  // re-read them after every rebuild and cache them in locals.
  /** Cell left edge. */
  readonly cellX0: Float64Array;
  /** Cell top edge. */
  readonly cellY0: Float64Array;
  /** Cell side length (cells are square). */
  readonly cellSize: Float64Array;
  /** 4 child cell indices per cell (`-1` = none), `cellChildren[4 * c + q]`. */
  readonly cellChildren: Int32Array;
  /** 1 if the cell has children. */
  readonly cellInternal: Uint8Array;
  /** First point of a leaf's chain, `-1` for internal / empty cells. */
  readonly cellHead: Int32Array;
  /** Next point in the same leaf chain, `-1` terminates. Indexed by point. */
  readonly pointNext: Int32Array;
  /** Barnes–Hut aggregate: sum of weights in the subtree. */
  readonly cellCharge: Float64Array;
  /** Barnes–Hut aggregate: centre of mass (weighted by |weight|). */
  readonly cellMassX: Float64Array;
  readonly cellMassY: Float64Array;
  /** Max point radius in the subtree (0 without radii). */
  readonly cellMaxRadius: Float64Array;

  /**
   * Index of the point whose rim (`distance - radius`) is closest to
   * `(x, y)`, considering only points with `distance - radius <= maxDistance`.
   * Returns -1 when nothing qualifies.
   */
  nearest(x: number, y: number, maxDistance: number): number;
  /**
   * Call `visit(index, distance)` for every point whose rim lies within
   * `radius` of `(x, y)` (`distance - pointRadius <= radius`). `distance` is
   * centre distance. Pass a pre-bound function to stay allocation-free.
   */
  visitWithin(x: number, y: number, radius: number, visit: QuadtreeVisitor): void;
}

/** Beyond this depth coincident-ish points are chained instead of split. */
const MAX_DEPTH = 48;
const INITIAL_CELLS = 64;

/** Create an empty quadtree with small pools that grow on demand. */
export function createQuadtree(): Quadtree {
  let cellCap = 0;
  let cellX0 = new Float64Array(0);
  let cellY0 = new Float64Array(0);
  let cellSize = new Float64Array(0);
  let cellChildren = new Int32Array(0);
  let cellInternal = new Uint8Array(0);
  let cellHead = new Int32Array(0);
  let cellCharge = new Float64Array(0);
  let cellMassX = new Float64Array(0);
  let cellMassY = new Float64Array(0);
  let cellMaxRadius = new Float64Array(0);
  let cellDepth = new Uint8Array(0);
  let stack = new Int32Array(0);
  let pointNext = new Int32Array(0);

  let cells = 0;
  let points = 0;
  let px: FloatArray = new Float64Array(0);
  let py: FloatArray = new Float64Array(0);
  let pr: FloatArray | undefined;

  function growCells(min: number): void {
    let next = Math.max(INITIAL_CELLS, cellCap);
    while (next < min) next *= 2;
    if (next === cellCap) return;
    const grow64 = (a: Float64Array): Float64Array<ArrayBuffer> => {
      const b = new Float64Array(next);
      b.set(a.subarray(0, cells));
      return b;
    };
    cellX0 = grow64(cellX0);
    cellY0 = grow64(cellY0);
    cellSize = grow64(cellSize);
    cellCharge = grow64(cellCharge);
    cellMassX = grow64(cellMassX);
    cellMassY = grow64(cellMassY);
    cellMaxRadius = grow64(cellMaxRadius);
    const children = new Int32Array(next * 4);
    children.set(cellChildren.subarray(0, cells * 4));
    cellChildren = children;
    const internal = new Uint8Array(next);
    internal.set(cellInternal.subarray(0, cells));
    cellInternal = internal;
    const head = new Int32Array(next);
    head.set(cellHead.subarray(0, cells));
    cellHead = head;
    const depth = new Uint8Array(next);
    depth.set(cellDepth.subarray(0, cells));
    cellDepth = depth;
    // Every cell is pushed at most once per traversal, so this bounds the stack.
    stack = new Int32Array(next + 4);
    cellCap = next;
  }

  function allocCell(x0: number, y0: number, size: number, depth: number): number {
    if (cells >= cellCap) growCells(cells + 1);
    const c = cells;
    cells += 1;
    cellX0[c] = x0;
    cellY0[c] = y0;
    cellSize[c] = size;
    const k = c * 4;
    cellChildren[k] = -1;
    cellChildren[k + 1] = -1;
    cellChildren[k + 2] = -1;
    cellChildren[k + 3] = -1;
    cellInternal[c] = 0;
    cellHead[c] = -1;
    cellDepth[c] = depth;
    return c;
  }

  /** Child cell of `c` in the quadrant containing (x, y), created on demand. */
  function childFor(c: number, x: number, y: number): number {
    const half = cellSize[c]! * 0.5;
    const x0 = cellX0[c]!;
    const y0 = cellY0[c]!;
    const right = x >= x0 + half ? 1 : 0;
    const bottom = y >= y0 + half ? 2 : 0;
    const slot = c * 4 + (right | bottom);
    let child = cellChildren[slot]!;
    if (child < 0) {
      child = allocCell(x0 + right * half, y0 + (bottom >> 1) * half, half, cellDepth[c]! + 1);
      cellChildren[slot] = child;
    }
    return child;
  }

  function insert(i: number): void {
    const x = px[i]!;
    const y = py[i]!;
    let c = 0;
    for (;;) {
      if (cellInternal[c] === 1) {
        c = childFor(c, x, y);
        continue;
      }
      const head = cellHead[c]!;
      if (head < 0) {
        cellHead[c] = i;
        pointNext[i] = -1;
        return;
      }
      if ((px[head] === x && py[head] === y) || cellDepth[c]! >= MAX_DEPTH) {
        pointNext[i] = head;
        cellHead[c] = i;
        return;
      }
      // Split: push the existing (coincident) chain down one level, then
      // keep descending with the new point.
      cellInternal[c] = 1;
      cellHead[c] = -1;
      const moved = childFor(c, px[head]!, py[head]!);
      cellHead[moved] = head;
    }
  }

  function aggregate(weights: FloatArray | undefined): void {
    for (let c = cells - 1; c >= 0; c -= 1) {
      let charge = 0;
      let absSum = 0;
      let mx = 0;
      let my = 0;
      let maxR = 0;
      if (cellInternal[c] === 1) {
        const k = c * 4;
        for (let q = 0; q < 4; q += 1) {
          const child = cellChildren[k + q]!;
          if (child < 0) continue;
          const w = cellCharge[child]!;
          const a = Math.abs(w);
          charge += w;
          absSum += a;
          mx += a * cellMassX[child]!;
          my += a * cellMassY[child]!;
          const r = cellMaxRadius[child]!;
          if (r > maxR) maxR = r;
        }
      } else {
        for (let j = cellHead[c]!; j >= 0; j = pointNext[j]!) {
          const w = weights ? weights[j]! : 1;
          const a = Math.abs(w);
          charge += w;
          absSum += a;
          mx += a * px[j]!;
          my += a * py[j]!;
          if (pr) {
            const r = pr[j]!;
            if (r > maxR) maxR = r;
          }
        }
      }
      if (absSum > 0) {
        cellMassX[c] = mx / absSum;
        cellMassY[c] = my / absSum;
      } else {
        const half = cellSize[c]! * 0.5;
        cellMassX[c] = cellX0[c]! + half;
        cellMassY[c] = cellY0[c]! + half;
      }
      cellCharge[c] = Number.isFinite(charge) ? charge : 0;
      cellMaxRadius[c] = Number.isFinite(maxR) ? maxR : 0;
    }
  }

  function rebuild(
    x: FloatArray,
    y: FloatArray,
    count: number,
    options?: QuadtreeBuildOptions,
  ): void {
    const n = Math.max(0, Math.min(count, x.length, y.length));
    px = x;
    py = y;
    pr = options?.radii;
    points = n;
    cells = 0;
    if (pointNext.length < n) pointNext = new Int32Array(Math.max(n, pointNext.length * 2));

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < n; i += 1) {
      const xi = x[i]!;
      const yi = y[i]!;
      pointNext[i] = -1;
      if (!Number.isFinite(xi) || !Number.isFinite(yi)) continue;
      if (xi < minX) minX = xi;
      if (xi > maxX) maxX = xi;
      if (yi < minY) minY = yi;
      if (yi > maxY) maxY = yi;
    }
    if (minX > maxX) return; // no finite points

    // Square root cell, padded so max-edge points fall strictly inside.
    let size = Math.max(maxX - minX, maxY - minY);
    size = size > 0 ? size * (1 + 1e-9) + 1e-9 : 1;
    if (cellCap < 2 * n + 1) growCells(2 * n + 1);
    allocCell(minX, minY, size, 0);
    for (let i = 0; i < n; i += 1) {
      if (Number.isFinite(x[i]!) && Number.isFinite(y[i]!)) insert(i);
    }
    aggregate(options?.weights);
  }

  /** Distance from (x, y) to the cell's square (0 inside). */
  function boxDistance(c: number, x: number, y: number): number {
    const x0 = cellX0[c]!;
    const y0 = cellY0[c]!;
    const s = cellSize[c]!;
    const dx = x < x0 ? x0 - x : x > x0 + s ? x - x0 - s : 0;
    const dy = y < y0 ? y0 - y : y > y0 + s ? y - y0 - s : 0;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function nearest(x: number, y: number, maxDistance: number): number {
    if (cells === 0 || !Number.isFinite(x) || !Number.isFinite(y)) return -1;
    if (Number.isNaN(maxDistance)) return -1;
    let best = -1;
    let bestScore = maxDistance;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const c = stack[--sp]!;
      if (boxDistance(c, x, y) - cellMaxRadius[c]! > bestScore) continue;
      if (cellInternal[c] === 1) {
        const k = c * 4;
        for (let q = 3; q >= 0; q -= 1) {
          const child = cellChildren[k + q]!;
          if (child >= 0) stack[sp++] = child;
        }
        continue;
      }
      for (let j = cellHead[c]!; j >= 0; j = pointNext[j]!) {
        const dx = px[j]! - x;
        const dy = py[j]! - y;
        const score = Math.sqrt(dx * dx + dy * dy) - (pr ? pr[j]! : 0);
        if (score < bestScore || (best < 0 && score <= bestScore)) {
          best = j;
          bestScore = score;
        }
      }
    }
    return best;
  }

  function visitWithin(x: number, y: number, radius: number, visit: QuadtreeVisitor): void {
    if (cells === 0 || !Number.isFinite(x) || !Number.isFinite(y) || Number.isNaN(radius)) {
      return;
    }
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const c = stack[--sp]!;
      if (boxDistance(c, x, y) - cellMaxRadius[c]! > radius) continue;
      if (cellInternal[c] === 1) {
        const k = c * 4;
        for (let q = 3; q >= 0; q -= 1) {
          const child = cellChildren[k + q]!;
          if (child >= 0) stack[sp++] = child;
        }
        continue;
      }
      for (let j = cellHead[c]!; j >= 0; j = pointNext[j]!) {
        const dx = px[j]! - x;
        const dy = py[j]! - y;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d - (pr ? pr[j]! : 0) <= radius) visit(j, d);
      }
    }
  }

  return {
    rebuild,
    nearest,
    visitWithin,
    get cellCount() {
      return cells;
    },
    get pointCount() {
      return points;
    },
    get cellX0() {
      return cellX0;
    },
    get cellY0() {
      return cellY0;
    },
    get cellSize() {
      return cellSize;
    },
    get cellChildren() {
      return cellChildren;
    },
    get cellInternal() {
      return cellInternal;
    },
    get cellHead() {
      return cellHead;
    },
    get pointNext() {
      return pointNext;
    },
    get cellCharge() {
      return cellCharge;
    },
    get cellMassX() {
      return cellMassX;
    },
    get cellMassY() {
      return cellMassY;
    },
    get cellMaxRadius() {
      return cellMaxRadius;
    },
  };
}
