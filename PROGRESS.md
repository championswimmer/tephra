# Tephra Stage 1 Progress

Source of truth: `.agents/plans/001-TEPHRA_STAGE1_PLAN.md`.

## Phase 0 — Repository scaffolding

- [x] Root npm workspace and strict TypeScript policy
- [x] ESLint and Prettier configuration
- [x] Project agent guide and planning skill
- [x] Package manifests and source scaffolding
- [x] CI (npm workflow with lint, typecheck, test, build)
- [x] Clean install, lint, test, and build

## Initial vertical slice

All items below are implemented and verified by `npm run check` plus a
live end-to-end run (bootstrap, login, vault, token, plan, blob upload,
commit, idempotent recommit, files, rendered note, links, graph).

- [x] Persistent SQLite server and filesystem blob store
- [x] Bootstrap/login, vault, and upload-token APIs
- [x] Manifest plan/upload/commit protocol with revisions
- [x] Markdown parsing, safe rendering, links, and graph
- [x] Read-only React vault browser
- [x] One-way Obsidian plugin reconciliation
- [x] Docker single-container deployment (Dockerfile + Compose; CI now
      builds the image and smoke-tests `/healthz` + `/readyz` in
      `docker-build`, `web-e2e` runs the Playwright vault flow)

## Follow-ups (all closed)

- [x] Concurrent-commit and larger-vault indexing performance coverage
      (`sync-concurrency-perf.test.ts`: N concurrent commits serialize to
      revisions 1..N; ~500 cross-linked notes index and serve the graph in
      ~3s)
- [x] Compatibility fixture vault expanded to the full plan §31 case list
      (Folders, Duplicate A/B basenames, Links, Markdown, Unicode,
      Attachments, code-block traps) with a deterministic
      metadata/links/graph test (`compat-vault.test.ts`, 9 tests)
- [x] Observability: `X-Request-Id` + one structured JSON log line per
      request with sync fields (no tokens/content)
- [x] Protocol versioning: `X-Tephra-Plugin-Version` /
      `X-Tephra-Protocol-Version` headers, `protocolVersion` +
      `minimumPluginVersion` in plan/commit responses
- [x] Blob GC: 7-day unreferenced-blob collector + test + README note
- [x] Playwright e2e (`test:e2e`): bootstrap → login → seed → files →
      wikilink → graph → node navigation, passing locally and in CI
- [x] Migration policy + compatibility matrix documented in
      `tephra-server/README.md`
- [ ] Re-run `npm audit` periodically; currently 0 vulnerabilities

## Sample vault and e2e sync

- [x] `sample-vault/` demo vault (16 notes, daily notes, MOCs, duplicate
      basenames, unresolved/encoded/heading/block links, attachments)
- [x] `e2e/sync-vault.mjs` (`npm run sync:vault`) pushes any vault directory
      via plan/upload/commit and verifies every note renders
- [x] Sample vault synced to a local server and visually verified (file
      tree, rendered Home note with resolved links, graph with 16 nodes and
      76 edges)
- [x] Graph view rebuilt on `react-force-graph-2d` 1.29.1 (MIT, force
      layout, zoom/pan/drag, click-to-open, keyboard fallback list); canvas
      sized to its card via ResizeObserver with a jsdom-safe guard
