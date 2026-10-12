/**
 * Screen-space node hit testing (plan 018) over live simulation positions.
 *
 * Thin wrapper around the engine quadtree: the tree is rebuilt lazily —
 * only when a query arrives after `invalidate()` (positions moved) — so a
 * running simulation never pays for picking unless the pointer is active,
 * and at most one rebuild happens per frame (the orchestrator invalidates
 * once per frame). Distance is measured to the node rim in world units, so
 * clicking anywhere inside a circle hits it.
 */

import type { CameraState } from '../camera';
import { createQuadtree } from './quadtree';

/** Extra screen-pixel tolerance around node rims. */
export const PICK_SLOP_PX = 3;

export interface Picker {
  /** Positions or radii changed; the next query rebuilds the index. */
  invalidate(): void;
  /**
   * Index of the node under screen point (`sx`, `sy`) (CSS px), or -1.
   * `x`/`y`/`radius` are world-space arrays (first `count` entries used).
   */
  pick(
    sx: number,
    sy: number,
    camera: CameraState,
    x: Float32Array,
    y: Float32Array,
    radius: Float32Array,
    count: number,
  ): number;
  /** Number of quadtree rebuilds performed (test / diagnostics hook). */
  readonly rebuilds: number;
}

export function createPicker(): Picker {
  const tree = createQuadtree();
  const build = { radii: undefined as Float32Array | undefined };
  let dirty = true;
  let lastX: Float32Array | null = null;
  let lastY: Float32Array | null = null;
  let lastR: Float32Array | null = null;
  let lastCount = -1;
  let rebuilds = 0;

  return {
    invalidate(): void {
      dirty = true;
    },
    pick(sx, sy, camera, x, y, radius, count): number {
      if (count <= 0) return -1;
      if (dirty || x !== lastX || y !== lastY || radius !== lastR || count !== lastCount) {
        build.radii = radius;
        tree.rebuild(x, y, count, build);
        lastX = x;
        lastY = y;
        lastR = radius;
        lastCount = count;
        dirty = false;
        rebuilds += 1;
      }
      const k = camera.k > 0 ? camera.k : 1;
      const wx = (sx - camera.x) / k;
      const wy = (sy - camera.y) / k;
      return tree.nearest(wx, wy, PICK_SLOP_PX / k);
    },
    get rebuilds() {
      return rebuilds;
    },
  };
}
