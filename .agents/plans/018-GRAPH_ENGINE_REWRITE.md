# 018 — Graph engine rewrite (Obsidian-grade performance)

> **Status:** implementation plan (approved for immediate execution)
> **Supersedes:** renderer/simulation/picking/visibility parts of `014`, all of `015`
> **Packages:** `tephra-server/packages/graph-renderer`, `tephra-server/apps/web`
> **Compatibility:** none required — pre-launch, `/graph` payload unchanged
> **Last updated:** 2026-10-12

## 1. Context and user outcome

The hand-rolled Canvas renderer from plan 014 is slow with only a few hundred
notes. Root causes found in `simulation.ts` / `renderer.ts`:

1. **O(n²) layout.** Every node starts on a circle of radius 100–150, so
   with cell size ≥ 200 the uniform "grid" has 1–4 cells and repulsion is
   all-pairs. Each pair also allocates into a `Set<number>` (`i*count+j`),
   twice per tick (repulsion + collision), plus a `Map` of arrays per grid.
2. **Short-range-only repulsion** (cutoff `2*linkDistance`) + `MAX_STEP=10`
   means hundreds of nodes take thousands of ticks to untangle, but ticks are
   capped at 300 — the layout never converges into Obsidian-like clusters.
3. **First paint never simulates** (static seeded circle until "Animate").
4. **Draw path:** one `beginPath/stroke` + 3 style writes per link, one
   `arc/fill` per node, `worldToScreen` object allocation per endpoint,
   `activeSet` keyed by string ids.
5. **Per-frame waste:** `computeVisible` (sort-order walk + `Set` + closure),
   `picker.rebuild` allocating arrays every frame, `prevPositions.set` for
   every node every frame, `setModel` rebuilding the simulation from scratch
   on any settings change (e.g. dragging the node-size slider).
6. The 500-node "render budget" (plan 015) hides nodes as a workaround —
   Obsidian draws every node.

**Outcome:** a from-scratch engine that renders vaults of hundreds to
thousands of notes at 60 fps with Obsidian's look and feel: layout animates
from a phyllotaxis start into stable clusters within ~1–2 s, hover dims
non-neighbours with an animated fade and highlights neighbour edges, drag
pins a node and the graph reacts live, wheel zoom/pan is smooth, labels fade
in with zoom. Every node is always drawn (no budget).

Reference behaviour (Obsidian, inferred — app is closed source; closest
public clone is Quartz `graph.inline.ts`): d3-force semantics (many-body
Barnes–Hut, link springs with degree bias, centering, collide), WebGL
rendering via PixiJS, labels below nodes fading with zoom, hover alpha 0.2.

## 2. Scope

**In scope (all inside `packages/graph-renderer/src/`):**

- New `engine/` directory, zero npm dependencies:
  - `engine/types.ts` — shared contracts (written first, by the lead).
  - `engine/quadtree.ts` — flat typed-array quadtree (Barnes–Hut + collide +
    picking queries).
  - `engine/simulation.ts` — d3-force-equivalent simulation on typed arrays.
  - `engine/color.ts` — CSS colour string → RGBA floats (cached).
  - `engine/webgl.ts` — WebGL2 backend: instanced SDF circles + instanced
    line quads (+ arrow heads), one draw call per primitive type.
  - `engine/canvas2d.ts` — Canvas2D fallback backend, batched by colour.
  - `engine/labels.ts` — label layer on an overlay 2D canvas.
  - `engine/scene.ts` — per-frame scene buffers (colours/alphas/highlight
    animation), zero allocation per frame.
  - `engine/picker.ts` — hit-testing against live positions.
  - `engine/renderer.ts` — orchestrator: rAF loop, interaction, camera,
    backend selection, public `GraphRenderer` API.
- Delete: `src/simulation.ts`, `src/renderer.ts`, `src/picking.ts`,
  `src/visibility.ts` and their tests (`simulation.test.ts`,
  `picking.test.ts`, `visibility.test.ts`). `signature.test.ts` follows
  `sameIdSet` into `engine/renderer.ts` or is deleted if the helper goes.
