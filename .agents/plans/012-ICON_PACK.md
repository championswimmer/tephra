# 012 — Web icon pack (Lucide)

## Context and user outcome

The web frontend (`tephra-server/apps/web`) currently uses unicode glyphs as
icons: `⚙`/`☰`/`⌕`/`✕`/`×`/`▧`/`◫`/`▾`/`▸`/`◇`, plus a CSS `content: "▾"`
chevron for callouts. These render inconsistently across platforms (emoji
fallback, missing glyphs, misaligned baselines).

Outcome: all UI chrome icons come from one free/open-source icon pack with a
consistent stroke style, sizing, and accessibility treatment. **Lucide** is
the choice: ISC-licensed, actively maintained, Feather-successor, first-class
`lucide-react` bindings, tree-shakable, and its 24px stroke style already
matches the hand-rolled callout SVGs in `@tephra/markdown`.

## Scope

- Add `lucide-react` dependency to `@tephra/web`.
- Add shared icon CSS (`.icon`, `.icon-button` alignment) in `styles.css`.
- Replace every unicode-glyph icon in web UI chrome with Lucide components:
  - `AppShell.tsx`: topbar Settings button (`⚙`) → `Settings`.
  - `GraphView.tsx`: graph settings toggle (`⚙`) → `SlidersHorizontal`
    (distinct from site Settings), keeps `aria-label="Graph settings"`.
  - `SettingsModal.tsx`: close (`✕`) → `X`.
  - `GraphSettingsPanel.tsx`: remove-group (`×`) → `X`; add `Plus` (Add
    group) and `RotateCcw` (Restore defaults).
  - `FileTree.tsx`: search (`⌕`) → `Search`; markdown (`▧`) → `FileText`;
    attachment (`◫`) → `File`; folder chevrons (`▾`/`▸`) → `ChevronDown` /
    `ChevronRight`.
  - `VaultListPage.tsx`: vault (`◇`) → `Archive`.
  - `VaultWorkspace.tsx`: mobile files button (`☰`) → `Menu`; vault-views
    nav gains `Waypoints` (Graph) and `KeyRound` (Tokens).
  - `NoteViewer.tsx`: raw/rendered toggle gains `Code` / `Eye`.
  - `AttachmentViewer.tsx`: download link gains `Download`.
  - `TokenManager.tsx`: copy gains `Copy`; created-token notice gains
    `TriangleAlert`.
  - `ThemeSelector.tsx`: options gain `Sun` / `Moon` / `Monitor`.
  - `LinksPanel.tsx`: section headers gain `Link2` / `ArrowLeftRight`.
  - `Status.tsx`: `ErrorState` gains `TriangleAlert`.
  - `styles.css`: callout `summary::after` triangle glyph → Lucide
    `chevron-down` inline-SVG data URI (no glyph dependency).
- Add `tests/icons.test.tsx`: asserts the icon-bearing components render
  `svg.lucide[aria-hidden="true"]` and the correct accessible names survive.

## Non-goals

- No change to `@tephra/markdown` callout SVG paths (already Lucide-style
  stroke icons; swapping exact path data is churn with snapshot risk).
- No icon support in `tephra-plugin` (Obsidian has its own `setIcon` API;
  separate concern).
- No new shared `@tephra/icons` workspace package — direct `lucide-react`
  imports in the web app preserve tree-shaking with zero indirection.
- No brand/logo redesign; the `T` auth mark stays CSS.
- No web-to-vault writes; read-only posture unchanged.

## Invariants and security constraints

- Icons are decorative: every Lucide component gets `aria-hidden="true"`
  (plus `focusable="false"`); buttons keep text or `aria-label` so
  accessible names are unchanged (existing role/name queries keep passing).
- No new network requests, no webfonts, no external CDN — icons ship in the
  Vite bundle.
- No tokens, passwords, or vault contents in code or logs.
- Stage 1 read-only posture unchanged.

## Affected files/packages

- `tephra-server/apps/web/package.json` (+ lockfile): add `lucide-react`.
- `tephra-server/apps/web/src/styles.css`: `.icon` / `.icon-button` rules,
  callout chevron data URI.
- Components listed in Scope (all under
  `tephra-server/apps/web/src/components/`, `src/routes/`).
- New: `tephra-server/apps/web/tests/icons.test.tsx`.

## Ordered implementation steps

1. `npm install lucide-react --workspace=@tephra/web`; confirm version,
   ISC license, React 19 peer compatibility.
2. Add `.icon` CSS (1em sizing, `flex: none`, `vertical-align`) and
   `.icon-button` inline-flex alignment; replace callout `content: "▾"`
   with chevron-down data URI.
3. Swap components one file at a time (list in Scope), each with
   `size={…} aria-hidden="true" focusable="false" className="icon"`.
4. Add `tests/icons.test.tsx`.
5. Grep for remnants (`⚙|✕|⌕|▧|◫|▾|▸|◇|☰`, `content: "▾"`).
6. Run `npm run check` (lint + typecheck + build + workspace tests) and the
   Playwright web-e2e graph/vault flows if available.

## API/schema/migration changes

None. No API, protocol, DB, or config changes. Pure frontend presentational
change; accessible names preserved.

## Tests and verification

- New `tests/icons.test.tsx` (vitest + jsdom): renders AppShell-adjacent
  units (FileTree, GraphView toggle, SettingsModal, ThemeSelector,
  Status) and asserts `svg.lucide` with `aria-hidden="true"`.
- Existing suites must stay green: `file-tree.test.tsx` (searchbox name),
  `graph-view.test.tsx` / `local-graph.test.tsx` (`Graph settings` name),
  `graph-settings-panel.test.tsx`, plus full `npm run check`.
- Manual: `npm run dev --workspace=@tephra/web` (or dev-server skill),
  visually confirm topbar, tree, vault grid, graph toggle, modal, theme
  options in light + dark.

## Compatibility, deployment, and rollback risks

- Bundle size: `lucide-react` adds ~50–150 KB pre-tree-shake; named
  per-icon imports keep the delta small. Verify Vite build chunk sizes do
  not explode.
- React 19 + Vite 7 compat: `lucide-react@1.x` supports React 19; if peer
  warnings appear, pin a compatible minor.
- Rollback: revert the single dependency + component diffs; no data
  migration involved.
- No deployment config changes; Docker/CI unaffected beyond `npm ci`
  picking up the lockfile entry.

## Completion checklist

- [ ] `lucide-react` in `@tephra/web` deps + lockfile
- [ ] All unicode-glyph icons replaced; grep for remnants is clean
- [ ] `.icon` styling + callout chevron data URI in `styles.css`
- [ ] `tests/icons.test.tsx` added and passing
- [ ] `npm run check` green
- [ ] Light + dark visual check
