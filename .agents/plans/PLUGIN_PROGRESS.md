# Tephra Sync Plugin Progress

## Scope and status

The Stage 1 mobile-compatible Obsidian upload plugin is implemented in `tephra-plugin/`. It is one-way only: server content is never applied to the local vault.

## Completed files

### Plugin metadata and documentation

- `tephra-plugin/manifest.json` — community plugin metadata (`tephra-sync`, mobile-compatible).
- `tephra-plugin/versions.json` — plugin-to-Obsidian version mapping.
- `tephra-plugin/package.json` — build, typecheck, and Vitest scripts plus Obsidian/esbuild dependencies.
- `tephra-plugin/README.md` — installation, configuration, privacy, identity, and failure behavior.
- `tephra-plugin/LICENSE` — AGPL-3.0-or-later notice.

### Runtime source

- `src/main.ts` — plugin lifecycle, layout-ready startup, vault event registration, periodic reconciliation, command, notices, and status bar.
- `src/settings.ts`, `src/state/plugin-state.ts` — defaults, persisted settings/secrets, manifest, attachment identity map, revision, and migration-tolerant state loading.
- `src/ui/settings-tab.ts`, `src/ui/status.ts` — password-masked token field, all requested settings, manual sync, and status display.
- `src/auth/token.ts` — token masking helper.
- `src/api/client.ts` — `requestUrl`-only plan/upload/commit client with response schema validation and auth/network errors.
- `src/sync/hasher.ts`, `src/sync/manifest.ts` — Web Crypto SHA-256, protocol canonical JSON, and code-point path sorting.
- `src/sync/scanner.ts` — Obsidian Vault API enumeration/reads, hidden/temp exclusions, Markdown frontmatter IDs, deterministic persisted attachment path IDs, hash reuse, and complete manifest generation.
- `src/sync/event-buffer.ts` — debounce, maximum delay, event coalescing, and rename-intent preservation.
- `src/sync/reconciliation.ts`, `src/sync/coordinator.ts` — serialized full reconciliation, rename continuity, missing-only uploads, bounded concurrency, retry/backoff, commit-after-upload, and successful-state persistence.
- `src/sync/uploader.ts` — de-duplicated missing blob uploads with bounded workers and exponential retry delay.

### Tests authored

- `tests/path-and-id.test.ts` — exclusions, frontmatter-only Markdown IDs, and deterministic attachment mappings.
- `tests/event-buffer.test.ts` — modify coalescing, rename preservation, debounce, and maximum delay.
- `tests/hash.test.ts` — SHA-256 vectors and canonical manifest ordering.
- `tests/uploader.test.ts` — missing-only upload and exponential retry behavior.
- `tests/coordinator.test.ts` — attachment rename continuity and no commit/state advancement after failed upload.
- `tests/reconciliation.test.ts` — serialized execution and follow-up reconciliation while active.

## Features completed

- Mobile/browser-safe runtime: no Node filesystem, path, crypto, Electron, or other Node runtime APIs.
- All vault enumeration and content reads use Obsidian APIs.
- All HTTP uses Obsidian `requestUrl`.
- Persisted server URL, vault ID, upload token, device ID/name, debounce, and concurrency.
- Upload token is stored in plugin data and rendered with a password input.
- Markdown identity uses the `tephra-file-id` frontmatter property; plugin-generated modify events are suppressed to avoid loops.
- Attachments use a deterministic path-derived ID plus a persisted path-to-ID mapping; Obsidian rename events move the mapping.
- Hidden paths, `.obsidian`, malformed paths, and common editor/temporary files are excluded.
- Startup, event-driven, manual, settings-triggered, and ten-minute full reconciliation.
- Complete sorted manifests and canonical hashes compatible with `@tephra/protocol`.
- Plan, missing-only upload, and commit sequence; commit is skipped if already current and is never attempted after a failed upload.
- Bounded upload concurrency and three upload attempts with exponential backoff.
- Last successful manifest, timestamp, and remote revision are persisted only after successful completion.
- Offline/auth failures retain local data and successful-sync state for later reconciliation.

## Tests and checks actually run