- Keep untouched: `model.ts`, `query.ts`, `filter.ts`, `depth.ts`,
  `settings.ts`, `groups.ts`, `palette.ts`, `camera.ts` (+ tests).
- `components/TephraGraph.tsx` keeps its props (`animateToken` reheats);
  rewired to `engine/renderer`.
- `index.ts` / `pure.ts` exports updated (drop `MAX_VISIBLE_NODES`,
  `visibleNodeBudget`, old sim/picker exports; export new pure engine pieces
  that are DOM-free: quadtree, simulation, color).
- `apps/web`: drop budget notice + `MAX_VISIBLE_NODES` import from
  `GraphView.tsx`; update `graph-view.test.tsx` and `e2e/graph.spec.ts`.
- Benchmark test (`tests/engine-perf.test.ts`): simulation on a synthetic
  1 000-node / 2 000-edge graph must run 300 ticks well under a generous CI
  bound and settle; asserts no NaN.

**Non-goals:** new npm deps (no d3, pixi, sigma); Web Worker simulation
(main-thread Barnes–Hut is ~1 ms/tick at 1k nodes; revisit for 10k);
WebGPU; server/payload changes; edge labels; 3-D; minimap.

## 3. Invariants

- Shared package stays browser-safe; no Node APIs.
- No per-frame heap allocation in steady state (typed arrays reused; no
  object-per-node in hot loops; no string keys in hot loops).
- Simulation deterministic for a given seed (tests rely on it).
- Idle at 0 CPU: rAF loop stops when settled, not dragging, and no highlight
  fade is in progress.
- No vault content logged.
- Works under jsdom for unit tests (renderer must tolerate missing WebGL2
  *and* missing 2D context without throwing).

## 4. Contracts (`engine/types.ts` is authoritative)

Simulation (`engine/simulation.ts`), d3-force semantics:

- Init positions: phyllotaxis (`r = 10*sqrt(0.5+i)`, `θ = i*π(3-√5)`), with
  a seeded jitter; nodes with provided `initialX/Y` keep them.
- `alpha` starts 1, `alphaMin 0.001`, `alphaDecay = 1 - alphaMin^(1/300)`,
  `alphaTarget` (0.3 while dragging), `velocityDecay 0.4`.
- Many-body: Barnes–Hut θ=0.9, `strength = -(repelForce * 300 + 30)`,
  `distanceMax = ∞`, `distanceMin² = 1`.
- Link: d3 bias `count(s)/(count(s)+count(t))`, strength
  `linkForce / min(count(s), count(t))`, distance `linkDistance`, 1 iteration.
- Center: `forceX/forceY` toward 0 with strength `centerForce * 0.1`.
- Collide: radius `r_i + 2`, strength 0.7, 1 iteration, quadtree based.
- `setForces` mutates params and gently reheats (alpha ≥ 0.3).
- `setRadii` swaps radii without resetting positions.
- Pinned nodes (`fx/fy`) have zero velocity and fixed position.

Backends (`DrawBackend`): consume a `SceneFrame` (typed arrays, camera,
viewport, dpr) and draw edges → nodes → focus rings → arrows. Labels are a
separate `LabelLayer` on an overlay canvas so both backends share it.

Visual rules:

- Node screen radius `max(1, r * k)`; ring for selected/hovered: 2 px stroke
  at `r*k + 3`, colour `palette.focused`.
- Edge screen width `clamp(width * min(1, k), 0.5, 8)` CSS px, where
  `width = linkThickness * (1 + log2(count))`.
- Hover (animated over 200 ms via `highlight ∈ [0,1]`): hovered node +
  neighbours alpha 1, others `lerp(1, 0.2, highlight)`; edges touching the
  hovered node get `palette.focused` colour, other edges alpha
  `lerp(1, 0.1, highlight)`.
