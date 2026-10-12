# 019 — Modularity and cleanup pass

## Scope

Behavior-preserving refactor across the repo, split by area (one owner per area, disjoint files):

1. `tephra-server/apps/api` — split large route/service files into focused modules.
2. `tephra-server/apps/web` — split large components/hooks; remove unused components.
3. `tephra-server/packages/graph-renderer` — simplify engine modules, remove dead code/tests. (Has uncommitted work in `engine/renderer.ts`, its test, and `GraphView.tsx`; preserve it.)
4. `tephra-server/packages/{database,blob-store,indexer,auth,core,test-fixtures}` — infrastructure packages.
5. `tephra-server/packages/{protocol,markdown,markdown-editor,link-resolver,vault-model}` — shared browser-safe packages.
6. `tephra-plugin` — split large plugin modules, remove unused code.

## Non-goals

- No behavior, wire-protocol, or DB schema changes.
- No new features or dependencies.
- No weakening of security invariants (SHA-256 blob verification, revisioned commits, no third-party plugin execution).
- Do not delete tests covering security invariants or public behavior; only tests for removed code or fully redundant tests.

## Affected packages / consequences

Internal module moves only. Public exports of packages stay stable unless the export is unused repo-wide (verify with grep before removing). No migration or API consequences.

## Verification

Per area: workspace typecheck + tests. Final: `npm run check` from the repo root.

## Rollout risks

Import path breakage across packages (mitigated by keeping package entrypoint exports); accidental removal of reflection/dynamic usage (grep before deleting).