- `prettier --check tephra-plugin` — **passed** (`All matched files use Prettier code style!`).
- `git diff --check` — **passed**.
- Node-import/API grep across plugin TypeScript — **passed**, with no prohibited imports found.
- `npm run typecheck --workspace=@tephra/plugin` — **attempted but did not run successfully** because workspace dependencies are not installed in the isolated worktree. Reported unresolved modules included `obsidian`, `vitest`, and protocol dependency `zod`; resulting cascading type errors are not a valid source-level verification result.
- Vitest suite — **not run**, because dependencies are not installed and `npm install` was explicitly prohibited for this task.
- Plugin bundle/build — **not run**, for the same dependency constraint.
- Obsidian desktop/mobile manual test — **not run**.

## Protocol assumptions

- Browser-safe types and canonicalization are imported from `@tephra/protocol`.
- `canonicalManifestJson()` is the source of truth for manifest serialization before Web Crypto SHA-256.
- Entries use protocol fields `fileId`, `path`, `hash`, `size`, `mtime`, optional `mimeType`, and `kind`, sorted by Unicode code point path order.
- Plan endpoint: `POST /api/v1/vaults/{vaultId}/sync/plan`.
- Blob endpoint: `PUT /api/v1/vaults/{vaultId}/blobs/{sha256}` with `X-Tephra-Blob-Size`.
- Commit endpoint: `POST /api/v1/vaults/{vaultId}/sync/commit`.
- Authentication is `Authorization: Bearer <vault-scoped-upload-token>`.
- Plan and commit bodies are identical and contain `deviceId`, `manifestHash`, and the complete manifest.
- A plan response with `status: up-to-date` requires no commit; `upload-required` is committed only after every missing blob succeeds.
- The server independently validates paths, hashes, sizes, authorization, and complete-manifest commit atomicity.

## Known gaps and integration risks

1. Dependencies were not installed, so TypeScript, Vitest, and esbuild have not provided executable verification.
2. `minAppVersion: 1.5.0` is provisional and has not been confirmed by desktop/mobile testing, particularly for `processFrontMatter`, `requestUrl` options, and binary reads.
3. Markdown identity insertion intentionally modifies local frontmatter. It suppresses the expected modify event, but behavior should be tested against multiple Obsidian versions and metadata-cache timing.
4. A copied note with a duplicate `tephra-file-id` is reassigned during scanning; this path needs real-vault validation.
5. Web Crypto hashes whole files in memory, which may create memory pressure for unusually large mobile attachments.
6. Upload retries cover blob uploads only. Plan and commit recover through later full reconciliation rather than immediate in-call retries.
7. There is no explicit online/offline platform event hook; recovery occurs on the next vault event, manual sync, settings sync, startup, or periodic reconciliation.
8. Device name is persisted for future server/device UX but is not part of the current Stage 1 sync request schema.
9. Settings changes recreate the event buffer, so currently buffered hints are discarded; the ensuing settings-triggered full reconciliation repairs state.
10. Build ordering assumes `@tephra/protocol` is available/built in the npm workspace before bundling the plugin.
11. No live Tephra Server integration or authentication-error response fixture has been exercised.
12. No release artifact validation has confirmed that `main.js`, `manifest.json`, and `versions.json` load as a community plugin.

## Exact next steps

1. From the repository root, install the declared workspace dependencies using the repository-standard npm workflow, allowing `package-lock.json` changes only in the integration branch where permitted.
2. Run `npm run typecheck --workspace=@tephra/plugin`; fix only genuine errors remaining after dependency resolution.
3. Run `npm run test --workspace=@tephra/plugin` and confirm every authored test passes.
4. Run `npm run build --workspace=@tephra/protocol`, then `npm run build --workspace=@tephra/plugin`; inspect the generated bundle for accidental Node built-ins.
5. Run the repository-required `npm run check` and resolve plugin-owned failures without changing unrelated packages.
6. Start a Tephra Server fixture and exercise plan → missing blob upload → commit, up-to-date no-op, 401/403, unreachable server, 5xx, and failed-blob cases.
7. Install the generated plugin artifacts into a disposable desktop Obsidian vault and verify initial scan, note modification, create, delete, attachment upload, Markdown rename, attachment rename, duplicate frontmatter ID handling, restart persistence, and manual sync.
8. Repeat core flows on Android and iOS Obsidian; measure large attachment memory behavior and establish the actual oldest supported Obsidian version.
9. Confirm frontmatter writes produce exactly one expected reconciliation cycle and never continuously rewrite notes.
10. Validate a committed manifest hash against a server-side `@tephra/protocol` calculation using Unicode paths and optional MIME fields.
11. Update `minAppVersion` and `versions.json` to the oldest version actually validated.
12. Prepare release artifacts and perform a final token/log inspection before publishing.
