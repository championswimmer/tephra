# Tephra Agent Guide

## Source of truth

- Implement according to `.agents/plans/001-TEPHRA_STAGE1_PLAN.md` and any open plan in `.agents/plans/`.
- Never add third-party Obsidian plugin execution.
- Keep original file bytes canonical, blobs immutable and SHA-256 verified, and successful vault commits revisioned.

## Planning requirement

**Large features and refactors must be planned before implementation.** Use the project `planning` skill. Store every implementation plan under `.agents/plans/` as a numbered file (`NNN-SLUG.md`); do not put plans in ad-hoc root files or external scratch locations.

A plan must state scope, non-goals, affected packages, migration/API consequences, verification, and rollout risks. Existing approved plans may be reused when they cover the requested work.

## Repository rules

- Server: Go, in `tephra-server/go` (module `github.com/championswimmer/tephra/tephra-server/go`). Never run plain `go get` / `go mod tidy`; `go.mod` pins exact versions.
- Web app and plugin: strict TypeScript, managed as npm workspaces (`tephra-server/apps/web`, `tephra-server/packages/*`, `tephra-plugin`).
- Run `npm run check` (TypeScript lint, typecheck, build, tests) and `npm run go:check` (gofmt, vet, `go test -race`) before reporting implementation complete; run both when a change touches the API contract or shared packages.
- Add tests with behavior changes; security invariants require regression tests.
- The shared TypeScript packages (`protocol`, `graph-renderer`, `markdown-editor`) must remain browser-safe; the plugin must not use Node-only APIs.
- Server infrastructure is accessed through interfaces; do not bypass the database/blob-store abstractions in `tephra-server/go/internal`.
- Do not log tokens, passwords, cookies, or vault contents.

## Products

- `tephra-server`: Go HTTP API (`tephra-server/go`), React/Vite web app (`tephra-server/apps/web`), shared TypeScript packages, SQLite and filesystem persistence, deployment assets. The Go server serves the built web app.
- `tephra-plugin`: mobile-compatible Obsidian plugin using Obsidian APIs and Web Crypto only.

## Documentation and progress

- Update `PROGRESS.md` only for work that exists and has been verified.
- Keep public setup commands and environment variables current in README files.
