# Obsidian-parity graph view

> **Status:** implementation plan
> **Target:** `.agents/plans/011-OBSIDIAN_GRAPH_VIEW.md`
> **Depends on:** `001-TEPHRA_STAGE1_PLAN.md`, `010-NOTE_IDENTITY_MODES_AND_PATH_URLS.md`
> **Packages:** `tephra-server` (web, api, protocol, indexer, database)
> **Compatibility:** none required — Tephra is pre-launch, the `/graph` payload may be redefined
> **Last updated:** 2026-09-09

---

## 1. Context and user outcome

`tephra-server/apps/web/src/components/GraphView.tsx` renders the vault with
`react-force-graph-2d`: uniform dots, faint links, hover-neighbourhood highlighting, a label painted
only for the active node. It is a good Stage 1 placeholder and it already reads the Obsidian palette
(`--graph-node`, `--graph-line`, and the unused `--graph-node-tag` / `-attachment` / `-unresolved` /
`-focused` in `src/theme/themes.ts:47`).

What it is not is the Obsidian graph. It is missing every control surface Obsidian ships (Filters,
Groups, Display, Forces), tags and attachments as nodes, unresolved links, orphan handling, the local
graph with a depth slider, and the time-lapse animation. It also runs the force simulation and a
full canvas repaint on the main thread, which is the wrong shape for a 5k–10k-note vault — and the
API already slices at 10 000 files (`apps/api/src/app.ts:884`).

**Outcome:** a graph view that a current Obsidian user recognises as _the_ graph view — same visual
language, same four settings sections, same local-graph behaviour — that stays interactive at
10 000 nodes in a browser tab.

---

## 2. Research: what exists to copy

**Obsidian's own graph is not open source.** Obsidian is closed-source proprietary software; the
graph view is a core plugin whose implementation ships only as minified `app.js`. There is no
official source, and public claims about its renderer internals are inference, not documentation.
Everything below is a _clone_, not the original.

