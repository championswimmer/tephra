# 015 — 500-node render budget + zoom-to-reveal

> **Status:** implementation plan (approved for immediate execution)
> **Depends on:** `014-GRAPH_RENDERER_REWRITE.md` (hand-rolled renderer)
> **Packages:** `tephra-server/packages/graph-renderer`, `tephra-server/apps/web`
> **Compatibility:** none required — pre-launch, `/graph` payload unchanged
> **Last updated:** 2026-09-13

## 1. Context and user outcome

Large vaults can push thousands of nodes into the filtered graph. Drawing all
of them every frame wastes fill-rate and turns the canvas into an unreadable
hairball. Obsidian answers this with depth/relevance filtering; we answer it
with a render budget.

**Outcome:** the renderer never draws more than **500 nodes per frame**. When
the filtered model holds more than 500 nodes, the lowest-degree nodes are
hidden first; zooming/panning into a region reveals the smaller nodes there,
because the budget applies to the nodes in (or near) the viewport, picked
highest-degree first.

## 2. Scope

**In scope:**

- New pure module `packages/graph-renderer/src/visibility.ts`:
  `visibleNodeBudget(model, camera, viewport, budget)` returning the visible
  index set + whether anything was hidden. Pure, DOM-free, unit-tested.
- `renderer.ts` integration: per-frame visible-set computation, draw only
  visible nodes/links/arrows/labels, picker built from visible nodes only.
- Export `MAX_VISIBLE_NODES = 500` from the renderer package root.
- `GraphView.tsx`: "Showing 500 of N — zoom in to reveal more" notice when
  `filtered.model.nodes.length > MAX_VISIBLE_NODES` (mirrors the existing
  `truncated` notice pattern).
- Tests: `visibility.test.ts`, updated component/e2e coverage for the notice.

**Non-goals:**

- No changes to `/graph` payload, `buildGraphModel`, `applyFilters`,
  simulation, camera, or picking modules.
- No per-node UI to force-show a hidden node; hovered/selected nodes are
  force-included automatically (cheap, no UI).
- No animation or fade for appearing nodes; they pop in on the next frame.
- Header counts and `__tephraGraph` keep reporting the full filtered model
  (truthful counts); only the canvas is budgeted.

## 3. Invariants and security constraints

- Budget is render-only: filtering, counts, fallback list, and e2e hook are
  untouched and stay truthful.
- Deterministic: ties in degree break by node index (stable sort), so the
  visible set is stable across frames for a static camera.
- `visibility.ts` must stay DOM-free and browser-safe (importable from tests).
- No `innerHTML`; notice text via JSX as with the existing truncated notice.

## 4. Affected files / ownership

| Lane | Files |
| ---- | ----- |
| A — budget core + renderer | `packages/graph-renderer/src/visibility.ts` (new), `tests/visibility.test.ts` (new), `src/renderer.ts`, `src/index.ts` (export) |
| B — frontend notice | `apps/web/src/components/GraphView.tsx`, `apps/web/tests/graph-view.test.tsx`, `apps/web/e2e/graph.spec.ts` |

Lane B needs only the `MAX_VISIBLE_NODES` export contract from lane A;
run A first, then B.

## 5. Implementation steps

1. **A1 `visibility.ts`.** Signature:
   `visibleNodeBudget(model: GraphModel, isInView: (index: number) => boolean, budget: number, force?: Set<number>): { visible: Uint8Array; hiddenCount: number }`
   where the caller supplies the viewport predicate (keeps this module free
   of the camera type). Algorithm: single pass over a degree-desc index
   order (build inside via stable sort over `model.nodes`, or accept a
   pre-sorted order param — implementer's choice, keep it one pass +
   one sort), mark visible until `budget` is reached; always mark `force`
   indices visible (selected/hovered, over budget if needed). `hiddenCount`
   = kept-but-unmarked nodes. Export `MAX_VISIBLE_NODES = 500` from this
   module (single source of truth).
2. **A2 `renderer.ts`.** Per frame (inside `draw`, before the links pass):
   build the viewport predicate from existing cull logic
   (`worldToScreen` + `radii`, same bounds as the node pass), call
   `visibleNodeBudget` with `labelOrder` reuse where possible, `budget =
   MAX_VISIBLE_NODES`, force = selected + hovered indices. Order passes as:
   compute set → links (skip unless both ends visible) → nodes (skip unless
   visible) → arrows (same as links) → labels (unchanged cap logic, only
   over visible nodes). `rebuildPicker` must use the same visible set:
   compute visibility once per `frame()` and share between picker + draw
   (e.g. compute in `frame()` before both calls, or memo per camera/model
   revision — implementer's choice, but picker and canvas MUST agree or
   users will click invisible nodes).
3. **A3 exports.** Re-export `MAX_VISIBLE_NODES` (and the
   `visibleNodeBudget` helper) from `src/index.ts`. Keep it out of `pure.ts`
   only if `visibility.ts` gains DOM imports — it must not; prefer also
   exporting from `pure.ts` for test convenience.
4. **B1 `GraphView.tsx`.** Import `MAX_VISIBLE_NODES`; when
   `filtered.model.nodes.length > MAX_VISIBLE_NODES`, render a notice next
   to the `truncated` notice:
   `Showing 500 of {N} — zoom in to reveal smaller nodes.`
   (`data-testid="graph-budget-notice"`).
5. **B2 tests + e2e.** `visibility.test.ts`: budget respected, degree order,
   force-include over budget, empty/single models, determinism. Component
   test: budget notice appears only when the pushed model exceeds 500
   (build a 501-node fixture or mock the filtered length). E2E: assert the
   notice is absent on the small fixture vault (no behaviour change there).
6. **Verify:** `npm run check` at root; both packages' vitest suites.

## 6. API / schema / migration changes

- None on the wire. New package export `MAX_VISIBLE_NODES`; no prop changes
  (`TephraGraphProps` untouched).

## 7. Tests and verification

- `vitest run` in `packages/graph-renderer` (new `visibility.test.ts`).
- `vitest run` in `apps/web` (notice test).
- `npm run check` (repo root) — required.
- Manual: sample vault, zoom out (≤500 drawn), zoom into a dense cluster
  (small-degree nodes appear), pan (set follows viewport), hover a visible
  node (highlight only touches drawn neighbours).

## 8. Compatibility, deployment, rollback risks

- Perf: visibility pass is O(N log N) once per model + O(N) per frame
  (viewport predicate over degree order, early-out at budget) — negligible
  vs the draw calls it saves. Simulation still runs on the full model
  (one-off cost, idles after settle); deliberately unchanged.
- Rollback: revert single commit.

## 9. Completion checklist

- [ ] `visibility.ts` + test (budget, order, force, determinism)
- [ ] `renderer.ts` draws ≤500, picker agrees with canvas
- [ ] `MAX_VISIBLE_NODES` exported from package root
- [ ] `GraphView` budget notice + `data-testid`
- [ ] Component + e2e coverage for the notice
- [ ] `npm run check` green
