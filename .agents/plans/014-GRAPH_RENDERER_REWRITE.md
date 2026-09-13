# 014 — Hand-rolled graph renderer + frontend rebuild

> **Status:** implementation plan (approved for immediate execution)
> **Depends on:** `001-TEPHRA_STAGE1_PLAN.md`, `011-OBSIDIAN_GRAPH_VIEW.md`
> **Packages:** `tephra-server/packages/graph-renderer`, `tephra-server/apps/web`
> **Compatibility:** none required — pre-launch, `/graph` payload unchanged
> **Last updated:** 2026-09-13

## 1. Context and user outcome

The current graph stack (`sigma.js` + `graphology` + ForceAtlas2 worker,
`packages/graph-renderer/src/graphology.ts`, `layout.ts`,
`components/TephraGraph.tsx`) does not look or feel like Obsidian. ForceAtlas2
clustering is wrong, Sigma owns the camera/interaction, and every behaviour
change fights the library.

**Outcome:** delete the Sigma/graphology renderer completely and hand-write a
Canvas-2D renderer + force simulation from scratch (zero graph deps), then
rebuild the React frontend around it so the result is recognisably Obsidian:
hover-neighbourhood highlight, drag-to-pin, wheel zoom, drag/arrows pan,
`Shift` accelerate, zoom-dependent label fade, local-graph depth.

Research (Exa, 2026-09-13) confirms the target behaviour:

- Obsidian itself is closed-source (minified `app.js`, no public API); every
  "Obsidian renderer" description is inference. The closest faithful clone is
  `quartz-community/graph` → `graph.inline.ts` (~800 lines): `d3-force`
  (`forceManyBody(-100*repel)`, `forceCenter(center)`, `forceLink(distance)`,
  `forceCollide(nodeRadius, 3 iters)`, optional `forceRadial`) + PixiJS WebGL
  (three containers: links/nodes/labels, per-node circle, hover dim
  `alpha 0.2`, `nodeRadius = 2+sqrt(degree)`, d3-zoom + d3-drag with
  `fx/fy` pin, label opacity `max((k*opacityScale-1)/3.75,0)`).
- Obsidian Help (graph view): hover highlights connections, click opens,
  wheel/`+`/`-` zoom, drag/arrows pan, `Shift` speeds keyboard, cog settings
  with Filters/Groups/Display/Forces, `Restore default settings`, local graph
  reuses all settings + depth slider.
- Advanced-graph plugins confirm worker-offloaded layout scales, but Stage 1
  caps at 10k nodes and our doctrine is **hand-rolled, no new deps** — so the
  simulation stays on the main thread in one rAF loop with early settling.

## 2. Scope

**In scope:**

- Delete: `src/graphology.ts`, `src/layout.ts`,
  `src/components/TephraGraph.tsx`, `tests/graphology.test.ts`,
  Sigma/ForceAtlas2 deps from `packages/graph-renderer/package.json` and
  `apps/web/package.json`, `@react-sigma/core/lib/style.css` import.
- New hand-written, dependency-free renderer in `packages/graph-renderer/src/`:
  - `simulation.ts` — force simulation (repulsion + springs + center gravity
    + collision), seeded start, reheat-on-interaction, settles to zero CPU.
  - `camera.ts` — world↔screen transform, wheel zoom to cursor, drag pan,
    keyboard pan/zoom, `fitView`.
  - `renderer.ts` — imperative `createGraphRenderer(host, opts)` owning one
    `<canvas>`: links pass, nodes pass, labels pass, arrows pass, hover
    dimming, DPR-aware resize via `ResizeObserver`.
  - `picking.ts` — spatial-hash / grid hit-test for hover/drag (no per-node
    listeners).
  - `TephraGraph.tsx` — thin React shell mounting the imperative renderer.
