# 025 — Obsidian Sync Frequency

## Context and user outcome

Add a per-vault setting for vaults backed by the official Obsidian headless client so users can choose:

- `continuous` — the existing/default `obsidian sync --continuous` behavior;
- `6h` — one-shot sync every 6 hours;
- `1h` — one-shot sync every hour;
- `30m` — one-shot sync every 30 minutes;
- `10m` — one-shot sync every 10 minutes.

The setting is exposed in the existing web vault settings panel. Periodic modes use the existing `Client.Sync(ctx, paths, false)` operation followed by the existing checkout import; the CLI needs no new flag. Existing vaults and clients retain continuous behavior.

## Scope

- Add a validated frequency field to the Obsidian sync model, SQLite persistence, full settings API response, and web API types.
- Extend `PUT /api/v1/vaults/{vaultId}/obsidian-sync` into a strict partial update accepting `enabled` and/or `frequency`.
- Add a cancellable, non-overlapping periodic scheduler to `NativeSyncService` while preserving the continuous path.
- Restart an enabled vault's worker when its frequency changes; persist only when the vault is paused.
- Add a sync-frequency select to `ObsidianVaultSyncPanel` and cover it with component tests.
- Update the server README and, after verification, `PROGRESS.md`.

## Non-goals

- Do not change `tephra-plugin` direct sync, its reconciliation timer, or plugin settings.
- Do not add an unsupported CLI frequency option or run continuous and periodic CLI processes together.
- Do not expose frequency in vault list/summary DTOs; the existing full Obsidian settings endpoint is canonical.
- Do not add environment configuration, distributed scheduling, catch-up bursts, or overlapping sync passes.
- Do not cut a plugin/server release or change version manifests.

## Invariants and security constraints

- Original file bytes remain canonical; every periodic sync imports through `importLocked` and the existing database/blob abstractions.
- Preserve the existing preflight safety checks before every one-shot sync so a missing/empty checkout cannot be interpreted as deletions.
- `continuous` remains the default for new settings, old rows, missing values, and defensive fallback.
- Existing `PUT {"enabled":boolean}` requests keep their pause/resume/retry behavior and preserve the stored frequency.
- Only vault owners with the existing session/CSRF checks can mutate the setting; retain current body-validation/error precedence and strict unknown-key rejection.
- No tokens, passwords, cookies, or vault contents may be logged.
- Periodic waits and subprocesses must use the worker context so pause, removal, frequency changes, and shutdown cancel promptly.
- At most one worker and one official sync operation run per vault. Periodic ticks wait until the prior pass completes and then wait a full interval.

## API and schema contract

### Settings and update types

Add `ObsidianSyncFrequency` with exactly `continuous`, `6h`, `1h`, `30m`, `10m` and constants `FrequencyContinuous`, `Frequency6Hours`, `Frequency1Hour`, `Frequency30Minutes`, `Frequency10Minutes`; add `Frequency ObsidianSyncFrequency `json:"frequency"`` to `ObsidianSyncSettings`. Add `Valid()` and `ObsidianSyncSettings.EffectiveFrequency()` helpers in the model package (invalid/empty effective values fall back to continuous). `httpx.InitialObsidianSettings` sets `continuous`.

Add `httpx.ObsidianSettingsUpdate` with optional `Enabled *bool` and `Frequency *vm.ObsidianSyncFrequency`. Extend `ObsidianSyncService` with `UpdateSettings`; keep `Enable` as a compatibility wrapper for existing callers.

The existing PUT accepts:

```json
{"enabled": false}
{"frequency": "10m"}
{"enabled": true, "frequency": "6h"}
```

Rules:

- omitted fields remain unchanged;
- `{}`, unknown keys, wrong types, nulls, and unsupported frequencies return HTTP 400 without mutation;
- frequency-only updates while paused preserve enabled/phase/error/sync timestamps and do not launch a worker;
- frequency-only updates while enabled stop and relaunch the worker and set the normal restarting/initial-sync state;
- explicit enable/disable retains current phase/error semantics;
- response remains `{ "settings": ObsidianSyncSettings }`.

### SQLite migration

Add migration 8, `008_obsidian_sync_frequency.sql`:

```sql
ALTER TABLE obsidian_sync ADD COLUMN frequency TEXT NOT NULL DEFAULT 'continuous'
  CHECK (frequency IN ('continuous', '6h', '1h', '30m', '10m'));
```

Register it after migration 7 and update schema-version comments/assertions. Add the column to selects, scans, and upserts. Normalize the Go zero value to `continuous` before persistence in both SQLite and the in-memory test adapter. Keep the existing v7 fixture database unchanged so compatibility tests prove old rows migrate to `continuous`; update its expected JSON.

## Affected files and parallel ownership

### Agent A — model, persistence, and HTTP API

Own only:

- `tephra-server/go/internal/vaultmodel/entities.go` and focused model tests if useful;
- `tephra-server/go/internal/httpx/types.go`;
- `tephra-server/go/internal/obsidian/routes.go` and `api_test.go`;
- `tephra-server/go/internal/db/sqlite/{migrate.go,rows.go,repos.go,sqlite.go,sqlite_test.go,compat_test.go}`;
- `tephra-server/go/internal/db/sqlite/migrations/008_obsidian_sync_frequency.sql`;
- `tephra-server/go/internal/db/sqlite/testdata/fixture.expected.json`;
- `tephra-server/go/internal/testutil/{memdb.go,memdb_test.go}` as needed.

