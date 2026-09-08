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

## Note identity modes and path-addressed URLs (plan 010)

Implemented and verified by `npm run check` (lint + typecheck + build +
workspace tests, all green) plus new unit/integration coverage and a
passing Playwright rename-redirect flow.

- [x] Composite `(vault_id, file_id)` primary key for `vault_files`
      (vault-scoped `findById`/`delete`); cross-vault id steal fixed with
      regression tests
- [x] `path_fold` lookup column + `file_versions(vault_id, path,
      revision)` index, edited into `001_initial.sql` in place (no
      migration; pre-launch posture)
- [x] `GET /api/v1/vaults/:vaultId/resolve?path=…` with
      exact → normalized → case (unique match, else 409) → historic →
      404/410 precedence; note paths travel in the query string only and
      never enter the access log
- [x] Web app hash-routed path URLs (`/#/path/to/note.md`), canonical
      rewriting, and a "moved from" hint; single resolve per navigation,
      then existing `fileId` endpoints
- [x] NFC enforced at the protocol edge (`400 INVALID_PATH`), normalized
      in the plugin scanner, with a link-resolver regression test
- [x] Identity core: path-seeded `mintFileId` (+ random fallback),
      pure matcher (hints → path → frontmatter → hash → mint), sidecar
      store at `.tephra/data.json` (atomic write, `.bak` recovery,
      deterministic serialization)
- [x] Mode-driven scanner (frontmatter / sidecar / path); modes B and C
      provably never write to a note
- [x] Repair triggers (missing/corrupt/foreign sidecar, revision drift,
      `DUPLICATE_*` self-heal, manual repair), churn guard
      (`max(25, 2% of files)` + allow-once), durable `pendingRenames`,
      `EventBuffer` rename-chain fix, offline cold-start rule
- [x] Three-mode settings section with per-mode help, dry-run migration
      modal both directions, repair button, and destructive
      Remove-Tephra-IDs sweep with preview and confirmation
- [x] Id-churn safety: blob GC, revision diff, and concurrent-commit
      convergence coverage
