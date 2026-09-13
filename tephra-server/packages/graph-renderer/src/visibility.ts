/**
 * Render-budget visibility: pure, DOM-free.
 *
 * Large vaults push thousands of nodes into the filtered graph. The
 * renderer never draws more than {@link MAX_VISIBLE_NODES} nodes per frame:
 * the budget applies to the nodes in (or near) the viewport, picked
 * highest-degree first, so zooming/panning into a region reveals the
 * smaller nodes there.
 *
 * Render-only: the caller supplies the viewport predicate (kept free of the
 * camera type), simulation/counts/model are untouched, and the same set
 * must drive both drawing and picking so hit-testing agrees with the
 * canvas.
 */

import type { GraphModel } from './model';

/**
 * Max nodes drawn per frame. Single source of truth (plan 015); also
 * re-exported from the package root for the web notice.
 */
export const MAX_VISIBLE_NODES = 500;

export interface VisibleNodeBudget {
  /**
   * Per-node flag (`1` = draw/pick, `0` = skip), indexed like
   * `model.nodes`.
   */
  visible: Uint8Array;
  /** Nodes in view but excluded by the budget (force-included excluded). */
  hiddenCount: number;
}

/**
 * Compute the per-frame visible set.
 *
 * Walks node indices in degree-desc order (index asc tiebreak — stable
 * across frames for a static camera) and marks in-view nodes visible until
 * `budget` is reached. `force` indices (selected/hovered) are always marked
 * visible, over budget if needed, even when off-screen.
 *
 * @param model   Render model (only `nodes[].degree` is read).
 * @param isInView Viewport predicate supplied by the caller (renderer builds
 *                 it from `worldToScreen` + radii, same bounds as its node
 *                 pass).
 * @param budget  Max in-view nodes to keep (e.g. `MAX_VISIBLE_NODES`).
 * @param force   Indices that bypass the budget. Defaults to empty.
 * @param order   Optional pre-sorted degree-desc index order (the renderer
 *                reuses its `labelOrder`); built via stable sort when
 *                omitted.
 */
export function visibleNodeBudget(
  model: GraphModel,
  isInView: (index: number) => boolean,
  budget: number,
  force: Set<number> = new Set(),
  order?: readonly number[],
): VisibleNodeBudget {
  const count = model.nodes.length;
  const visible = new Uint8Array(count);
  if (count === 0) return { visible, hiddenCount: 0 };

  const cap = Number.isFinite(budget) ? Math.max(0, Math.floor(budget)) : count;
  const seq: readonly number[] =
    order ??
    model.nodes
      .map((_, i) => i)
      .sort((a, b) => model.nodes[b]!.degree - model.nodes[a]!.degree || a - b);

  let kept = 0;
  let hitCap = false;
  for (const index of seq) {
    if (kept >= cap) {
      hitCap = true;
      break;
    }
    if (index < 0 || index >= count) continue;
    if (visible[index] === 1) continue;
    if (isInView(index)) {
      visible[index] = 1;
      kept += 1;
    }
  }
  for (const index of force) {
    if (index < 0 || index >= count) continue;
    visible[index] = 1;
  }

  let hiddenCount = 0;
  if (hitCap) {
    for (let i = 0; i < count; i += 1) {
      if (visible[i] !== 1 && isInView(i)) hiddenCount += 1;
    }
  }
  return { visible, hiddenCount };
}