| Reference implementation                                                                                                                                                                              | What it is                                                                                                                                                                                                                                                 | License         | Useful for                                                                    |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ----------------------------------------------------------------------------- |
| [`quartz-community/graph`](https://github.com/quartz-community/graph) (`src/components/scripts/graph.inline.ts`, ~800 lines) — extracted from [Quartz v4](https://github.com/jackyzha0/quartz) (13k★) | The closest visual clone in the wild. `d3-force` + **PixiJS v8**, radius `2 + sqrt(degree)`, hover neighbourhood with 0.2 alpha dimming, drag-to-pin, d3-zoom, per-node `PIXI.Text` labels, optional radial force, local-graph depth, visited-node tinting | **MIT**         | Direct structural reference; the layout/force constants match Obsidian's feel |
| Advanced Graph View / graph-insight (Obsidian community plugin)                                                                                                                                       | Pixi WebGL renderer with force layout + graphology analytics each in their own Web Worker; targets 5k–50k-note vaults                                                                                                                                      | closed / plugin | Confirms worker-offloaded layout is the scaling answer                        |
| [`AlexW00/obsidian-3d-graph`](https://github.com/AlexW00/obsidian-3d-graph)                                                                                                                           | 3D take, `react-force-graph-3d` + three.js                                                                                                                                                                                                                 | MIT             | Feature list only                                                             |
| Foam, Trilium, LogSeq graph views                                                                                                                                                                     | All land on `force-graph`/`d3-force` + canvas or Pixi                                                                                                                                                                                                      | MIT/AGPL        | Confirms the ecosystem default                                                |

**Rendering/layout libraries evaluated:**

| Library                                | Version / license          | Verdict                                                                                                                                                                                                                            |
| -------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `react-force-graph-2d` / `force-graph` | 1.29.1 / 1.51.4, MIT       | _Current._ Canvas 2D, simulation on the main thread, one draw call per node/link per frame and a `fillText` per label. Fine to ~1–2k nodes; no seam to move layout off-thread.                                                     |
| **`pixi.js` + `d3-force`**             | **8.20.1 MIT / 3.0.0 ISC** | **Recommended.** WebGL (WebGPU-capable) batched rendering, `d3-force` runs in a Worker, proven by Quartz at exactly this job. Keeps d3's force vocabulary, which is what Obsidian's four Forces sliders map onto 1:1.              |
| `sigma` + `graphology`                 | 3.0.3 / 0.26.0, MIT        | Excellent WebGL renderer, but its layout story is ForceAtlas2, whose clustering does not look like Obsidian's. Obsidian-style hover dimming and label fade need custom node/edge programs — more work than Pixi for a worse match. |
| `@antv/g6`                             | 5.1.1, MIT                 | Full diagramming framework. Heavy, opinionated, aimed at a different problem.                                                                                                                                                      |
| `@cosmograph/cosmos`                   | 3.4.1, **CC-BY-NC-4.0**    | **Ruled out on license.** Non-commercial only; incompatible with an AGPL, self-hostable product. Fastest option (GPU-side simulation) if it were usable.                                                                           |

### 2.1 Decision

**PixiJS v8 rendering + `d3-force` in a Web Worker, structured after the Quartz implementation.**
The renderer sits behind a small imperative interface so the data, filter, and settings layers
(§5–§7 — the majority of the work, and all of the Obsidian feature parity) are renderer-independent
and testable without a GPU.

---

## 3. Product decisions

| Decision                             | Resolution                                                                                                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Vendor Quartz's file?                | **No.** Study it, cite it, write our own against our data model. MIT permits either; a 800-line `@ts-nocheck` IIFE is not what this codebase looks like.                           |
| Keep `react-force-graph-2d`?         | **Removed** once §8 lands. Two renderers is not a supported configuration.                                                                                                         |
| WebGL unavailable                    | Pixi v8 **dropped the canvas fallback renderer**. On context-creation failure, render the existing accessible note list plus an explanation — do not ship a second renderer (§11). |
| Search-query language                | A **documented subset** of Obsidian search: bare terms, `"quoted phrase"`, `path:`, `file:`, `tag:#x`, `-` negation, implicit AND. Not the full grammar.                           |
| Where filtering runs                 | **Client-side**, over per-node title/path/tags shipped in the payload. Keeps groups (N live queries) instant and avoids N search round-trips.                                      |
| Tags/attachments/unresolved as nodes | **Yes** — required for Filters parity. Tags are already indexed (`vault-model` `NoteMetadata.tags`); unresolved links are `note_links` rows with `target_file_id IS NULL`.         |
| Settings persistence                 | `localStorage`, keyed `tephra:graph:<vaultId>:{global,local}`. Never server-side; no protocol change.                                                                              |
| Time-lapse "Animate"                 | **In scope** (§9), last. Needs a per-file creation timestamp in the payload.                                                                                                       |
| Node right-click menu                | **Out of scope.** Tephra is read-only in Stage 1; the actions Obsidian offers do not exist yet.                                                                                    |
| 10 000-node cap                      | Kept, but made explicit: the payload reports `truncated: true` and the UI says so, instead of silently lying.                                                                      |

---

## 4. Feature parity checklist

Sourced from [Obsidian Help → Graph view](https://obsidian.md/help/plugins/graph).

**Filters** — search files · tags · attachments · existing files only · orphans
**Groups** — N named search queries, each with a colour; first match wins
**Display** — arrows · text fade threshold · node size · link thickness · animate
**Forces** — center force · repel force · link force · link distance
**Interaction** — hover highlights the node's connections · click opens the note · scroll or `+`/`-` zooms · drag or arrow keys pan · `Shift` accelerates keyboard movement · drag pins a node
**Sizing** — node radius grows with reference count
**Local graph** — every global setting, plus a depth slider, rooted at the open note
**Chrome** — cog-opened settings box, collapsible sections, _Restore default settings_

---

## 5. Server: graph payload v2

`GET /api/v1/vaults/:vaultId/graph` today returns markdown files and resolved-link counts only. It
grows to carry everything the Filters section needs, in a shape that stays small at 10k nodes.

```ts
// packages/protocol/src/index.ts
graphResponseSchema = {
  revision: number,
  truncated: boolean, // the 10k cap was hit
  nodes: Array<{
    id: string;
    path: string; // for unresolved: the raw link path
    title: string | null;
    kind: 'note' | 'attachment' | 'tag' | 'unresolved';
    tags: string[]; // note nodes only
    createdAt: number; // time-lapse ordering (§9)
  }>,
  edges: Array<{ s: number; t: number; count: number; embeds: number }>,
};
```

- **Edges reference nodes by array index** (`s`/`t`), not by id string. At ~30k edges this is the
  difference between a ~2.5 MB and a ~600 KB response; it also removes an id→node hash join on the
  client. Validate in the schema that indices are in range.
- `embeds` surfaces the `embedCount` the indexer already computes (`packages/indexer/src/index.ts:26`)
  and the API currently discards.
- **Tag nodes** are synthesised from `note_metadata.tags_json`, id `tag:<name>`, one edge per
  note→tag. **Attachment nodes** drop the `kind === 'markdown'` filter at `app.ts:883` and link via
  embeds. **Unresolved nodes** come from `note_links` rows with a null `target_file_id`, deduped by
  normalised link path, id `unresolved:<path>`.
- **Orphans** are not a payload concept — degree 0 is computed client-side, because the toggle must
  react to the other filters (a note whose only link is to a hidden tag is an orphan _under those
  filters_).
- Add `ETag: W/"<revision>-<flags>"` + `304` handling; the graph is pure derived state.

**Cost control:** tags and attachments multiply node count. Take the cap after synthesis, prefer
markdown nodes when trimming, and set `truncated`.

---

## 6. Client: data + filter engine (pure, no DOM)

New directory `apps/web/src/graph/`:

- `model.ts` — payload → `GraphModel { nodes: RenderNode[], links: RenderLink[], adjacency: Uint32Array[] }`.
  Precompute degree once (Quartz recomputes it inside `nodeRadius` in an O(V·E) loop — do not copy
  that). Node radius `nodeSize * (2 + Math.sqrt(degree))`.
- `query.ts` — the search subset of §3. `parseQuery(string) → Predicate`, `matches(node, predicate)`.
  Pure, exhaustively unit-tested; this is the piece both Filters-search and every Group depends on.
- `filter.ts` — applies the whole Filters section in a fixed order (kind toggles → search →
  existing-only → orphan removal, orphans last since earlier steps create them) and returns a
  filtered `GraphModel` plus a stable index map so the worker can diff instead of restarting.
- `depth.ts` — BFS from a root id to `depth` hops over the _undirected_ adjacency, for the local graph.
- `settings.ts` — the settings type, Obsidian's defaults, `localStorage` load/save, and
  `restoreDefaults()`.

None of these import React or Pixi. They carry the parity logic and they are cheap to test.

---

## 7. Client: force simulation in a Worker

`apps/web/src/graph/worker/simulation.worker.ts`, a module worker (Vite `new Worker(new URL(...), { type: 'module' })`).

- Owns `d3.forceSimulation` with `charge` (repel force), `center`, `link` (link force + link
  distance), and `collide` — the four Obsidian Forces sliders map directly:

  | Obsidian slider | d3 force                             |
  | --------------- | ------------------------------------ |
  | Center force    | `forceCenter().strength(c)`          |
  | Repel force     | `forceManyBody().strength(-100 * r)` |
  | Link force      | `forceLink().strength(l)`            |
  | Link distance   | `forceLink().distance(d)`            |

- **Protocol:** main → worker `{init, setNodes, setForces, pin, unpin, reheat, stop}`;
  worker → main a single `Float32Array(n*2)` of positions, **transferred**, at most once per animation
  frame. Main thread keeps a double buffer and posts the array back for reuse — zero allocation in
  the steady state.
- Worker ticks on its own timer and **stops when `alpha < alphaMin`** with no pending interaction,
  so an idle graph costs no CPU. Any settings change, drag, or filter change reheats.
- Drag pins via `fx`/`fy` (Quartz `graph.inline.ts:503`); release unpins, matching Obsidian.
- Fallback: if `Worker` construction fails, run the identical simulation module on the main thread.
  The module must therefore not import worker globals at top level.

---

## 8. Client: PixiJS renderer

`apps/web/src/graph/renderer/` — imperative, framework-free, one entry point:

```ts
createGraphRenderer(canvasHost: HTMLElement, opts): {
  setModel(model), setPositions(Float32Array), setSettings(s), setTheme(palette),
  setActive(id | null), zoomToFit(), destroy()
}
```

- **App:** `PIXI.Application` with `backgroundAlpha: 0`, `antialias: true`,
  `resolution: min(devicePixelRatio, 2)`, `autoDensity`. Three containers: links, nodes, labels.
- **Nodes** are sprites of one shared white circle texture, per-node `tint` and `scale` — a single
  batched draw call for the whole vault, versus Quartz's one `PIXI.Graphics` per node. Colour by
  kind (`--graph-node`, `--graph-node-tag`, `--graph-node-attachment`, `--graph-node-unresolved`),
  overridden by the first matching Group, overridden by `--graph-node-focused` for the open note.
- **Links** are rebuilt into **one** `PIXI.Graphics` per frame (`clear()` then `moveTo/lineTo`),
  width `linkThickness * (1 + log2(count))`. Arrows, when enabled, are a second batched pass of
  triangle sprites at the target end — skipped entirely below a zoom threshold where they are
  sub-pixel.
- **Labels** are the performance cliff (Quartz allocates a `PIXI.Text` per node at
  `resolution: dpr * 4` up front). Instead: a pool of ~250 `PIXI.Text` objects, assigned each frame
  only to nodes that are **inside the viewport** and pass the **text fade threshold** — alpha ramps
  over the zoom scale exactly as Obsidian's slider describes. The hovered node always gets one.
- **Hover / hit-testing** goes through a `d3-quadtree` over positions, not Pixi's event system —
  one lookup per `pointermove` instead of per-node hit areas. Hover sets `active` on the node and
  its neighbours; everything else drops to alpha 0.2 (Quartz `graph.inline.ts:346`).
- **Camera:** `d3-zoom` on the canvas element driving `stage.position`/`stage.scale`, plus Obsidian's
  keyboard bindings — `+`/`-` zoom, arrows pan, `Shift` multiplies the step. The canvas host takes
  `tabIndex={0}` so the keys are reachable.
- **Theme:** re-tint on theme change from the existing `useTheme()` palette. No re-init.
- **Loading:** `import('pixi.js')` behind `React.lazy` so the ~450 KB renderer chunk never enters the
  initial bundle.

`GraphView.tsx` shrinks to a React shell: fetch, hold settings, own refs, mount the renderer, and
render the settings panel and the existing accessible fallback list.

---

## 9. Client: the Obsidian settings chrome

`GraphSettingsPanel.tsx` — the cog-in-the-corner box, four collapsible sections in Obsidian's order
(Filters, Groups, Display, Forces), _Restore default settings_ in its corner. Every control writes
through `settings.ts`, so persistence and defaults are free.

Two behaviours need care:

- **Groups** are an ordered list of `{ query, color }`. First match wins, evaluated with the same
  `query.ts` engine as the search box. Re-evaluated only when a query or the model changes.
- **Animate (time-lapse)** replays nodes in `createdAt` order over a fixed duration: hold a cutoff
  timestamp in state, feed the filter a `createdAt <= cutoff` predicate, and let the existing reheat
  path do the rest. Transport controls: play/pause/restart, per Obsidian.

**Local graph:** the same component with `root = open note` and a depth slider above Filters, using
`depth.ts`. Mounted next to the note view; `selectedId` already flows through `VaultWorkspace.tsx`.

---

## 10. Testing

- **Unit (vitest, no GPU):** `query.ts` grammar table — every operator, negation, quoting,
  precedence; `filter.ts` ordering, especially orphan-after-filter; `depth.ts` BFS at depths 0–3 with
  cycles; `model.ts` degree/radius; `settings.ts` round-trip and defaults; the forces mapping.
- **Worker:** import the simulation module directly (it must be worker-global-free) and assert it
  converges and stops below `alphaMin`, plus a loose budget — 5 000 nodes / 15 000 edges to
  `alphaMin` under a fixed tick count.
- **Component:** keep today's approach in `tests/graph-view.test.tsx` — mock the renderer module the
  way `react-force-graph-2d` is mocked today, assert the shell passes the right model and that the
  settings panel round-trips.
- **e2e (Playwright):** headless Chromium has SwiftShader WebGL. Assert the canvas mounts, a debug
  hook (`window.__tephraGraph`, dev-only) reports the expected node count, toggling _Orphans_ changes
  it, and clicking a node navigates to its path URL.
- **Accessibility:** the note-list fallback and `aria-label` stay; add the keyboard camera bindings
  to the e2e pass.

---

## 11. Risks

| Risk                                        | Mitigation                                                                                                                |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Pixi v8 has no canvas fallback renderer** | Detect WebGL context failure at init; render the accessible note list with an explanation. Decided, not discovered later. |
| Bundle size (~450 KB Pixi)                  | Lazy chunk (§8); it loads only when the graph tab is opened.                                                              |
| Tag/attachment nodes explode node count     | Cap after synthesis, prefer markdown, report `truncated` (§5).                                                            |
| Label text is still the hot path            | Pooled + viewport-culled + fade-thresholded (§8); budgeted in the perf test.                                              |
| Worker + jsdom friction in tests            | Simulation module is worker-global-free and imported directly by tests (§7).                                              |
| Search subset misleads Obsidian users       | Panel links to a doc listing exactly what is supported (§3).                                                              |

---

## 12. Phases

Each phase is independently shippable; the graph keeps working throughout.

| #   | Phase               | Deliverable                                                                                                           |
| --- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 1   | **Payload v2**      | protocol schema, API synthesis of tag/attachment/unresolved nodes, index-based edges, `truncated`, ETag, tests        |
| 2   | **Pure core**       | `model` / `query` / `filter` / `depth` / `settings` with full unit coverage — no UI change yet                        |
| 3   | **Worker layout**   | `d3-force` in a worker behind the transferable-positions protocol, driving the _existing_ renderer                    |
| 4   | **Pixi renderer**   | sprite nodes, batched links, pooled labels, quadtree hover, d3-zoom + keyboard camera; `react-force-graph-2d` removed |
| 5   | **Settings chrome** | Filters / Groups / Display / Forces panel, persistence, restore defaults                                              |
| 6   | **Local graph**     | depth slider, rooted view beside the note                                                                             |
| 7   | **Time-lapse**      | Animate transport                                                                                                     |
| 8   | **Hardening**       | WebGL fallback, perf budget, e2e, accessibility pass, `docs/` + README update                                         |

Phases 1–2 are pure and reviewable without a browser. Phase 4 is the only visually disruptive one.
