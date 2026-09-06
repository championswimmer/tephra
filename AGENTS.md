# Tephra Agent Guide

## Source of truth

- Implement Stage 1 according to `.agents/plans/TEPHRA_STAGE1_PLAN.md`.
- Stage 1 is a read-only web mirror. Never add web-to-vault writes, merging, or third-party Obsidian plugin execution.
- Keep original file bytes canonical, blobs immutable and SHA-256 verified, and successful vault commits revisioned.

## Planning requirement

**Large features and refactors must be planned before implementation.** Use the project `planning` skill. Store every implementation plan under `.agents/plans/`; do not put plans in ad-hoc root files or external scratch locations.

A plan must state scope, non-goals, affected packages, migration/API consequences, verification, and rollout risks. Existing approved plans may be reused when they cover the requested work.

## Repository rules

- Package manager: npm workspaces. The Stage 1 plan's pnpm recommendation is intentionally overridden by repository policy.
- Language: strict TypeScript.
- Run `npm run check` before reporting implementation complete.
- Add tests with behavior changes; security invariants require regression tests.
- Shared packages (`protocol`, Markdown, link resolution, vault model) must remain browser-safe.
- Node-only APIs belong in Node adapters and entrypoints.
- Infrastructure is accessed through interfaces; do not bypass database/blob-store abstractions.
- Do not log tokens, passwords, cookies, or vault contents.

## Products

- `tephra-server`: Hono API, React/Vite web app, shared packages, persistence, deployment assets.
- `tephra-plugin`: mobile-compatible Obsidian plugin using Obsidian APIs and Web Crypto only.

## Documentation and progress

- Update `PROGRESS.md` only for work that exists and has been verified.
- Keep public setup commands and environment variables current in README files.
