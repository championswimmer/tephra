/**
 * Picking: uniform-grid spatial index for hover/drag hit-testing plus
 * viewport culling. Pure module — no DOM. The renderer rebuilds the index
 * once per frame (or per `setModel`/tick batch) and queries it with screen
 * coordinates; the camera converts screen -> world internally.
 */

import type { CameraState, ViewportSize } from './camera';
import { screenToWorld } from './camera';

export interface PickableNode {
  id: string;
  x: number;
  y: number;
  /** World-unit radius (already includes the `nodeSize` multiplier). */
  r: number;
}

export interface PickerOptions {
  /**
   * World-unit grid cell size. Defaults to 64; `rebuild` widens it to at
   * least `2 * maxRadius` so large nodes never span excessive cells.
   */
  cellSize?: number;
}

const DEFAULT_CELL_SIZE = 64;

function cellKey(cx: number, cy: number): string {
  return `${cx},${cy}`;
}

export interface NodePicker {
  /** Number of nodes currently indexed. */
  readonly size: number;
  /** (Re)build the index from the current frame's node positions. */
  rebuild(nodes: readonly PickableNode[]): void;
  /**
   * Topmost node id under the screen point, or `null`. Nearest center wins
   * on overlap. `slop` adds extra world-unit tolerance around each radius
   * (useful for tiny nodes at low zoom).
   */
  hitTest(
    sx: number,
    sy: number,
    camera: CameraState,
    slop?: number,
  ): string | null;
  /**
   * Ids of nodes whose circle intersects the visible world rect, in index
   * order. Used by the renderer to skip off-screen draw work.
   */
  nodesInViewport(camera: CameraState, viewport: ViewportSize): string[];
}

/** True when the node's circle intersects the visible world rect. */
export function isNodeInViewport(
  node: PickableNode,
  camera: CameraState,
  viewport: ViewportSize,
): boolean {
  const k = camera.k === 0 ? 1 : camera.k;
  const left = (0 - camera.x) / k;
  const top = (0 - camera.y) / k;
  const right = (viewport.width - camera.x) / k;
  const bottom = (viewport.height - camera.y) / k;
  return (
    node.x + node.r >= left &&
    node.x - node.r <= right &&
    node.y + node.r >= top &&
    node.y - node.r <= bottom
  );
}

export function createNodePicker(opts: PickerOptions = {}): NodePicker {
  let nodes: readonly PickableNode[] = [];
  let grid = new Map<string, number[]>();
  let cell = opts.cellSize ?? DEFAULT_CELL_SIZE;

  function rebuild(next: readonly PickableNode[]): void {
    nodes = next;
    grid = new Map<string, number[]>();
    if (next.length === 0) return;
    let maxR = 0;
    for (const n of next) if (n.r > maxR) maxR = n.r;
    cell = Math.max(opts.cellSize ?? DEFAULT_CELL_SIZE, maxR * 2 || 1);
    for (let i = 0; i < next.length; i++) {
      const n = next[i]!;
      const minCx = Math.floor((n.x - n.r) / cell);
      const maxCx = Math.floor((n.x + n.r) / cell);
      const minCy = Math.floor((n.y - n.r) / cell);
      const maxCy = Math.floor((n.y + n.r) / cell);
      for (let cx = minCx; cx <= maxCx; cx++) {
        for (let cy = minCy; cy <= maxCy; cy++) {
          const key = cellKey(cx, cy);
          const bucket = grid.get(key);
          if (bucket) bucket.push(i);
          else grid.set(key, [i]);
        }
      }
    }
  }

  function candidatesAt(wx: number, wy: number): number[] | undefined {
    return grid.get(cellKey(Math.floor(wx / cell), Math.floor(wy / cell)));
  }

  function hitTest(
    sx: number,
    sy: number,
    camera: CameraState,
    slop = 0,
  ): string | null {
    if (nodes.length === 0) return null;
    const { x: wx, y: wy } = screenToWorld(sx, sy, camera);
    const bucket = candidatesAt(wx, wy);
    if (!bucket) return null;
    let best: string | null = null;
    let bestD2 = Infinity;
    for (const i of bucket) {
      const n = nodes[i]!;
      const rr = n.r + slop;
      const dx = wx - n.x;
      const dy = wy - n.y;
      const d2 = dx * dx + dy * dy;
      if (d2 <= rr * rr && d2 < bestD2) {
        bestD2 = d2;
        best = n.id;
      }
    }
    return best;
  }

  function nodesInViewport(
    camera: CameraState,
    viewport: ViewportSize,
  ): string[] {
    const out: string[] = [];
    if (nodes.length === 0) return out;
    const k = camera.k === 0 ? 1 : camera.k;
    const left = (0 - camera.x) / k;
    const top = (0 - camera.y) / k;
    const right = (viewport.width - camera.x) / k;
    const bottom = (viewport.height - camera.y) / k;
    const minCx = Math.floor(left / cell);
    const maxCx = Math.floor(right / cell);
    const minCy = Math.floor(top / cell);
    const maxCy = Math.floor(bottom / cell);
    const seen = new Set<number>();
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = grid.get(cellKey(cx, cy));
        if (!bucket) continue;
        for (const i of bucket) {
          if (seen.has(i)) continue;
          const n = nodes[i]!;
          if (
            n.x + n.r >= left &&
            n.x - n.r <= right &&
            n.y + n.r >= top &&
            n.y - n.r <= bottom
          ) {
            seen.add(i);
          }
        }
      }
    }
    // Index order keeps draw order stable for the renderer.
    for (let i = 0; i < nodes.length; i++) {
      if (seen.has(i)) out.push(nodes[i]!.id);
    }
    return out;
  }

  return {
    get size() {
      return nodes.length;
    },
    rebuild,
    hitTest,
    nodesInViewport,
  };
}
