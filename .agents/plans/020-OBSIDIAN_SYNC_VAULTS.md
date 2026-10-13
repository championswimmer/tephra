# Obsidian Sync Vaults (server-side official Obsidian Sync)

> Status: implementation plan (not started)
> Supersedes: deleted `006-HEADLESS_OBSIDIAN_SYNC.md` (external sidecar bridge, never implemented)
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`, `003-MULTI_TENANT_PERSISTENCE.md` (`/data` layout), `004-DEPLOYMENT_PROFILES.md`
> Last updated: 2026-10-13

## 1. Context and outcome

Today every Tephra vault is a **Tephra-sync vault**: the Tephra Obsidian plugin
pushes content through plan/upload/commit, bytes land in the SHA-256 blob store,
and each commit becomes a revision in `vault_revisions` / `file_versions`.

Users who already pay for **official Obsidian Sync** want the server to join
their sync network as one more device, with no Tephra plugin on their phones
and laptops. Obsidian now ships an official headless client
(`obsidian-headless`, binary `ob`), so the server can run real Obsidian Sync
itself.

Outcome: when creating a vault in the web app, the owner picks a **sync mode**:

- **Tephra Sync** (`syncMode: 'tephra'`): unchanged behavior.
- **Obsidian Sync** (`syncMode: 'obsidian'`): the owner signs in with their
  Obsidian account (email, password, optional 2FA code) and picks a remote vault.
  Optionally they enter its end-to-end encryption password. Tephra then runs
  `ob sync --continuous` for that vault into a checkout directory on `/data`.
  The web app browses, renders, indexes and graphs that checkout. In
  bidirectional mode, web edits are written into the checkout and Obsidian Sync
  uploads them.

The mode is chosen once at creation and **cannot be changed later**. In v1 a
vault cannot be converted between modes.

For an Obsidian Sync vault, the **checkout on disk is the source of truth**.
Obsidian Sync keeps version history. Tephra does not store blobs or revisions
for these vaults.

## 2. Research findings (October 2026)

Sources: `obsidian.md/help/headless` and `obsidian.md/help/sync/headless`, the
`github.com/obsidianmd/obsidian-headless` README, a static read of the
`obsidian-headless@0.0.14` npm tarball (published 2026-07-30), and a forum
thread on headless auth tokens.

- **Status:** open beta. The CLI is at version `0.0.x` and the forum reports
  breaking changes to the login flow. Pin an exact version.
- **Runtime:** Node `>=22` (Tephra's image is already `node:22-bookworm-slim`).
  Its dependencies are `better-sqlite3` (native) and `commander`. Its own
  prebuilt native helpers cover only win32 and darwin. Linux works without
  them; it just loses file creation times.
- **License: `UNLICENSED` (proprietary).** Tephra is AGPL-3.0. We spawn `ob`
  as a separate program (no linking), and we **must not vendor it**: no copy in
  the repo, no root `package.json` dependency, no published image that bundles
  it. It is installed from npm at image build time by whoever builds the image.
  Tephra publishes no images today. Revisit this if that changes.
- **Commands we use:**
  - `ob login --email --password [--mfa]`: prompts for anything omitted. When a
    2FA code is needed and missing, it fails with an error whose message
    contains `2FA code`.
  - `ob logout`: clears the token and invalidates it on the server.
  - `ob sync-list-remote --json`
  - `ob sync-setup --vault <id> --path <dir> --password <e2ee> --device-name <n> --json`:
    `--password` is required with `--json` for E2E vaults.
  - `ob sync-config --path <dir> --mode bidirectional|pull-only|mirror-remote
    --conflict-strategy merge|conflict --file-types … --configs … --excluded-folders …`
  - `ob sync --path <dir> [--continuous]`
  - `ob sync-status --path <dir> --json`
  - `ob sync-unlink --path <dir>`
  - `--json` sends errors to stderr, sets a non-zero exit code, and disables
    interactive prompts.
- **State locations** (from the bundle):
  - Auth token: `$XDG_CONFIG_HOME/obsidian-headless/auth_token` on Linux, or
    `~/.obsidian-headless` on other platforms. The `OBSIDIAN_AUTH_TOKEN`
    environment variable overrides the file.
  - Per-vault sync state: `$XDG_CONFIG_HOME/obsidian-headless/sync/<id>/state.db`
    and `sync.log`. The config JSON is written with mode `0600`.
  - Lock file: `<vault>/<configDir>/.sync.lock`.
  - Consequence: one `XDG_CONFIG_HOME` per Tephra vault fully isolates
    accounts, tokens and sync state.
- **Official guidance:** use only one sync method per device. Headless sync is
  aimed at "CI pipelines, agents, and automated workflows", which covers
  server use. Each Tephra vault shows up as one Sync device; its name is set
  with `--device-name`.
- **Not documented, so the Phase 0 spike must verify:**
  - the exact `--json` output shapes;
  - whether `ob login` reads from piped stdin, which would keep the password
    out of argv;
  - whether `ob` writes files atomically;
  - how a bidirectional client treats a checkout that is empty or missing but
    still has sync state (likely it propagates deletes, which would be
    catastrophic);
  - the memory footprint of each `ob` process.

## 3. Scope

- Persist an immutable `vaults.sync_mode` (`tephra` | `obsidian`), chosen at
  creation.
- Add a server-side Obsidian Sync lifecycle for each vault: login, pick a
  remote, set up (including E2E), initial sync, continuous sync, status,
  restart, re-login, and teardown on delete.
- Add a Node-only package `@tephra/obsidian-sync` containing:
  - a CLI adapter behind an interface;
  - a process supervisor;
  - a safe checkout reader/writer;
  - a disk-to-index reconciler.
- Make content reads go through a per-vault content-source abstraction, so the
  files, rendered, attachment and indexing paths work for both modes.
- Reject Tephra-protocol write paths (`sync/*`, `blobs/*`, `changes`) on
  Obsidian Sync vaults. Tokens for these vaults are limited to read-only
  scopes.
- Web UI:
  - a create-vault wizard with a mode picker;
  - the Obsidian login, remote-picker and setup steps;
  - status badges, plus error and re-login states;
  - editing disabled when the vault is `pull-only`.
- Web edits on bidirectional Obsidian Sync vaults, using an atomic write into
  the checkout.
- Deployment: an opt-in Docker build argument installs the pinned CLI. Add
  runtime environment flags, docs and a Railway variable. The plugin shows a
  clear message when it is pointed at an Obsidian Sync vault.
- Regression tests for every new security invariant (§5).

## 4. Non-goals (v1)

- Converting vaults between `tephra` and `obsidian` modes, in either direction.
- Creating remote vaults (`ob sync-create-remote`). The remote must already
  exist.
- One Obsidian account shared across several Tephra vaults. Each vault logs in
  separately (§6.3).
- Syncing `.obsidian` config, themes or plugins (`--configs ""`). Third-party
  plugin code is never downloaded, let alone executed.
- Obsidian Publish, Xvfb or desktop Obsidian, unofficial Sync
  reimplementations, or calling `api.obsidian.md` directly. Only `ob` speaks
  the Sync protocol.
- Tephra-side history or revisions for Obsidian Sync vaults. History lives in
  Obsidian Sync.
- Web create, rename, delete or upload of files on Obsidian Sync vaults. The
  only web write is editing existing Markdown content, the same as today's
  web editor.
- Bidirectional mode on network filesystems (EFS, Filestore/NFS). This is
  documented as unsupported (§11).
- Bundling `obsidian-headless` into any published artifact.

## 5. Invariants and security constraints

1. **Mode is immutable.** `vaults.sync_mode` is set on insert and never
   updated. A SQLite trigger enforces this, with a test.
2. **No ledger for Obsidian Sync vaults.** SQLite triggers reject inserts into
   `vault_revisions` and `file_versions` for `sync_mode='obsidian'`. The
   Tephra-sync guarantees stay intact:
   - blobs are immutable and SHA-256 verified;
   - every commit is revisioned;
   - a `vault_files.blob_hash` for a Tephra-sync vault must exist in `blobs`.
     This moves from the column foreign key to a mode-aware trigger (§7) and
     gets a regression test.
3. **Protocol separation.** `POST sync/plan`, `PUT blobs/:hash`,
   `POST sync/commit` and `GET changes` return
   `409 VAULT_SYNC_MODE_MISMATCH` on Obsidian Sync vaults. The check runs
   inside the commit transaction as well as before it.
   `POST tokens` rejects the `vault:upload` and `vault:write` scopes for them.
4. **Delete-propagation safety.** This is the critical one.
   - Tephra never removes, truncates or moves files in a checkout while an
     `ob` process for that vault is running or could start.
   - Teardown order is fixed:
     1. stop the process and wait for it to exit;
     2. run `ob sync-unlink`;
     3. run `ob logout`;
     4. remove the directory.
   - The supervisor refuses to start `ob` when the checkout is missing or
     empty but sync state exists. It sets the state to
     `error/CHECKOUT_MISSING` and requires an explicit re-setup.
   - Deleting a Tephra vault never touches the remote Obsidian vault, and the
     UI copy says so.
5. **Checkout confinement.** Every read and write resolves an
   `isCanonicalVaultPath` relative path under the checkout root.
   - It is checked with `lstat`, and symlinks are refused.
   - The resolved `realpath` must stay under the root.
   - It never follows `..`, absolute paths or NUL bytes.
   - These cases get regression tests.
6. **Secrets.**
   - Obsidian email, password, 2FA code and E2E password are never written to
     the Tephra database or Tephra logs, and are never returned by the API.
   - They are held in memory only for the duration of a single `ob`
     invocation.
   - The only stored credentials are the CLI's own files under a per-vault
     `config/` directory (mode `0700`).
   - The request logger redacts the bodies of the `obsidian-sync/login` and
     `obsidian-sync/setup` routes. A log-capture test asserts that no secrets
     leak.
7. **Child process hygiene.**
   - `ob` is spawned with an explicitly built environment (`PATH`, `HOME`,
     `XDG_CONFIG_HOME`, `NODE_ENV`, locale). It never inherits `process.env`,
     so `TEPHRA_SESSION_SECRET`, `TEPHRA_BOOTSTRAP_TOKEN` and the rest never
     reach it.
   - It runs with `shell: false`, and argv is never logged.
   - Its stdout and stderr go into a bounded ring buffer that is redacted and
     classified into error codes. Raw `ob` output (which can include note
     paths) never goes to Tephra's structured logs.
8. **Shared packages stay browser-safe.** `child_process` and `fs` live only in
   `@tephra/obsidian-sync` and `apps/api`. `protocol` and `vault-model` gain
   only types and schemas.
9. Only the session owner can run the setup routes. CSRF is enforced as
   usual, and the login route is rate-limited to 5 attempts per vault per
   15 minutes.

## 6. Design

### 6.1 Disk layout

This replaces the `checkouts/` and `sync-state/` folders that plan 003
reserved. Update plan 003 in the same change.

```text
/data/obsidian-sync/<vault-id>/      # 0700, owned by the server user
  config/                            # HOME + XDG_CONFIG_HOME for this vault's `ob` (auth_token, sync state.db, sync.log)
  vault/                             # the checkout (`--path`); source of truth for this Tephra vault
  tmp/                               # web-edit staging; same filesystem as vault/ so rename(2) is atomic
```

Root: `TEPHRA_OBSIDIAN_SYNC_PATH`. The default is `/data/obsidian-sync` in the
image and `./data/obsidian-sync` in development.

### 6.2 Process model

```text
apps/api (one Node process)
  ObsidianSyncSupervisor
    ├─ vault A: `ob sync --continuous --path …/A/vault`   (env: HOME=XDG_CONFIG_HOME=…/A/config)
    ├─ vault B: `ob sync --continuous --path …/B/vault`
    └─ CheckoutReconciler per vault: fs.watch(recursive) + debounce 2s + full scan every TEPHRA_OBSIDIAN_SCAN_INTERVAL_SECS
          → upsert/delete vault_files rows → bump vaults.latest_revision (generation) → indexService.indexVault
```

- **Supervision.**
  - There is one child process per vault in state `running`. The CLI's
    `.sync.lock` is a second guard.
  - A crashed child restarts with exponential backoff: 2 s, doubling, capped
    at 5 min. After 5 consecutive auth-classified failures the vault moves to
    `error/OBSIDIAN_AUTH_EXPIRED` and stops restarting.
  - On `SIGTERM`, the API stops all children (SIGTERM, then SIGKILL after 8 s)
    before `database.close()`, within the existing 10 s shutdown budget.
- **Boot.** The supervisor starts every vault whose `obsidian_sync_vaults.state`
  is `running`, after the pre-flight check (invariant 4).
- **Concurrency cap:** `TEPHRA_OBSIDIAN_MAX_VAULTS`, default `5`. Setup is
  refused with `409 OBSIDIAN_SYNC_LIMIT` beyond that.
- **Why not one-shot polling?** Continuous mode is what makes this "real
  sync": Obsidian pushes remote changes to the server within seconds, and web
  edits go out without a polling delay.

### 6.3 Login and setup flow

Each vault gets its own login so that `XDG_CONFIG_HOME` isolates accounts and
tokens. Re-using one login across vaults would mean a shared mutable token and
logout ordering problems, so it is deferred.

1. **Create the vault.** `POST /api/v1/vaults {name, syncMode: 'obsidian'}`
   inserts the vault plus an `obsidian_sync_vaults` row in state
   `pending-login`. A vault that was abandoned mid-setup stays listed as
   "Setup incomplete", with Resume and Delete actions.
2. **Log in.** `POST …/obsidian-sync/login {email, password, mfa?}` runs
   `ob login` non-interactively. Phase 0 decides whether the password is
   passed on stdin or in argv (§2). Possible outcomes:
   - `200 {account: {email, name?}}`; state becomes `pending-remote`.
   - `401 OBSIDIAN_MFA_REQUIRED`: the UI shows a 2FA field and resubmits
     email, password and code. The password is kept only in browser memory.
   - `401 OBSIDIAN_LOGIN_FAILED`.
   - `502 OBSIDIAN_UNREACHABLE`.
3. **List remotes.** `GET …/obsidian-sync/remotes` runs
   `ob sync-list-remote --json` and returns
   `[{id, name, encryption: 'standard'|'e2ee', region?}]`.
   - `402 OBSIDIAN_SYNC_NOT_SUBSCRIBED` if the account has no Sync plan, when
     that can be detected.
4. **Set up.** `POST …/obsidian-sync/setup {remoteVaultId, encryptionPassword?, mode: 'bidirectional'|'pull-only'}`:
   - creates `vault/`, `config/` and `tmp/`;
   - runs `ob sync-setup … --device-name "<TEPHRA_OBSIDIAN_DEVICE_NAME> (<vault name>)" --json`;
   - runs `ob sync-config --mode <mode> --conflict-strategy merge --configs "" --file-types image,audio,video,pdf,unsupported --excluded-folders ""`.
   - **Wrong E2E password:** `422 OBSIDIAN_E2EE_PASSWORD_INVALID`, if setup
     reports it. Otherwise the first sync reports it and the vault moves to
     `error`.
   - **Success:** `202`; state becomes `initial-sync`.
5. **Initial sync.** The supervisor runs `ob sync --path …` once, then runs a
   full reconcile and index, then sets state `running` and spawns
   `--continuous`. The UI polls `GET …/obsidian-sync/status` every 2 s while
   the state is `initial-sync`.
6. **Recovery actions.**
   - `POST …/obsidian-sync/relogin` (same body as login): used from
     `error/OBSIDIAN_AUTH_EXPIRED`; it restarts the process.
   - `POST …/obsidian-sync/restart`: clears the backoff.
   - `POST …/obsidian-sync/resetup`: used from `error/CHECKOUT_MISSING`. It
     stops the process, removes `config/obsidian-headless/sync/` and
     `vault/`, re-runs setup, and runs a fresh pull.

State machine (`obsidian_sync_vaults.state`):
`pending-login → pending-remote → initial-sync → running ⇄ error`, plus
`stopped`, which is used only during teardown. `last_error_code` is one of:

- `OBSIDIAN_AUTH_EXPIRED`
- `OBSIDIAN_E2EE_PASSWORD_INVALID`
- `CHECKOUT_MISSING`
- `OB_CRASH_LOOP`
- `OB_UNAVAILABLE`
- `DISK_FULL`

### 6.4 File identity and the index without blobs or revisions

`vault_files` stays the single "current files" table for both modes, so these
keep working unchanged against `vault_files`, `note_metadata` and
`note_links`:

- the indexer and link resolver;
- graph and graph cache;
- path resolution;
- the file tree and search.

For Obsidian Sync vaults:

- **`file_id`** is `o-` followed by the first 32 hex characters of
  `sha256(vaultId + '\0' + NFC(path))`. It is deterministic, so rescans are
  idempotent. A rename produces a new id; path-addressed web URLs (plan 010)
  keep links stable. The `historic` match in `/resolve` simply never fires
  because there are no `file_versions`.
- **`blob_hash`** holds the SHA-256 of the bytes on disk (renamed
  conceptually to "content hash" in the docs, with no column rename). There is
  **no** `blobs` row and nothing is written to the blob store. It drives:
  - `If-Match` for web edits;
  - `note_metadata.indexed_blob_hash`;
  - change detection.
- **`kind`** uses the plugin scanner rule: `.md` means markdown, anything else
  is an attachment. `mime_type` comes from the extension map the plugin
  already uses (move it into `@tephra/protocol` if it is not shared yet).
- **`updated_revision`** and **`vaults.latest_revision`** become a
  **generation counter**. It is bumped once per reconcile pass that changed at
  least one row. It keeps `indexVault(vaultId, revision)`, graph ETags and the
  `indexedRevision` logic working unchanged. No `vault_revisions` rows exist.
  The UI shows "Last synced …" instead of "Revision N" for these vaults.

**Reconciler.** One pass per vault, serialized behind a per-vault mutex.

1. Walk `vault/` and skip:
   - dotfiles and dot-folders, including `.obsidian/` and `.trash/`;
   - `*.sync.lock`;
   - symlinks;
   - non-regular files;
   - non-canonical paths, counted as `skipped`.
2. For each entry where `(size, mtimeMs)` differs from the stored row,
   re-hash it as a stream. If `size` or `mtime` changed during the hash,
   leave the old row and retry next pass. This guards against reading a file
   that `ob` is still writing.
3. Diff against `vault_files` and apply it in one transaction under
   `lockVault`: upsert changed rows, delete missing ones, bump the generation.
4. After the transaction, delete the graph cache row and call `indexVault`,
   the same as the commit path.

### 6.5 Content-source abstraction

Add a `VaultContentSource` interface to `apps/api/src/http/types.ts`, exposed
as `ApiDependencies.contentSources`:

```ts
interface VaultContentSource {
  read(vault: Vault, file: CurrentVaultFile): Promise<BlobReadResult | null>;
}
```

- **`BlobContentSource`** (Tephra-sync) wraps `blobStore.get(file.blobHash)`.
- **`CheckoutContentSource`** (Obsidian Sync, from `@tephra/obsidian-sync`)
  does a confined read from `vault/<path>`. If the bytes no longer hash to
  `file.blobHash`, it still serves the current bytes and triggers a
  reconcile. Reads always reflect disk; the index catches up.

Callers that switch from `blobStore.get` to `contentSourceFor(vault).read`:

- `files.ts` (`rawContent`, `rendered`);
- `runtime-index.ts` (`indexVault`);
- `web-edit.ts` (pre-check only).

### 6.6 Web edits (bidirectional only)

`PUT …/files/:fileId/content` on an Obsidian Sync vault:

- `pull-only` mode returns `409 VAULT_READ_ONLY`.
- Otherwise, under the per-vault reconcile mutex:
  1. Confined `lstat` of the target.
  2. Hash the current disk bytes and compare them to `If-Match`. A mismatch
     returns `409 EDIT_CONFLICT` with the current hash, size and mtime. The
     response shape is unchanged, so the web editor's conflict UI just works.
  3. Write to `tmp/<uuid>`, `fsync`, then `rename` into `vault/<path>`.
  4. Run an immediate reconcile of that single path, which bumps the
     generation and indexes.
  5. Respond with `{status: 'committed', revision: <generation>, blobHash, size, mtime}`.
- `ob --continuous` sees the rename and uploads it. A concurrent remote edit
  is resolved by Obsidian with `conflict-strategy merge`.

### 6.7 Capability discovery

`GET /api/v1/capabilities` (session) returns:

```json
{ "obsidianSync": { "available": true, "cliVersion": "0.0.14" } }
```

When it is unavailable, it returns
`{ "available": false, "reason": "disabled" | "cli-missing" | "cli-version-unsupported" }`.

- Availability means `TEPHRA_OBSIDIAN_SYNC=enabled` **and** `ob --version`
  succeeded at boot **and** the version is in the supported range.
- The web wizard disables the Obsidian Sync option and shows the reason.
- `POST /vaults {syncMode:'obsidian'}` returns
  `501 OBSIDIAN_SYNC_UNAVAILABLE` when it is unavailable.

## 7. Schema, API and protocol changes

**Migration `006_obsidian_sync_vaults.sql`** (add it to `MIGRATIONS` in
`packages/database/sqlite/src/migrate.ts`; this is a table rebuild, so it runs
under the existing foreign-keys-off migration path):

```sql
ALTER TABLE vaults ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'tephra'
  CHECK(sync_mode IN ('tephra', 'obsidian'));
CREATE TRIGGER vaults_sync_mode_immutable BEFORE UPDATE OF sync_mode ON vaults
  WHEN NEW.sync_mode <> OLD.sync_mode BEGIN SELECT RAISE(ABORT, 'vault sync_mode is immutable'); END;

-- Rebuild vault_files without `REFERENCES blobs(hash)` (keep every other
-- column, constraint, index and path_fold from 001+003), then enforce the
-- blob FK only for tephra vaults:
CREATE TRIGGER vault_files_tephra_blob_insert BEFORE INSERT ON vault_files
  WHEN (SELECT sync_mode FROM vaults WHERE id = NEW.vault_id) = 'tephra'
   AND NOT EXISTS (SELECT 1 FROM blobs WHERE hash = NEW.blob_hash)
  BEGIN SELECT RAISE(ABORT, 'FOREIGN KEY constraint failed: vault_files.blob_hash'); END;
CREATE TRIGGER vault_files_tephra_blob_update BEFORE UPDATE OF blob_hash ON vault_files
  WHEN … same condition … BEGIN … END;
CREATE TRIGGER vault_revisions_tephra_only BEFORE INSERT ON vault_revisions
  WHEN (SELECT sync_mode FROM vaults WHERE id = NEW.vault_id) <> 'tephra'
  BEGIN SELECT RAISE(ABORT, 'revisions are not recorded for obsidian sync vaults'); END;
CREATE TRIGGER file_versions_tephra_only BEFORE INSERT ON file_versions … (same);

CREATE TABLE obsidian_sync_vaults (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  state TEXT NOT NULL CHECK(state IN ('pending-login','pending-remote','initial-sync','running','error','stopped')),
  mode TEXT CHECK(mode IN ('bidirectional','pull-only')),
  remote_vault_id TEXT,
  remote_vault_name TEXT,
  encryption TEXT CHECK(encryption IN ('standard','e2ee')),
  account_email TEXT,
  device_name TEXT,
  last_sync_at INTEGER,
  last_error_code TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
```

Existing data: every existing vault becomes `tephra`, and its rebuilt
`vault_files` rows are copied verbatim. A migration test opens a v5 fixture
database, migrates it, and asserts row counts, `foreign_key_check`, and that
the triggers fire.

**Model and repositories:**

- `vault-model`: add `VaultSyncMode`, `Vault.syncMode`, `ObsidianSyncVault`
  and `ObsidianSyncState`.
- `database-core`:
  - `VaultRepository.insert` persists `syncMode`;
  - `update` must not change it;
  - new `ObsidianSyncRepository` (`find`, `insert`, `update`, `listByState`)
    on `Repositories`.
- `database-sqlite`: the implementations and their row mappers.

**Protocol (`@tephra/protocol`)** gains these error codes:

- `VAULT_SYNC_MODE_MISMATCH`
- `VAULT_READ_ONLY`
- `OBSIDIAN_SYNC_UNAVAILABLE`
- `OBSIDIAN_LOGIN_FAILED`
- `OBSIDIAN_MFA_REQUIRED`
- `OBSIDIAN_E2EE_PASSWORD_INVALID`
- `OBSIDIAN_SYNC_NOT_SUBSCRIBED`
- `OBSIDIAN_UNREACHABLE`
- `OBSIDIAN_SYNC_LIMIT`
- `OBSIDIAN_SYNC_STATE`: the action is invalid in the current state.

It also gains zod schemas for the vault DTO (`syncMode`) and the `obsidian-sync`
request and response bodies. There is no protocol version bump: the plugin
endpoints are unchanged for Tephra-sync vaults.

**API routes.** All are session-only and live in the new
`apps/api/src/routes/obsidian-sync.ts`:

| Method | Path | Notes |
| ------ | ---- | ----- |
| GET | `/api/v1/capabilities` | §6.7 |
| POST | `/api/v1/vaults` | body gains `syncMode` (default `tephra`) |
| POST | `/api/v1/vaults/:id/obsidian-sync/login` | §6.3 step 2; body redacted in logs |
| GET | `/api/v1/vaults/:id/obsidian-sync/remotes` | requires state `pending-remote` |
| POST | `/api/v1/vaults/:id/obsidian-sync/setup` | body redacted in logs |
| GET | `/api/v1/vaults/:id/obsidian-sync/status` | `{state, mode, remoteVaultName, encryption, accountEmail, lastSyncAt, lastErrorCode, fileCount}` |
| POST | `/api/v1/vaults/:id/obsidian-sync/{relogin,restart,resetup}` | §6.3 step 6 |
| DELETE | `/api/v1/vaults/:id` | for obsidian vaults, runs teardown (invariant 4) before the row delete; responds `204` after teardown |

Every `obsidian-sync/*` route on a `tephra` vault returns
`409 VAULT_SYNC_MODE_MISMATCH`. The vault-scope middleware maps
`/obsidian-sync/` to a session-only check.

## 8. Affected packages and files

| Area | Files |
| ---- | ----- |
| New package | `tephra-server/packages/obsidian-sync/` (`@tephra/obsidian-sync`, Node-only): `cli.ts` (`ObsidianHeadlessCli` interface + `SpawnObsidianHeadlessCli`: env construction, argv building, output parsing, error classification), `checkout.ts` (confined resolve/read/atomic write, walker), `reconciler.ts`, `supervisor.ts`, `content-source.ts`, `index.ts`; `tests/fixtures/fake-ob.mjs` |
| Migrations | `tephra-server/migrations/sqlite/006_obsidian_sync_vaults.sql`; `packages/database/sqlite/src/migrate.ts` |
| Model/DB | `packages/vault-model/src/entities.ts`; `packages/database/core/src/index.ts`; `packages/database/sqlite/src/{repositories,rows}.ts` |
| Protocol | `packages/protocol/src/{errors,files}.ts` (+ a vault/obsidian-sync schema module) |
| API | `apps/api/src/main.ts` (env parsing, supervisor lifecycle, shutdown ordering), `app.ts`, `http/types.ts`, `http/auth.ts` (scope mapping), `http/request-log.ts` (body redaction), `routes/{vaults,sync,changes,tokens,files,web-edit}.ts` (mode gating / content source), `routes/obsidian-sync.ts` (new), `runtime-index.ts` |
| Web | `apps/web/src/api/{client,types}.ts`; `routes/VaultListPage.tsx` (wizard trigger, mode badge, "Setup incomplete" card); new `components/CreateVaultWizard.tsx`, `components/ObsidianSyncStatus.tsx`; `routes/VaultWorkspace.tsx` (status pill, edit gating); `components/TokenManager.tsx` (read-only scope only + explainer for obsidian vaults); copy "Read-only mirrors synchronized from Obsidian" updated |
| Plugin | `tephra-plugin/src/…` sync client error handling: on `VAULT_SYNC_MODE_MISMATCH` show a persistent notice ("This vault is synced by Obsidian Sync on the server; Tephra direct sync is disabled") and pause direct sync |
| Deploy | `tephra-server/deploy/docker/Dockerfile` (`ARG OBSIDIAN_HEADLESS_VERSION=""`; when set, `npm install -g obsidian-headless@$VERSION` in a dedicated stage and copy into runtime; creates `/data/obsidian-sync`), `compose.yml` (env passthrough), `.railway/railway.ts` (build arg + `TEPHRA_OBSIDIAN_SYNC`), `deploy/*/README.md` notes |
| Docs | `tephra-server/README.md` env table; `docs/GETTING_STARTED.md` section "Using official Obsidian Sync"; root `README.md` one-liner; plan 003 layout update; `PROGRESS.md` only after verification |

**New environment variables** (add to the README table):

| Variable | Default | Meaning |
| -------- | ------- | ------- |
| `TEPHRA_OBSIDIAN_SYNC` | `disabled` | `enabled` turns the feature on; anything else is off |
| `TEPHRA_OBSIDIAN_BIN` | `ob` | path to the headless CLI |
| `TEPHRA_OBSIDIAN_SYNC_PATH` | `/data/obsidian-sync` | per-vault config/checkout root |
| `TEPHRA_OBSIDIAN_DEVICE_NAME` | `Tephra Server` | prefix of the Sync device name |
| `TEPHRA_OBSIDIAN_SCAN_INTERVAL_SECS` | `60` | full reconcile safety-net interval |
| `TEPHRA_OBSIDIAN_MAX_VAULTS` | `5` | concurrent Obsidian Sync vaults |

`main.ts` validates these at boot and fails fast on bad values. Values are
never echoed.

## 9. Implementation phases

Each phase ends green on `npm run check`.

### Phase 0: CLI spike (manual, real account, no production code)

1. In a throwaway container from `node:22-bookworm-slim`, install the pinned
   `obsidian-headless`. Use a test Obsidian account with Sync, one standard
   vault and one E2E vault.
2. Record:
   - the `--json` output of `sync-list-remote`, `sync-setup`, `sync-status`
     and error cases;
   - the exact login error strings (bad password, 2FA needed, bad 2FA,
     expired token);
   - whether `ob login` accepts the password on piped stdin;
   - the write pattern during a pull (atomic or not);
   - the memory footprint of `--continuous`;
   - **the behavior when the checkout is emptied or deleted with sync state
     present.** Use a disposable remote vault only.
3. Commit redacted JSON samples under
   `packages/obsidian-sync/tests/fixtures/ob-samples/`. Update §2, §6.3 and
   the supported version range in this plan with the findings.

Gate: findings recorded, and any design change is reflected here before Phase 1.

### Phase 1: Schema and model

1. Add migration 006, plus a migration test from a v5 fixture.
2. Update the vault-model types and repositories, including `syncMode`
   round-trip and the `ObsidianSyncRepository`.
3. Trigger tests:
   - mode is immutable;
   - Tephra-sync vaults still reject an unknown `blob_hash`;
   - Obsidian Sync vaults accept content hashes without blobs;
   - `vault_revisions` and `file_versions` reject Obsidian Sync vaults.

Gate: all existing database and API tests pass unchanged.

### Phase 2: Mode gating and the content-source refactor (no `ob` yet)

1. `POST /vaults` accepts `syncMode`. Return `501` unless capability is
   available; tests inject a capability stub.
2. Add `VaultContentSource` and switch `files.ts`, `runtime-index.ts` and
   `web-edit.ts` over to it. The existing tests are the regression gate for
   Tephra-sync vaults.
3. Add `VAULT_SYNC_MODE_MISMATCH` gating on `sync/plan`, `blobs`,
   `sync/commit` (inside the transaction too) and `changes`, and the scope
   restriction on `tokens`. Each gets a test.

### Phase 3: The `@tephra/obsidian-sync` package

1. `checkout.ts`: confined resolve, read, walk and atomic write. Tests cover:
   - symlink (file and directory);
   - `..` and absolute paths;
   - NUL bytes;
   - non-regular files;
   - dotfiles and `.obsidian`;
   - Unicode NFC/NFD;
   - a file changing during hashing.
2. `cli.ts`:
   - argv builder;
   - env builder (test that no `TEPHRA_*` variable or arbitrary parent
     variable leaks);
   - output parsing against the Phase 0 samples;
   - error classification.
3. `fake-ob.mjs`: a fake CLI implementing `--version`, `login`,
   `sync-list-remote`, `sync-setup`, `sync-config`, `sync`, `sync --continuous`,
   `sync-unlink` and `logout`. It copies from a fixture "remote" directory and
   can be scripted to fail through environment hooks.
4. `reconciler.ts`:
   - generation bump only on change;
   - deterministic ids;
   - delete detection;
   - the race retry.
5. `supervisor.ts`: tests use fake timers and the fake CLI.
   - start, restart and backoff;
   - auth-failure escalation;
   - the pre-flight `CHECKOUT_MISSING` refusal;
   - ordered teardown, where removal never happens before the child exits;
   - shutdown.

### Phase 4: API wiring

1. `routes/obsidian-sync.ts` and the state machine, with integration tests
   through `createApp` plus the fake CLI. Cover the whole path:
   login → MFA → remotes → setup → initial sync → running → files, rendered,
   graph and search all serve checkout content.
2. In `main.ts`: env parsing, capability probe, supervisor boot-resume, and
   shutdown ordering.
3. Wire request-log redaction. Add a log-capture test asserting that the
   password, E2E password and 2FA code never appear.
4. Delete flow, with a test asserting the teardown call order
   (stop → unlink → logout → rm) and that the remote fixture is untouched.

### Phase 5: Web UI

1. Capability fetch.
2. `CreateVaultWizard`:
   1. name and mode;
   2. Obsidian sign-in, including the 2FA step;
   3. remote picker with an encryption badge;
   4. E2E password (if needed) and mode (`bidirectional` read/write vs
      `pull-only` read-only);
   5. initial-sync progress.
3. Vault cards: mode badge, plus "Setup incomplete" and "Sync error" states
   with Resume, Re-login and Restart actions.
4. Workspace status pill. Disable editing for `pull-only`. TokenManager
   restrictions.
5. Component tests, and a Playwright flow against a server started with
   `TEPHRA_OBSIDIAN_BIN=<fake-ob>`.

### Phase 6: Web edits on bidirectional vaults

1. Implement §6.6, with tests for:
   - committed;
   - up-to-date;
   - `EDIT_CONFLICT` when disk changed underneath;
   - `VAULT_READ_ONLY`;
   - the fake `ob` observing and "uploading" the change;
   - the temp file never appearing inside `vault/`.

### Phase 7: Deployment, plugin and docs

1. Dockerfile build argument and stage.
2. CI: build the image with the argument unset (default). In a separate job,
   build with a pinned version and check `ob --version` inside the image.
3. Compose and Railway variables. Per-profile support notes (§11).
4. Plugin `VAULT_SYNC_MODE_MISMATCH` handling, plus a plugin test.
5. README and GETTING_STARTED updates. Update plan 003's layout.

### Phase 8: Manual acceptance against real Obsidian Sync (never in CI)

1. Run Docker Compose with the CLI built in, on a standard vault and an E2E
   vault, in both `bidirectional` and `pull-only` modes.
2. Check:
   - **Remote to server:** an edit on a phone appears in Tephra within about
     10 s.
   - **Server to remote:** a web edit appears in desktop Obsidian.
   - **Restart:** restarting the container reuses the device, with no
     duplicate device in Sync history.
   - **Delete:** deleting the Tephra vault leaves the remote intact.
   - **Expired auth:** after `ob logout`, the vault reaches
     `OBSIDIAN_AUTH_EXPIRED`, and re-login recovers it.

## 10. Verification

```bash
npm run check
npm run test --workspace=@tephra/obsidian-sync
npm run test --workspace=@tephra/api
npm run test:e2e                       # includes the fake-ob Obsidian Sync wizard flow
docker build -f tephra-server/deploy/docker/Dockerfile -t tephra:test .
docker build -f tephra-server/deploy/docker/Dockerfile --build-arg OBSIDIAN_HEADLESS_VERSION=<pinned> -t tephra:ob .
docker run --rm --entrypoint ob tephra:ob --version
```

Key assertions:

- Tephra-sync behavior is byte-for-byte unchanged, and all existing tests pass.
- Obsidian Sync vaults never create rows in `blobs`, `vault_revisions` or
  `file_versions`, and never write to the blob store.
- No secret appears in the database, the logs or API responses.
- Teardown never deletes checkout files while `ob` is alive.
- Confinement holds against symlinks and traversal.

## 11. Compatibility, deployment and rollback risks

| Risk | Mitigation |
| ---- | ---------- |
| CLI is open beta; flags, output or login change | Exact pin through the build argument. The boot probe checks the supported version range and degrades capability to `cli-version-unsupported`. Output parsing is tolerant and covered by fixture samples. Upgrading means bump, rebuild and run the Phase 8 checklist. |
| Proprietary CLI license vs AGPL repo | Never vendored or published. It is installed by the image builder. Docs state that the user accepts Obsidian's terms. |
| Bidirectional delete propagation (empty checkout, partial restore, careless cleanup) | Invariant 4: the pre-flight refusal, ordered teardown, and tests. `resetup` is the only recovery path, and it pulls fresh. |
| Web edit and remote edit race | `If-Match` against the hash on disk under the mutex. Obsidian's `merge` strategy covers the remaining window, and conflicts surface as Obsidian conflict files that the reconciler indexes like any file. |
| Partial reads while `ob` writes | The stable `(size, mtime)` check around hashing, plus retry on the next pass. Reads always serve current disk bytes. |
| Network filesystems (ECS + EFS, Cloud Run + Filestore): no inotify | The reconciler falls back to periodic scans. `ob --continuous` may miss local web edits, so `bidirectional` is **documented as unsupported** on network filesystems; use `pull-only` there. |
| Cloud Run scale-to-zero / CPU throttling kills continuous sync | Documented requirements: min-instances 1 and CPU always allocated, or use the GCE VM profile (recommended). |
| Memory: one Node process per vault | `TEPHRA_OBSIDIAN_MAX_VAULTS` cap. The Phase 0 measurement goes into the docs, with a sizing note for Railway and e2-micro. |
| `better-sqlite3` native build fails on slim image | Install in a build stage with `python3 make g++`, then copy the global install into runtime. CI job verifies `ob --version`. |
| Token at rest in `config/auth_token` (plaintext, CLI-owned) | Directory mode `0700`, owned by the non-root user. Snapshot/backup docs (plan 005) note that `config/` holds an Obsidian session token; restoring from a backup may require re-login. |
| Duplicate Sync devices after volume loss | Device identity lives in `config/`. Volume loss means re-setup, and the docs explain removing stale devices in Obsidian settings. |
| Schema rollback | Migration 006 is forward-only, like 005. Rolling back the binary after 006 is unsupported. Operators take a `/data` snapshot before upgrading (existing guidance). With the feature disabled (`TEPHRA_OBSIDIAN_SYNC` unset), existing deployments only see the column and table additions and behave as before. |
| Feature rollback | Set `TEPHRA_OBSIDIAN_SYNC=disabled`. Existing Obsidian Sync vaults remain browsable in read-only mode from their last checkout (the supervisor does not start, the status shows `OB_UNAVAILABLE`, and editing is disabled). |

## 12. Completion checklist

- [ ] Phase 0 findings recorded in this plan; samples committed.
- [ ] Migration 006 and the triggers, with migration and invariant tests.
- [ ] Mode gating and the content-source refactor; existing tests are green.
- [ ] `@tephra/obsidian-sync` package with the fake CLI, covering
      confinement, reconcile, supervisor and teardown tests.
- [ ] Setup API and state machine; secret-redaction log test.
- [ ] Web wizard, statuses and edit gating; Playwright fake-`ob` flow.
- [ ] Bidirectional web edits with an atomic write and conflict handling.
- [ ] Docker build argument, CI `ob --version` job, Compose/Railway env, docs,
      plugin message.
- [ ] Manual real-Sync acceptance (standard and E2E, both modes).
- [ ] `npm run check` passes; `PROGRESS.md` updated with verified items only.
- [ ] Plan deleted after the work is complete and committed (planning skill
      lifecycle).

## 13. References

- `.agents/plans/001-TEPHRA_STAGE1_PLAN.md`: blob and revision invariants,
  read-only and plugin protocol.
- `.agents/plans/003-MULTI_TENANT_PERSISTENCE.md`: `/data` layout, to be
  updated by this plan.
- `.agents/plans/004-DEPLOYMENT_PROFILES.md`: profile constraints referenced
  in §11.
- Code: `tephra-server/apps/api/src/routes/{sync,web-edit,files,changes,vaults}.ts`,
  `apps/api/src/runtime-index.ts`, `migrations/sqlite/001_initial.sql`,
  `packages/database/sqlite/src/migrate.ts`.
- Official: `https://obsidian.md/help/headless`, `https://obsidian.md/help/sync/headless`,
  `https://github.com/obsidianmd/obsidian-headless`, `https://www.npmjs.com/package/obsidian-headless`.
- Community: `https://forum.obsidian.md/t/headless-sync-how-to-get-obsidian-auth-token-variable/111740`
  (token location and beta login churn).