- Rebuilt frontend in `apps/web/src/components/`:
  - `GraphView.tsx` — fetch/settings/filter shell rewired to new renderer
    props, keeps accessible fallback list + `window.__tephraGraph` e2e hook.
  - `GraphSettingsPanel.tsx` — rebuilt against same `GraphSettings` type
    (collapsible Filters/Groups/Display/Forces + restore defaults).
  - `LocalGraph.tsx` — trivial rewire (unchanged behaviour).
- Keep untouched: `model.ts`, `query.ts`, `filter.ts`, `depth.ts`,
  `settings.ts`, `groups.ts`, `palette.ts` (+ tests). They are correct,
  tested, renderer-independent.
- Update `pure.ts`/`index.ts` exports, docs (`docs/graph-search.md` if it
  mentions Sigma), e2e `graph.spec.ts` selectors if needed.

**Non-goals:**

- No PixiJS, d3-force, Sigma, graphology, force-graph, or any new npm dep.
- No WebGL/WebGPU, no worker, no time-lapse animate (removed earlier).
- No server/payload changes (`/graph` v2 stays as-is).
- No right-click menus, no 3-D, no minimap, no edge labels.

## 3. Invariants and security constraints

- Stage 1 read-only; renderer never fetches or mutates — consumer passes a
  filtered `GraphModel` in.
- Strict TypeScript, browser-safe (no Node APIs in `packages/graph-renderer`).
- No `innerHTML`; labels via `fillText` only; no tokens/vault content in logs.
- Canvas text is not screen-reader visible — the note-list fallback and
  `aria-label` on the canvas host MUST stay.
- Deterministic initial layout from `seed` (mulberry32 carried over).

## 4. Affected files / ownership (parallel lanes)

| Lane | Owner files |
| ---- | ----------- |
| A — kill old | `packages/graph-renderer/src/graphology.ts`, `src/layout.ts`, `src/components/TephraGraph.tsx`, `tests/graphology.test.ts`, both `package.json`, `apps/web/.../GraphView.tsx` sigma import |
| B — physics | `packages/graph-renderer/src/simulation.ts` (+ test), `src/camera.ts` (+ test), `src/picking.ts` |
| C — canvas | `packages/graph-renderer/src/renderer.ts`, `src/components/TephraGraph.tsx`, `src/index.ts`, `src/pure.ts` |
| D — frontend | `apps/web/src/components/GraphView.tsx`, `GraphSettingsPanel.tsx`, `LocalGraph.tsx`, `tests/graph-*.test.tsx`, `e2e/graph.spec.ts` |

B and C integrate in order B→C; D runs against the new `TephraGraphProps`
contract once C publishes it. A first (unblocks all).

## 5. Implementation steps

1. **A: delete old renderer.** Remove files, deps, CSS import; make `pure.ts`
   not export graphology/layout; `npm run check` passes with GraphView
   temporarily rendering fallback list only.
2. **B1: `simulation.ts`.** Types: `SimNode {id,x,y,vx,vy,r,mass,pinned}`,
   `SimEdge {s,t}`. `createSimulation(nodes, edges, forces)` with hand forces:
   - repulsion: Coulomb `-repelK/d²`, Barnes-Hut NOT required — O(n²) capped:
     uniform-grid bucketing, each node checks ≤ ~9 cells; n=10k settles.
   - springs: `F = linkForce*(d-linkDistance)` along edge.
   - center: `F = centerForce * pos * 0.02` toward centroid.
   - collision: pairwise push when `d < r_i+r_j+2`.
   - integration: semi-implicit Euler, velocity decay 0.7, clamp step.
   - API: `tick()→moved:boolean`, `reheat(alpha)`, `setForces()`,
     `pin/unpin`, `positions(Float32Array)`. Seeded circle start (mulberry32,
     radius 100+jitter — same feel as before).
3. **B2: `camera.ts`.** `{x,y,k}` world→screen; `zoomAt(cursor, factor)`,
   `pan(dx,dy)`, `fitView(positions, radii, viewport)`, keyboard step
   `40 (Shift:120) * k`. Pure + unit-tested (no DOM).