- Labels: centred below the node (`y + r*k + 4`), 12 px
  `system-ui`, colour `palette.label`. Global opacity
  `clamp((k - t) / t, 0, 1)` where `t = textFadeThreshold * 2` (t = 0 ⇒ no
  labels except hovered/neighbours); hovered + neighbours always opaque;
  others additionally multiplied by node alpha. Only nodes inside the
  viewport are considered; drawn largest-degree first, max 400 per frame,
  with a coarse screen-space occupancy grid to skip overlapping labels.
  `measureText` widths cached per node index; cache dropped on model change.

Renderer behaviour:

- `setModel` with the same id list → keep simulation, update radii/forces/
  colours in place (no rebuild); different ids → new simulation seeded with
  previous positions for surviving ids; new ids start at a neighbour's
  position (+ jitter) if any, else phyllotaxis.
- First model: simulate immediately (live animation), camera fits once after
  ~60 ticks have been run synchronously before first paint (warm start,
  bounded to 12 ms), then keeps auto-fitting until the user interacts with
  the camera or the sim settles.
- Simulation runs ≤ 1 tick per frame normally; while alpha > 0.5 and a tick
  costs < 4 ms it may run 2–3 ticks per frame.
- Drag: `alphaTarget 0.3`, pin to pointer; on release unpin (Obsidian does
  not keep nodes pinned), `alphaTarget 0`.
- Click = < 500 ms and < 4 px; wheel zoom to cursor (`exp(-dy*0.0015)`, with
  `ctrlKey` pinch scaling ×3); drag background to pan; keyboard arrows/±.
- Hover picking via quadtree rebuilt lazily (only on pointer events, at most
  once per frame).
- `onReady` fires after the first painted frame.

## 5. Lanes (parallel; non-overlapping file ownership)

| Lane | Owner files | Depends on |
| ---- | ----------- | ---------- |
| A — Simulation | `engine/quadtree.ts`, `engine/simulation.ts`, `tests/engine-quadtree.test.ts`, `tests/engine-simulation.test.ts`, `tests/engine-perf.test.ts` | `types.ts` |
| B — WebGL2 backend | `engine/webgl.ts`, `tests/engine-webgl.test.ts` | `types.ts` |
| C — Canvas2D + labels + colour | `engine/canvas2d.ts`, `engine/labels.ts`, `engine/color.ts`, matching tests | `types.ts` |
| D — Orchestrator | `engine/scene.ts`, `engine/picker.ts`, `engine/renderer.ts`, `components/TephraGraph.tsx`, `index.ts`, `pure.ts`, deletions, matching tests | A, B, C (codes against `types.ts`, integrates last) |
| E — Web app | `apps/web/src/components/GraphView.tsx`, `apps/web/tests/graph-*.test.tsx`, `apps/web/e2e/graph.spec.ts`, docs | D's exports |

Sequencing: lead writes `types.ts` → A, B, C run in parallel → D integrates
→ E → lead runs `npm run check` and a browser perf pass on a synthetic
1 000-note graph.

## 6. Verification

- `npm run check` (lint, typecheck, build, all workspace tests).
- Unit: quadtree correctness vs brute force; simulation determinism, no NaN,
  settles, pinned nodes fixed, link distances converge; colour parsing;
  canvas2d batching (mock context counts `stroke`/`fill` calls ≤ colours);
  labels opacity math + overlap skipping; scene highlight math; picker vs
  brute force; renderer works under jsdom with no WebGL/2D.
- Perf: `engine-perf.test.ts`; manual browser check with dev server.
- e2e `graph.spec.ts` updated (no budget notice).

## 7. Risks and rollback

- WebGL2 unavailable / context loss → Canvas2D fallback; on
  `webglcontextlost` switch to Canvas2D.
- Layout look differs from old renderer — intended.
- Rollback: revert the commit; no data/schema impact.

## 8. Completion checklist

- [ ] `engine/` implemented, old modules deleted
- [ ] web app updated, budget notice gone
- [ ] tests + perf test green, `npm run check` green
- [ ] browser perf pass at ≥ 500 nodes
- [ ] PROGRESS.md updated; plans 014/015 deleted; this plan deleted after commit