Do not edit `service.go`, service tests, web files, docs, or this plan.

### Agent B — native service scheduling

Own only:

- `tephra-server/go/internal/obsidian/service.go`;
- `tephra-server/go/internal/obsidian/helpers_test.go`;
- `tephra-server/go/internal/obsidian/service_test.go`.

Implement against Agent A's contract without editing Agent A's files. Add `Options.FrequencyInterval func(vm.ObsidianSyncFrequency) time.Duration` as a test timing seam and an `Options.frequencyInterval` helper; production mapping is fixed to the four requested durations and continuous. Do not edit `cli.go`, web files, docs, or this plan.

### Agent C — web UI

Own only:

- `tephra-server/apps/web/src/api/types.ts`;
- `tephra-server/apps/web/src/api/client.ts`;
- `tephra-server/apps/web/src/components/ObsidianVaultSyncPanel.tsx`;
- `tephra-server/apps/web/tests/obsidian-settings.test.tsx`;
- scoped web styles only if existing classes are insufficient.

Use JSON/TypeScript field name `frequency`. Add `obsidianUpdateSettings(vaultId, {enabled?, frequency?})`; retain `obsidianEnable` as a wrapper. Render the select only for a connected remote vault, with labels Continuous, Every 6 hours, Every hour, Every 30 minutes, Every 10 minutes. Place it outside the status live region. Save frequency-only partial updates, disable controls while busy, use the existing action/error handling, and apply the returned settings. Existing poll mutation/version guards must prevent stale polls from overwriting an in-flight update; avoid adding redundant local frequency state unless required by tests.

Do not edit Go files, docs, or this plan.

### Orchestrator — integration and documentation

- Resolve only cross-agent integration issues.
- Delegate final documentation updates after behavior is verified.
- Run focused and full verification; review the complete diff and working tree.

## Ordered implementation

1. Agents A, B, and C implement their non-overlapping areas in parallel against this contract.
2. Integrate and run focused Go model/SQLite/API/service tests and web component tests; fix compile/test failures.
3. Confirm service behavior:
   - initial boot/setup still performs an immediate one-shot sync/import;
   - continuous then follows the unchanged long-lived `Sync(true)` path;
   - periodic mode waits, re-reads status, runs preflight, `Sync(false)`, locked import, and `LastSyncedAt` update;
   - cancellation during a wait or one-shot does not create a sync-error phase;
   - periodic errors return to the existing supervisor for error state and exponential retry;
   - frequency changes while enabled patch, stop/wait, re-patch, then relaunch so stale workers cannot resurrect state;
   - pause, boot, write-note, remove, and close semantics remain intact.
4. Run race-enabled focused Go tests and the required full checks.
5. Update `tephra-server/README.md` with the choices, continuous default, restart-on-change behavior, and one-shot periodic semantics. Add a verified `PROGRESS.md` entry only after checks pass.

## Tests and verification

Add regression coverage for:

- all five values, invalid values/types/keys, empty body, and 400-before-503 behavior;
- default continuous responses and legacy enable-only requests preserving frequency;
- frequency update while paused and while enabled, including switching back to continuous;
- repeated periodic one-shot calls/imports, no continuous child in periodic mode, no overlapping passes, timestamp updates, cancellation, and supervisor retry;
- boot resuming persisted periodic settings and legacy/empty settings using continuous;
- SQLite round trip/default/check constraint, in-memory parity, schema version 8, and v7 fixture migration;
- web initialization, enabled/paused frequency selection, request body, busy state, stale-poll protection, and failure display/reversion as applicable.

Focused commands:

```bash
cd tephra-server/go
go test -race ./internal/vaultmodel ./internal/db/sqlite ./internal/testutil ./internal/obsidian ./internal/api

cd ../..
npm run test --workspace=@tephra/web -- tests/obsidian-settings.test.tsx
```

Required final commands from repository root:

```bash
npm run go:check
npm run check
```

## Compatibility, deployment, and rollback risks

- Migration 8 is additive and preserves continuous behavior, but binaries supporting only schema 7 cannot open an upgraded database; rollback requires a v8-aware build.
- Deploy the Go server before/with the web bundle. The web UI may defensively treat a missing frequency as `continuous` during mixed-version serving.
- Enabled frequency changes briefly stop/restart sync and perform the existing immediate initial pass; paused changes cause no sync.
- Periodic modes do not scan the checkout between passes; web edits continue through existing synchronous import/restart flows.
- A sync pass longer than its interval delays the next pass by a full interval after completion rather than overlapping or catching up in a burst.
- Periodic operation starts the official client for each pass, trading continuous idle processes for recurring startup cost.

## Completion checklist

- [x] Model/default/validation and migration 8 implemented.
- [x] Partial PUT contract implemented with backward-compatible enable behavior.
- [x] Continuous preserved; periodic scheduling, cancellation, imports, and worker restart implemented.
- [x] Web selector and API client implemented with all five choices.
- [x] Focused regression tests pass, including race tests and legacy migration coverage.
- [x] `npm run go:check` and `npm run check` pass.
- [x] README and verified progress documentation updated.
- [x] Final diff reviewed; no plugin changes, secret logging, unrelated changes, or git mutations.