4. **B3: `picking.ts`.** Uniform-grid index rebuilt per frame;
   `hitTest(sx,sy)→id|null`, `nodesInViewport()`. Pure + tested.
5. **C1: `renderer.ts`.** `createGraphRenderer(host, {onNodeClick,onNodeHover,
   onReady})` + `setModel(model, groupColors, palette, settings)` +
   `setSelected(id)` + `destroy()`. Internals: one canvas, `ResizeObserver`,
   DPR clamp 2, rAF loop (ticks sim ≤ 300 frames then idles; any
   setModel/setForces/drag reheats), draw order links→nodes→arrows→labels.
   Node radius `nodeSize*(2+sqrt(degree))`; link width
   `linkThickness*(1+log2(count))`; hover: active+neighbours full alpha,
   rest `0.15` nodes / hidden edges; labels: hovered always, else
   `k >= textFadeThreshold*4` and in viewport, cap ~250 by degree.
   Drag: pointerdown on node → pin + reheat; move → update fx/fy; up → unpin
   (click < 500 ms + < 4 px → onNodeClick). Wheel: zoom to cursor.
   Keyboard: host `tabIndex=0`, arrows/`+`/`-`/Shift.
6. **C2: `TephraGraph.tsx`.** Props `{model, settings, groupColors, palette,
   selectedId, seed, onNodeClick, onNodeHover, onReady}` — same shape as
   before minus `onWebglError` (Canvas 2D always available). `useEffect`
   mounts renderer once, pushes props via refs. No Sigma CSS.
7. **D1: `GraphView.tsx` rebuild.** Same data flow (fetch → buildGraphModel →
   scopedBase → filtered → groupColors → palette) but imports new
   `TephraGraph` directly (no `lazy` needed — renderer is ~15 KB, no chunk).
   Keeps: section chrome, cog panel, `IndexPending`, `truncated` notice,
   `graph-selection`, fallback list, `__tephraGraph` hook.
8. **D2: settings panel rebuild.** Same controls/ids (e2e depends on them),
   fresh markup with `<details>` sections; search debounce 250 ms kept.
9. **D3: tests + e2e.** New `simulation.test.ts`, `camera.test.ts`,
   `picking.test.ts`; rewrite component tests to mock `TephraGraph` (not
   Sigma); Playwright asserts canvas mounts + counts + orphan toggle +
   click-navigates + keyboard pan.
10. **Verify:** `npm run check`, `vitest run` (both packages), Playwright
    graph spec, `PROGRESS.md` touch-up only if verified.

## 6. API / schema / migration changes

- None on the wire. `TephraGraphProps` loses `onWebglError`; renderer package
  loses `/pure` graphology/layout exports. `apps/web` drops
  `@react-sigma/*` deps.

## 7. Tests and verification

- `npm run check` (repo root) — required.
- `vitest run` in `packages/graph-renderer` + `apps/web`.
- `playwright test graph.spec` (SwiftShader canvas 2D works headless).
- Manual: sample vault global + local graph, hover dim, drag pin,
  wheel zoom, keyboard, depth slider, theme switch re-tint.

## 8. Compatibility, deployment, rollback risks

- Bundle shrinks (~600 KB Sigma removed); no deploy changes.
- Canvas 2D perf at 10k nodes: grid-capped repulsion + label cap keep 60 fps
  on desktop; older mobile may dip — acceptable, fallback list remains.
- Rollback: git revert single PR (old Sigma code not kept side-by-side).

## 9. Completion checklist

- [ ] Sigma/graphology/FA2 code + deps + CSS gone
- [ ] `simulation.ts` + test (converges, settles, deterministic seed)
- [ ] `camera.ts` + test, `picking.ts` + test
- [ ] `renderer.ts` + `TephraGraph.tsx` (hover/drag/zoom/keyboard/labels)
- [ ] `GraphView` + `LocalGraph` + `SettingsPanel` rebuilt
- [ ] Component + e2e tests green
- [ ] `npm run check` green
