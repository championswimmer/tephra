# Official Obsidian Headless Sync at runtime

Status: implemented and verified; retained pending commit (no commit requested). Supersedes plan 020's build-time install and its
checkout-only/no-revision design. Existing vault guarantees remain in force.

## Outcome and scope

Settings creates an immutable Obsidian Sync vault, signs in with optional MFA,
lists remote vaults, accepts an E2E password, enables/disables automatic Sync,
and supports retry/re-authentication. The official client runs continuously.
Web/MCP Markdown writes use its checkout. Downloads are imported into verified
immutable blobs and the existing revision ledger, retaining current readers,
rendering, search and graph. Support bidirectional and pull-only operation.

Non-goals: mode conversion, remote vault creation, account sharing across vaults,
Publish, plugin execution, bundled official client, object storage runtime.

## Research (2026-11-06)

Primary sources: https://obsidian.md/help/headless,
https://obsidian.md/help/sync/headless,
https://github.com/obsidianmd/obsidian-headless/blob/master/README.md,
https://github.com/obsidianmd/obsidian-headless/blob/master/cli.js,
https://registry.npmjs.org/obsidian-headless/0.0.14.

Verified 0.0.14, Node >=22, separate proprietary subprocess. Remote JSON is
`{vaults:[{id,name,region}],shared:[...]}` without encryption metadata. Login
has no JSON option. The non-TTY password prompt reads until EOF and trims
trailing whitespace. Implementation uses a small separate Node launcher: it
reads secret flags as JSON from stdin and sets them in child memory before
loading the unmodified official CLI. Email, password, MFA and E2E passwords
never enter the OS command line or environment, and whitespace is preserved.
An absent MFA code uses a deliberately invalid six-digit placeholder to avoid
a second interactive prompt. Setup uses JSON mode; managed vaults obtain their
password internally.
Linux state is XDG_CONFIG_HOME/obsidian-headless; other platforms use
HOME/.obsidian-headless. Tokens and derived vault keys allow restart without
retaining account passwords. Live paid-account acceptance requires user access
and is not a CI prerequisite; report this verification limitation explicitly.

## Invariants and persistence

- Separate private HOME/XDG_CONFIG_HOME per vault on persistent data volume.
  Settings, checkout, token and derived keys persist alongside SQLite/blobs.
  Without a volume private state must be re-created through login/setup.
- Pinned client installed into disposable cache on first use and enabled boot;
  never at build/npm ci. Coalesce installation, fixed npm registry, shell false,
  bounded output/timeouts, minimal subprocess environment without app secrets.
- Owner sessions/CSRF only for setup, throttled login, fixed public error codes.
  Passwords/MFA never enter DB/settings/logs/responses or child argv.
- Reject plugin writes for native vaults, including inside commit transactions.
- Serialize native edits/reconciliation; stop child before atomic confined
  writes, verify base hash, import revision then restart.
- Missing/empty previously populated checkout with retained state must never
  start bidirectional sync; require explicit setup recovery.
- Disable preserves state. Delete stops/waits before unlink/logout/removal;
  never delete the Obsidian remote vault.
- Scan rejects symlinks, noncanonical paths, hidden/config directories, special
  files and oversized files. Incomplete scans abort without imported deletions.

## Affected packages and API/migration

Vault-model: additive syncMode and settings types. Database core/sqlite:
immutable sync_mode column and cascading native settings repository, migration
007, all infrastructure behind interfaces. Apps/api: Node-only CLI/filesystem
adapters, installer, supervisor, importer; injected service; owner routes under
vaults/:vaultId/obsidian-sync; create supports syncMode, native writes route to
service. Protocol: additive error codes. Apps/web: Settings create/login/remotes/
configuration/status; pull-only disables editing. Docker/env/README document
private persistent state versus disposable installation; no official dependency
in shipped manifests/lockfile. No plugin code changes required.

## Steps and verification

1. Schema/repository/model, immutable mode and migration tests.
2. Installer/process adapter; safe checkout and revision importer.
3. Serialized lifecycle, enabled boot, missing checkout guards, retry/backoff,
   graceful shutdown and delete ordering.
4. Owner API, write routing, Settings workflow and library discovery.
5. Regression tests: credential/env isolation, install coalescing, confinement,
   revisions/hash integrity, auth/CSRF, plugin mode gates, recovery with missing
   cache, disabled boot, shutdown/delete races; web workflow tests.
6. Run npm run check; rebuild/restart per dev-server skill. Update PROGRESS only
   after verification. No commit requested; retain plan until committed.

## Rollout and rollback risks

One service process and local disk required, official CLI lock is second guard.
Runtime install needs outbound npm and native prebuild access; failed installs
leave ordinary vaults usable and can be retried. Native better-sqlite3 may need
build tools if no prebuilt binary exists. Beta version pinned deliberately.
Protect private volume/backups (token and keys). Rollback needs migration-aware
code or pre-migration DB restore; disable native vaults first.

## Checklist

- [x] Runtime installation, lifecycle and recovery
- [x] Revisioned import and native writes
- [x] Owner APIs and settings workflow
- [x] Security/restart/delete regression tests
- [x] Documentation, full checks, local server verification


## Verification evidence (2026-11-06)

`npm run check` passes with 687 tests. Native regression coverage includes
runtime install coalescing/reinstallation/failure, environment isolation,
secret-only stdin launching (including OS process command-line inspection),
MFA classification, owned/shared JSON, exact-byte revisioned imports,
symlinks/traversal, incomplete scan safety, optimistic web/MCP saves, download
only, enabled/paused boot, missing/empty/nested-empty checkout/state recovery,
installation retries, authentication recovery, pause/status update races,
teardown and both setup-time and boot-time vault limits. SQLite migration,
immutable mode, persisted settings/cascade and Settings UI workflows pass.

The actual official package installs in a disposable test cache and reports
0.0.14, empty local-vault JSON, and a working native better-sqlite3 dependency.
An isolated local server imports the 18-file sample vault, renders all 16 notes,
and generates its graph. Chromium creates a native vault through Settings and
confirms its SQLite-backed pending-login/disabled/read-only state with no page
errors. No live paid Obsidian account was available; account/MFA/E2E remote
round-trip acceptance remains explicitly unverified and documented.
