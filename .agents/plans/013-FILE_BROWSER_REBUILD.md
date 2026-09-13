# 013 — File browser rebuild (toggleable sidebars, FileBrowser component, file-type icons)

## Context and user outcome

The vault workspace (`VaultWorkspace.tsx`) renders a left file tree
(`FileTree.tsx`: search + tree in one component, generic `File`/`FileText`
icons, per-folder `useState` with no memoization) and a right relationships
panel (`LinksPanel`). There is no way to hide either sidebar on desktop; the
mobile drawer is the only collapse mechanism.

Outcome: left/right sidebars are toggleable, the file browser lives in its
own memoized component, and files/folders use proper Lucide file-type icons.

## Scope

- `FileIcon.tsx` (new): maps `VaultFile` (kind, mimeType, extension) to a
  Lucide icon — markdown `FileText`, image `FileImage`, video `FileVideo`,
  audio `FileAudio`/`FileMusic`, PDF `FileType`, code `FileCode`,
  archive `FileArchive`, fallback `File`. Decorative
  (`aria-hidden="true" focusable="false" className="icon"`).
- `FileTree.tsx` (refactor): pure presentational tree. Extract memoized
  `FileRow` and `FolderRow` (`React.memo`); stable `onSelect` via props;
  folder open-state stays local per folder. Keeps the existing
  `{ files, selectedPath, onSelect }` props (plus optional
  `forceOpen`/`searchQuery` passthrough) so `file-tree.test.tsx` and
  `icons.test.tsx` keep passing.
- `FileBrowser.tsx` (new): owns the search query state, `useMemo`s
  `buildTree`/`filterTree`, renders the search field + `FileTree` + empty
  state. Wrapped in `React.memo`.
- `VaultWorkspace.tsx`: uses `FileBrowser`; adds desktop sidebar toggles —
  `leftOpen`/`rightOpen` booleans persisted to `localStorage`
  (`tephra:sidebar-left` / `tephra:sidebar-right`), header toggle buttons
  with `PanelLeftClose`/`PanelLeftOpen` + `PanelRightClose`/`PanelRightOpen`
  icons, `aria-expanded`/`aria-controls`. Grid gets
  `hide-left`/`hide-right` modifiers; sidebars render conditionally
  (`hidden` + CSS class). Mobile drawer (`treeOpen`) behavior unchanged.
- `styles.css`: collapsed-grid variants, `.sidebar-toggle` button style,
  `.tree-file .icon` per-kind subtle coloring (single `currentColor`-based
  rule set, theme-agnostic), folder-row icon spacing.

## Non-goals

- No virtualization (react-window) — vaults are hundreds, not tens of
  thousands, of files; memoization suffices.
- No web-to-vault writes, no API/protocol/DB changes; read-only posture
  unchanged.
- No new icon dependency — Lucide (`lucide-react`, ISC) is already the
  standard pack per plan 012.
- No `tephra-plugin` changes.

## Invariants and security constraints

- Icons decorative: `aria-hidden="true"`, `focusable="false"`; accessible
  names (file/folder button text, searchbox name) unchanged.
- No new network requests; icons ship in the Vite bundle.
- No tokens, passwords, or vault contents in code or logs.
- Browser-safe: no Node APIs in components.

## Affected files/packages

- New: `tephra-server/apps/web/src/components/FileIcon.tsx`,
  `tephra-server/apps/web/src/components/FileBrowser.tsx`.
- Edit: `FileTree.tsx`, `routes/VaultWorkspace.tsx`, `styles.css`.
- Tests: extend `tests/file-tree.test.tsx` (memo/toggle not needed —
  behavior tests stay green); update `tests/icons.test.tsx` count comment
  if icon count changes; add `tests/file-icon.test.tsx` for the
  extension/mime mapping.

## Ordered implementation steps

1. Add `FileIcon.tsx` with `fileIconName()` pure mapper + memoized component.
2. Refactor `FileTree.tsx` into memoized rows; keep props compatible.
3. Add `FileBrowser.tsx` (search state + memo + empty state).
4. Wire `VaultWorkspace.tsx` toggles + persistence + conditional sidebars.
5. Update `styles.css` (grid modifiers, toggle buttons).
6. Add/adjust tests; run `npm run typecheck --workspace=@tephra/web`,
   `vitest run` for web, `npm run check` scope per AGENTS.md.

## API/schema/migration changes

None. LocalStorage keys are new client-only UI prefs; no migration.

## Tests and verification

- `tests/file-icon.test.tsx`: mime/extension → icon mapping unit tests.
- Existing `file-tree.test.tsx` + `icons.test.tsx` stay green.
- `npm run check` green; manual dev-server check: toggle left/right on
  desktop, drawer on mobile, light + dark themes.

## Compatibility, deployment, and rollback risks

- Named Lucide imports only; bundle delta negligible (icons already
  bundled).
- Rollback: revert the 5 files; no data migration involved.
