# Tephra Stage 1 Progress

Source of truth: `.agents/plans/TEPHRA_STAGE1_PLAN.md`.

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
- [x] Docker single-container deployment (Dockerfile + Compose; image build
  still needs a daemon smoke test)

## Follow-ups

- [ ] Build and smoke-test the Docker image where a daemon is available
- [ ] Add concurrent-commit and larger-vault indexing performance coverage
- [ ] Re-run `npm audit` periodically; currently 0 vulnerabilities
