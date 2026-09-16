# 017 — Web Editing and Two-Way Sync

## 1. Context and user outcome

Today Tephra is a one-way mirror. The Obsidian plugin scans the local vault,
pushes a **complete** manifest to `POST /sync/commit`, and the web app renders
what the server holds. The web app has no write path at all, and the plugin has
no pull path: `SyncCoordinator.reconcile()` only ever uses the server as an
_identity_ authority (`repairAndReplan` → `listFiles()`), never as a content
source.

After this plan:

- A markdown note opened in the web app can be edited and saved.
- Each save produces a normal server revision, so the change lands in the
  existing `file_versions` delta ledger like any plugin commit.
- The plugin pulls those revisions into the local vault before its next scan,
  so the local Obsidian vault converges with web edits.
- When the same note changed on both sides, a deliberately simple
  last-write-wins rule decides, and the losing local bytes are preserved as a
  conflicted copy so nothing is ever destroyed.

### 1.1 This plan supersedes a standing repository rule

`AGENTS.md` currently states:

> Stage 1 is a read-only web mirror. Never add web-to-vault writes, merging,
> or third-party Obsidian plugin execution.

and `README.md` states Stage 1 "intentionally provides no web editing or
server-to-vault writeback."

**Updating both files is a required step of this plan (Phase 0).** If they are
left as-is, every future agent will read this feature as a rule violation. The
third clause (third-party Obsidian plugin execution) stays prohibited.

## 2. Scope

In scope:

1. A new standalone editor package `@tephra/markdown-editor`, built on
   CodeMirror 6, modelled on how `@tephra/graph-renderer` is packaged.
2. A server write path that turns one saved file into one revision, with
   optimistic concurrency.
3. A `GET /changes?since=<revision>` endpoint that projects `file_versions`
   into a per-file net-effect changelog.
4. A plugin pull phase that applies remote changes to the local vault before
   scanning, with last-write-wins conflict resolution and conflicted copies.

### 2.1 Non-goals

- **No CRDT, OT, three-way merge, or real-time collaboration.** Saves are
  whole-file. Conflict resolution is timestamp-based by explicit choice.
- **No create / rename / delete from the web** in Phases 0–4. The endpoint
  shape generalizes to them; they are deferred to Phase 5.
- **No attachment editing.** `kind === 'markdown'` only.
- **No WYSIWYG re-serialization.** See §4.2 — this is a hard constraint, not a
  preference.
- **No live-preview decorations** in Phase 1. Additive follow-on (Phase 5),
  and it must not change persisted bytes.
- No third-party Obsidian plugin execution (unchanged prohibition).
- No multi-user concurrent editing semantics; Tephra is single-user per
  deployment.

## 3. Invariants and security constraints

These are the rules an implementer may not trade away.

- **I1 — Pull before commit.** The plugin commits a _complete_ manifest, and
  `POST /sync/commit` deletes every `vault_files` row whose `fileId` is absent
  from the incoming manifest (`app.ts`, commit handler). Therefore a plugin
  that commits before pulling **deletes every web-created or web-edited file**
  it has not yet seen. The pull phase must run first, in the same
  `reconcile()` pass, and must be regression-tested.
- **I2 — Byte fidelity.** Opening a note in the web editor and saving it with
  no keystrokes must produce byte-identical content, therefore an identical
  SHA-256, therefore no revision at all. Enforced by a test over the
  `@tephra/test-fixtures` vault.
- **I3 — Blobs stay immutable and verified.** A web save goes through the same
  hash-then-store path as `PUT /blobs/:hash`: the server hashes the received
  bytes itself and never trusts a client-supplied digest.
- **I4 — No content in logs.** `logContext` may carry `file_id`, `revision`,
  `blob_hash`, and byte counts. Never note text, never tokens.
- **I5 — Local bytes are never silently destroyed.** Any pull that overwrites
  a locally-modified file writes the local version to a conflicted copy first.
  Remote bytes need no equivalent rule: blobs are immutable and every revision
  is retained in `file_versions`.
- **I6 — Sanitization is unchanged.** Editor content is markdown text. The
  rendered path still goes through the server renderer plus
  `containServerHtml` in `NoteViewer.tsx`. The editor never renders untrusted
  HTML.
- **I7 — Writes need an explicit scope.** A new `vault:write` token scope
  gates the write endpoint. Existing `vault:upload` tokens do **not** acquire
  web-write ability implicitly. Session principals (the vault owner) satisfy
  `vault:write` the same way they satisfy `vault:read-metadata` today.
- **I8 — Path canonicality is unchanged.** `canonicalVaultPathSchema` still
  governs every path. Phase 1 writes never change a file's path.

## 4. Editor component

### 4.1 Package layout

New workspace package `tephra-server/packages/markdown-editor/`, matching
`@tephra/graph-renderer` exactly in shape (it is already covered by the
`tephra-server/packages/*` workspace glob in the root `package.json`):

```
packages/markdown-editor/
  package.json          # name @tephra/markdown-editor, private, type module
  tsconfig.json
  src/index.ts          # React surface: <TephraEditor />
  src/pure.ts           # framework-free logic, no DOM, no CodeMirror
  src/editor.ts         # CodeMirror 6 EditorView construction + extensions
  src/extensions.ts     # markdown language, keymap, theme wiring
  src/session.ts        # per-file state cache (doc, selection, undo history)
  src/dirty.ts          # dirty tracking + save gating
  tests/*.test.ts       # vitest; pure.ts/dirty.ts/session.ts need no jsdom
```

`package.json` mirrors graph-renderer: `main`/`types`/`exports` pointing at
`dist`, `build: "tsup src/index.ts src/pure.ts --format esm --dts --clean"`,
`typecheck: "tsc --noEmit"`, `test: "vitest run"`, React 18/19 as
`peerDependencies`, React + jsdom + tsup + typescript as `devDependencies`.

Add `@tephra/markdown-editor` to `@tephra/web`'s `dependencies` and to its
`prebuild` script alongside `@tephra/protocol` and `@tephra/graph-renderer`.

The `pure.ts` / `index.ts` split is deliberate and matches graph-renderer:
conflict decisions and dirty tracking are pure functions, unit-testable
without a DOM, and reusable by the plugin side if needed.

### 4.2 Library choice: CodeMirror 6 — and why not a WYSIWYG editor

**Chosen:** CodeMirror 6 —
`@codemirror/state`, `@codemirror/view`, `@codemirror/commands`,
`@codemirror/language`, `@codemirror/search`,
`@codemirror/lang-markdown` (6.5.2), `@lezer/markdown` (1.7.2) for GFM
extensions. Verified current on npm as of 2026-09-16;
`@codemirror/lang-markdown` sits at ~4.5M weekly downloads and
`@codemirror/view` was last published 2026-09-15.

Rationale, in priority order:

1. **The document is the markdown string.** CodeMirror edits text directly.
   There is no AST round-trip, so `open → save` with no edits is byte-exact
   (invariant I2) and an edit to line 40 cannot perturb line 900.
2. **This is load-bearing here specifically.** The plugin will _overwrite
   local vault files_ with whatever the server holds. An editor that
   reserializes through an AST would rewrite untouched parts of the file, and
   the plugin would then push that rewrite into the user's real vault.
   Published round-trip audits of ProseMirror-based markdown editors report
   exactly this class of damage — CRLF documents silently rewritten to LF,
   nested code fences, escaped pipes in table cells, runs of blank lines and
   tab-indented list continuations degrading on _every_ save, and table
   alignment, raw HTML, and HTML entities losing content on the _first_ save.
   Obsidian vaults are full of the constructs in that list (callouts, embedded
   code fences, Dataview blocks, raw HTML, frontmatter), so the failure mode is
   not hypothetical.
3. **Obsidian itself is CodeMirror 6.** Editing feel, keymaps, and selection
   behaviour match the app users are mirroring, at no extra cost.
4. **Large notes stay fast** — CM6's virtual viewport renders only visible
   lines.
5. **Frontmatter and wikilinks survive untouched** because nothing parses and
   re-emits them.

**Rejected alternatives**, recorded so this is not re-litigated:

| Option                          | Verdict                                                                                                                                                                                                                                                                                  |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@milkdown/crepe` 7.22.1        | Batteries-included and genuinely nice, but (a) the AST re-serialization problem above, and (b) it pulls Vue 3, DOMPurify, and KaTeX into a React app — a second framework in the bundle.                                                                                                 |
| `tiptap`                        | Same ProseMirror re-serialization problem; markdown is not its native document model, so a serializer must be hand-built — which _is_ "writing a markdown editor from scratch", just in the worst place.                                                                                 |
| `@latentic/live-markdown` 0.4.2 | Closest thing to what we eventually want (CM6 + inline rendering, markdown string as the document), but first published 2026-08-23 at ~485 weekly downloads. Too young to sit under a core write path. **Re-evaluate for Phase 5** — if it matures it is the natural live-preview layer. |
| `@uiw/react-codemirror` 4.25.11 | Battle-tested (~3.3M weekly) React glue, but its controlled-`value` model fights the per-file undo-history cache in §4.4, and it bundles its own `basicSetup`. The ~80-line lifecycle wrapper we own is cheaper than working around it.                                                  |

We are not writing an editor. CodeMirror 6 plus `@codemirror/lang-markdown`
_is_ the library; what we own is roughly 200 lines of wiring.

### 4.3 React surface

```ts
export interface TephraEditorProps {
  /** Stable key for session caching — use the vault file id. */
  docKey: string;
  /** Initial markdown. Changing `baseText` for the same docKey is a reload. */
  baseText: string;
  readOnly?: boolean;
  /** Fired on every change with the current dirty state. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Cmd/Ctrl+S and the toolbar both route here. */
  onSave?: (text: string) => void | Promise<void>;
  theme?: 'light' | 'dark';
}
export function TephraEditor(props: TephraEditorProps): JSX.Element;
```

The component owns one `EditorView` for its lifetime and reconciles props into
it imperatively — the same pattern `TephraGraph.tsx` uses over the imperative
renderer. It does not re-create the view on every render.

### 4.4 Per-file session cache (`session.ts`)

Keyed by `docKey`, holds `{ doc, selection, scrollTop, historyState }`.
Switching notes and coming back restores cursor, scroll, and undo history.
Cache is memory-only, capped (LRU, 20 entries), and dropped on vault change.

### 4.5 Dirty tracking (`dirty.ts`, pure)

```ts
export function isDirty(baseText: string, currentText: string): boolean;
export function shouldSave(state: {
  baseText: string;
  currentText: string;
  saving: boolean;
}): boolean;
```

`shouldSave` returns `false` when the text is unchanged — this is the
client-side half of invariant I2. The server-side half is that identical bytes
hash identically, so no revision is created regardless.

### 4.6 Conflict decision (`pure.ts`)

The timestamp rule lives here as a pure function, shared by the web client and
(logically) the plugin:

```ts
export type ConflictOutcome = 'remote-wins' | 'local-wins' | 'identical';
export function resolveConflict(input: {
  localHash: string;
  localMtime: number;
  remoteHash: string;
  remoteMtime: number;
}): ConflictOutcome;
```

Rules: equal hashes → `identical`; `remoteMtime > localMtime` →
`remote-wins`; otherwise (including exact ties) → `local-wins`. Ties resolve
local because the local vault is the declared source of truth and browser /
desktop clock skew is the likeliest cause of a tie.

## 5. Server write path

### 5.1 New endpoint

```
PUT /api/v1/vaults/:vaultId/files/:fileId/content
  Authorization: session cookie, or Bearer token with `vault:write`
  If-Match: "<baseBlobHash>"          # required, sha256 hex of the loaded content
  Content-Type: text/markdown; charset=utf-8
  X-Tephra-Content-Size: <bytes>      # mirrors X-Tephra-Blob-Size on blob upload
  body: raw UTF-8 markdown bytes
→ 200 { status: 'committed', revision, blobHash, size, mtime }
→ 409 { error: { code: 'EDIT_CONFLICT', ... }, current: { blobHash, size, mtime, revision } }
→ 400 INVALID_MANIFEST   (bad size header, non-markdown file, size mismatch)
→ 403 VAULT_ACCESS_DENIED
→ 413 BLOB_TOO_LARGE     (same `maxBlobBytes` limit as blob upload)
```

`If-Match` is required, not optional: a client that cannot say what it based
its edit on has no business overwriting the file.

### 5.2 Handler algorithm

1. `ownedVault(c, dependencies, 'vault:write')`; `findFile(c)`; reject
   `kind !== 'markdown'` with `400 INVALID_MANIFEST`.
2. Read the body; validate declared vs. actual byte length (copy the existing
   checks in the `PUT /blobs/:hash` handler); enforce `maxBlobBytes`.
3. `const hash = await sha256Hex(bytes)` — server-computed (I3).
4. If `hash === file.blobHash`, return `200 { status: 'up-to-date',
revision: vault.latestRevision, blobHash: hash, ... }` and create nothing
   (I2).
5. Store the blob if absent, exactly as the blob-upload handler does
   (`blobStore.put` + `blobs.insert`).
6. Open `database.transaction`, `lockVault(vaultId)`, re-read the file.
   - If `file.blobHash !== ifMatch` → `409 EDIT_CONFLICT` with the current
     state. (Re-read inside the lock; the pre-lock read in step 1 is only for
     validation.)
7. `mtime = Math.max(clock.now(), file.mtime + 1)` — a web edit must strictly
   post-date the content it was based on, so the §7 timestamp rule cannot be
   inverted by a server clock that lags a device clock.
8. Compute the new full-vault manifest hash: take
   `vaultFiles.listByVault(vaultId)`, substitute this file's new
   `{hash, size, mtime}`, and call `hashManifest()` from `@tephra/protocol`.
   Reusing the canonical hash keeps `vault_revisions.manifest_hash` meaningful
   for both writers.
9. Insert `vault_revisions` with `revision = vault.latestRevision + 1` and a
   synthetic device (see §5.4).
10. Insert one `file_versions` row via `diffRevision` — pass the current file
    list as `current` and the substituted list as `incoming`, so the ledger is
    produced by the same code path as a plugin commit rather than a
    hand-written row. It will emit exactly one `modify`.
11. `vaultFiles.upsert` the new `{blobHash, size, mtime, updatedRevision}`;
    `vaults.update` the new `latest_revision`.
12. After the transaction, `void dependencies.indexService?.indexVault(...)`
    and delete the `vault_graph_cache` row for the vault (the existing
    post-commit behaviour — reuse it, do not duplicate it).

### 5.3 Migration 005 — relax `UNIQUE(vault_id, manifest_hash)`

`vault_revisions` today declares `UNIQUE(vault_id, manifest_hash)`, and both
`/sync/plan` and `/sync/commit` use `findByManifestHash` as an idempotency
short-circuit ("this exact vault state was already committed → up-to-date").

That breaks under web editing. Edit a note, then edit it back: the resulting
vault state — and therefore its manifest hash — equals an earlier revision's,
and the insert in step 9 hits the unique constraint. Every workaround that
keeps the constraint (fake salt in the hash, skipping the revision, not
bumping `latest_revision`) leaves `vault_files` and `latest_revision`
disagreeing about what the vault contains.

**Resolution:** `migrations/sqlite/005_revision_manifest_hash_index.sql`
rebuilds `vault_revisions` with the `UNIQUE(vault_id, manifest_hash)` table
constraint replaced by a plain index
`vault_revisions_manifest_idx(vault_id, manifest_hash)`, and
`VaultRevisionRepository.findByManifestHash` changes to return the **newest**
revision carrying that hash.

Idempotency is preserved: a retried plugin commit finds the revision it just
created (now the newest with that hash) and still short-circuits to
`up-to-date`. What becomes possible is a _later_ revision legitimately
reproducing an _earlier_ vault state.

Cost and risk, stated plainly:

- SQLite cannot drop a table constraint in place; this is a 12-step table
  rebuild (`PRAGMA foreign_keys=OFF` → create `vault_revisions_new` → copy →
  drop → rename → recreate indexes → `foreign_keys=ON` → `foreign_key_check`).
  `file_versions` has a composite FK onto `(vault_id, revision)`, so the
  rebuild order matters and `foreign_key_check` must pass before commit.
- Follow the precedent and discipline of `003_vault_files_path_fold.sql`,
  including its comment style explaining why the migration exists.
- Verify against copies of real databases at `user_version` 1, 2, 3, and 4
  before deploying, the way 003 was verified.
- **Rollback:** forward-only. The relaxed index accepts every row the unique
  constraint accepted, so a rollback of application code onto a v5 database is
  safe; only re-tightening the constraint is not.

### 5.4 Synthetic web device

`vault_revisions.device_id` is `NOT NULL REFERENCES devices(id)`. Web saves
have no plugin device. On first web write, insert (idempotently) a device
`web:<userId>` with `name: 'Tephra Web'`, `platform: 'web'`, owned by the
session user, and reuse it thereafter. This keeps the FK honest and makes web
revisions legible in `file_versions` history and in the connected-clients UI.

### 5.5 New scope `vault:write`

- `@tephra/vault-model`: add `'vault:write'` to `ApiTokenScope`.
- `app.ts`: add it to `scopesSchema`'s enum. Do **not** add it to the default
  scope array — existing and newly provisioned plugin tokens stay
  `['vault:read-metadata', 'vault:upload']`.
- `@tephra/auth`: `canAccessVault` already takes a `requiredScope`; session
  principals bypass scope checks (owner access), so no change is needed
  beyond the type.

## 6. `GET /changes` — the pull feed

### 6.1 The delta ledger already exists

No new delta format is needed. `file_versions` already records, per revision,
one append-only row per changed file with `changeType` in
`create | modify | rename | delete`, written by `diffRevision` on every
commit. Web saves join that same ledger (§5.2 step 10). The only missing piece
is a way to _read_ it forward from a revision.

### 6.2 Endpoint

```
GET /api/v1/vaults/:vaultId/changes?since=<revision>&limit=<n>
  scope: vault:read-metadata
→ 200 {
    status: 'ok',
    fromRevision: number,       // echo of `since`
    toRevision: number,         // highest revision included
    latestRevision: number,     // vault.latest_revision
    truncated: boolean,         // toRevision < latestRevision
    changes: Array<{
      fileId: string;
      changeType: 'create' | 'modify' | 'rename' | 'delete';
      path: string;             // final path at toRevision
      previousPath?: string;    // set when the net effect includes a rename
      blobHash?: string;        // absent for delete
      size?: number;
      mtime?: number;
      kind: 'markdown' | 'attachment';
      revision: number;         // revision of the last event for this file
    }>
  }
→ 200 { status: 'full-resync-required', latestRevision }
```

`full-resync-required` is returned when `since > latestRevision` (client ahead
— impossible but defend against it) or `since` predates retained history. The
plugin's fallback is the already-implemented `listFiles()` path.

### 6.3 Net-effect collapsing

Between `since+1` and `toRevision` a single file may have several rows
(`rename` and `modify` at the same revision, several modifies across
revisions). The response carries **one entry per `fileId`**, collapsed:

- `create` then later rows → `create`, with the final path/hash.
- `create` … `delete` → omit the file entirely (it never existed for this
  client).
- `rename` and `modify` → one entry, `changeType: 'modify'`, with
  `previousPath` set and the final path in `path`.
- any … `delete` → `delete`, path = the path the file last had.
- Files whose net `blobHash` equals what the client already has are still
  emitted; the plugin skips them cheaply by hash comparison.

Implement collapsing as a **pure function in `@tephra/core`**
(`collapseFileVersions(rows, { since }): ChangeEntry[]`) with table-driven
unit tests, not inline in the handler.

`limit` defaults to 500 and caps at 2000, applied by **revision boundary**
(never split a revision across pages) so a paged pull is always applied at a
consistent vault state.

### 6.4 New repository method

`FileVersionRepository` gains:

```ts
listSince(vaultId: string, sinceRevision: number, limit: number): Promise<FileVersion[]>;
```

ordered by `(revision, id)`. The existing index
`file_versions_revision_idx(vault_id, revision)` already serves it — no new
index needed. Implement on `@tephra/database-sqlite` and on the in-memory test
double.

### 6.5 Protocol changes

In `@tephra/protocol`:

- `changeEntrySchema`, `changesResponseSchema`, and the inferred types.
- `PROTOCOL_VERSION` `'1'` → `'2'`.
- `MINIMUM_PLUGIN_VERSION` `'0.1.0'` → `'0.2.0'`.
- bump `PLUGIN_VERSION` in `tephra-plugin/src/api/client.ts` and the plugin
  `package.json`/`manifest.json` to `0.2.0` in lockstep.

Compatibility: an old (0.1.x) plugin against a new server never calls
`/changes`, so it keeps working as a push-only client — but it will **delete
web edits** on its next commit (I1). Therefore
`MINIMUM_PLUGIN_VERSION = '0.2.0'` must be enforced, and `isSupportedPluginVersion`
already gates on it; confirm `syncClientVersions` actually _rejects_ rather
than only logging, and add a test that a `0.1.0` plugin is refused at
`/sync/commit` once the vault has ever received a web write.

## 7. Plugin pull phase and conflict resolution

### 7.1 Where it goes

New `src/sync/puller.ts`, driven from `SyncCoordinator.reconcile()` as the
first step after the settings/binding guards and **before**
`this.options.scanner.scan()`:

```
reconcile():
  guards (enableSync, serverUrl/vaultId/token/deviceId)
  vault binding canonicalization      [existing]
→ pull()                              [NEW]
  scan()                              [existing]
  plan() / repairAndReplan()          [existing]
  uploadMissingBlobs()                [existing]
  commit()                            [existing]
```

Add `'pulling'` to `SyncPhase` and surface it in `ui/status.ts`.

Placing pull before scan is invariant I1. Add a coordinator test that fails if
the order is swapped: given a server-only file and a local vault without it,
one `reconcile()` must leave the file present both locally and on the server.

### 7.2 Algorithm

1. Skip entirely when `state.lastRemoteRevision === undefined` (first sync —
   the existing empty-vault/repair logic owns that case).
2. `GET /changes?since=state.lastRemoteRevision`.
   - `full-resync-required` → set `state.identityRepairNeeded = true` and
     return; the existing `repairAndReplan` path handles it.
3. For each collapsed change, decide with `state.manifest[path]` (the last
   synced state) and the live vault file:

   | Local since last sync        | Remote change | Action                                                                         |
   | ---------------------------- | ------------- | ------------------------------------------------------------------------------ |
   | unchanged                    | modify/create | download blob, write file, suppress the echo event                             |
   | unchanged                    | delete        | delete the local file                                                          |
   | unchanged                    | rename        | `vault.rename` local file                                                      |
   | changed, same hash as remote | any           | no-op (converged independently)                                                |
   | changed                      | modify/create | `resolveConflict()` → §7.3                                                     |
   | changed                      | delete        | **local wins**: keep the local file; the next commit re-creates it server-side |
   | missing locally              | modify/create | create the file (plus parent folders)                                          |

   "unchanged" means the live file's hash equals `state.manifest[path].hash`.
   Reuse `scanCache` for the mtime+size fast path rather than re-hashing every
   file.

4. Set `state.lastRemoteRevision = toRevision` and update `state.manifest`
   entries for applied files, then `saveState()`.
5. If `truncated`, request another pull pass immediately (the
   `SerializedReconciler` already coalesces repeat requests).

### 7.3 Conflict resolution — last-write-wins with a conflicted copy

Both sides changed the same file since `lastRemoteRevision`. Decide with
`resolveConflict()` (§4.6):

- **`remote-wins`** (`remoteMtime > localMtime`):
  1. Write the current local content to
     `<dir>/<basename> (conflicted copy <deviceName> <YYYY-MM-DDTHH-mm-ss>).md`.
  2. Overwrite the original with the remote content.
  3. Both files are ordinary vault files, so the next commit pushes the
     conflicted copy to the server and the user sees it in Obsidian.
- **`local-wins`** (including exact mtime ties): leave the local file alone.
  The following scan→commit pushes it, and the superseded remote content stays
  recoverable via `file_versions` + immutable blobs.
- **`identical`**: no-op.

This is invariant I5. It is also why LWW is acceptable at this stage: the rule
is crude, but the loser is always still on disk or still in the ledger.

**Known weakness, documented rather than solved:** LWW is only as good as the
clocks. A desktop clock running behind the server can let an older local edit
win. §5.2 step 7 (`mtime = max(serverNow, file.mtime + 1)`) removes the common
case — a web edit always post-dates the content it was based on — but does not
remove arbitrary skew. Conflicted copies are the safety net. Revisit if users
report losses.

### 7.4 Echo suppression

`main.ts` already tracks `suppressedModify: Set<string>` and consults it in
the `vault.on('modify')` handler. The puller must add each path it writes to
that set immediately before writing, so applying a remote change does not
enqueue a local modify event and cause a pointless extra sync round. Extend
the same mechanism to `create` and `delete`/`rename` events, which currently
have no suppression.

### 7.5 Plugin client additions

`TephraClientLike` gains:

```ts
changes(sinceRevision: number, limit?: number): Promise<ChangesResponse>;
readContent(fileId: string): Promise<Uint8Array>;   // GET /files/:fileId/content
```

`readContent` uses `requestUrl` with `arrayBuffer`, and must verify the
downloaded bytes hash to the `blobHash` the changelog advertised before
touching the vault (client-side half of I3).

## 8. Web integration

### 8.1 API client (`apps/web/src/api/client.ts`)

```ts
saveContent = (vaultIdOrName: string, fileId: string, text: string, baseBlobHash: string) =>
  Promise<SaveContentResponse>;
```

Sends `PUT …/files/:fileId/content` with `If-Match`, `X-Tephra-Content-Size`,
`Content-Type: text/markdown; charset=utf-8`, and the existing CSRF header
logic (`fetchRaw` already applies it to non-GET methods). A `409` surfaces as
an `ApiError` whose body carries `current` — extend `fetchRaw`'s error path to
preserve the extra field, or read it via a dedicated branch.

### 8.2 `NoteViewer.tsx` — a third mode

`NoteViewer` today toggles `raw` between rendered HTML and a `<pre>` source
view. Replace that boolean with a three-way mode: `rendered | source | edit`,
keeping the existing icon-button toolbar idiom and `lucide-react` icons
(`Eye`, `Code`, `Pencil`).

- Entering `edit` needs both the source text and its `blobHash`. The
  workspace already holds the `VaultFile` (with `blobHash`) from
  `api.files()`, and `ResolveResponse.file` carries it too — pass it down
  rather than adding a request.
- Save: `Cmd/Ctrl+S` or a Save button → `api.saveContent(...)` → on success,
  update the stored base text and `blobHash` from the response, then refresh
  the rendered view and the links panel (the note's links may have changed).
- `409 EDIT_CONFLICT` → a banner offering **Reload** (discard local edits),
  **Overwrite** (re-`PUT` with the server's current hash as `If-Match`), and
  **Save as copy** (deferred to Phase 5 — it needs file creation; until then
  the banner offers Reload and Overwrite and tells the user their text is
  still in the editor).
- Warn on navigation away while dirty, via the existing router (`useBeforeUnload`
  for tab close and a confirm in the workspace's `onOpen` handler).
- Read-only when `vault` metadata says the principal lacks write access.

### 8.3 Styling

Add an `.note-editor` block to `apps/web/src/styles.css` next to
`.note-view` / `.raw-source`, and drive the CodeMirror theme from the existing
`ThemeContext` so the editor follows the app's light/dark selection rather
than shipping its own toggle.

## 9. Ordered implementation phases

Phases 1 and 2 have disjoint file ownership and can run in parallel. Phase 3
needs 1+2; Phase 4 needs 2.

### Phase 0 — Groundwork (blocking, small)

- [ ] `AGENTS.md`: replace the "read-only web mirror / never add web-to-vault
      writes" rule with a pointer to this plan; keep the third-party-plugin
      prohibition.
- [ ] `README.md`: drop "intentionally provides no web editing or
      server-to-vault writeback"; move browser editing and two-way sync from
      "Where Tephra is headed" into what Tephra does (once Phase 4 lands).
- [ ] `@tephra/protocol`: `changeEntrySchema`, `changesResponseSchema`,
      `saveContentResponseSchema`; `PROTOCOL_VERSION = '2'`;
      `MINIMUM_PLUGIN_VERSION = '0.2.0'`. Add `'EDIT_CONFLICT'` to
      `apiErrorCodeSchema`.
- [ ] `@tephra/vault-model`: `'vault:write'` in `ApiTokenScope`.

**Verify:** `npm run typecheck`, `npm run test --workspace=@tephra/protocol`.

### Phase 1 — `@tephra/markdown-editor`

- [ ] Scaffold the package (§4.1); wire into `@tephra/web` deps + `prebuild`.
- [ ] `editor.ts` / `extensions.ts`: `EditorView` with markdown language, GFM,
      history, `defaultKeymap`, `searchKeymap`, a save keybinding, and a theme
      bound to a `light | dark` prop.
- [ ] `session.ts`, `dirty.ts`, `pure.ts` (`resolveConflict`).
- [ ] `index.ts`: `TephraEditor`.
- [ ] Tests: dirty/save gating; session save-restore; `resolveConflict` table;
      **byte-fidelity round-trip over every markdown file in
      `@tephra/test-fixtures/vault`** (load → read back → assert identical
      bytes) — invariant I2.

**Verify:** `npm run build --workspace=@tephra/markdown-editor`,
`npm run test --workspace=@tephra/markdown-editor`.

### Phase 2 — Server write path

- [ ] Migration `005_revision_manifest_hash_index.sql` (§5.3) +
      `findByManifestHash` → newest-wins, in core, sqlite, and the test
      double.
- [ ] `PUT …/files/:fileId/content` handler (§5.2), synthetic web device
      (§5.4), `vault:write` in `scopesSchema` (§5.5).
- [ ] Factor the shared blob-store-and-record logic out of the
      `PUT /blobs/:hash` handler so both writers use one path (I3).
- [ ] Tests in `apps/api/tests/`: happy path creates exactly one revision and
      one `file_versions` `modify` row; unchanged bytes create nothing (I2);
      stale `If-Match` → 409 with `current`; non-markdown → 400; oversized →
      413; `vault:upload`-only token → 403 (I7); mtime strictly greater than
      the previous file mtime; edit-then-revert produces a _new_ revision
      (the §5.3 case); concurrent saves serialize under `lockVault`.
- [ ] Migration test: v1→v5, v2→v5, v3→v5, v4→v5 on real database copies,
      with `foreign_key_check` clean.

**Verify:** `npm run test --workspace=@tephra/api`, plus the live-DB migration
check on copies.

### Phase 3 — Web editing UI

- [ ] `api.saveContent` (§8.1), including 409 body passthrough.
- [ ] `NoteViewer` three-way mode, save, dirty guard, conflict banner (§8.2).
- [ ] `.note-editor` styles + theme binding (§8.3).
- [ ] Tests in `apps/web/tests/note-viewer.test.tsx`: mode switching; save
      sends the right `If-Match`; 409 renders the banner and Overwrite retries
      with the server hash; dirty navigation is guarded; read-only hides Save.
- [ ] Playwright: open a note, edit, save, reload, assert the new content
      renders.

**Verify:** `npm run test --workspace=@tephra/web`, `npm run test:e2e --workspace=@tephra/web`.

### Phase 4 — `/changes` + plugin pull

- [ ] `collapseFileVersions` in `@tephra/core` + table-driven tests (§6.3).
- [ ] `FileVersionRepository.listSince` in core, sqlite, test double (§6.4).
- [ ] `GET …/changes` handler with revision-boundary paging (§6.2).
- [ ] Plugin: `client.changes()`, `client.readContent()` with hash
      verification (§7.5).
- [ ] Plugin: `src/sync/puller.ts` (§7.2), `'pulling'` phase, status string.
- [ ] Coordinator: call `pull()` before `scan()`; extend echo suppression to
      create/delete/rename (§7.4).
- [ ] Conflicted-copy writer (§7.3).
- [ ] Tests: collapsing (create+delete → omitted; rename+modify → one modify
      with `previousPath`); paging never splits a revision; `since` ahead of
      latest → `full-resync-required`; **pull-before-commit ordering (I1)**;
      each row of the §7.2 decision table; `remote-wins` writes a conflicted
      copy before overwriting (I5); mtime tie → local wins; a `0.1.0` plugin
      is refused at commit.
- [ ] `e2e/sync-vault.mjs`: extend the existing harness with a round trip —
      plugin push → web edit → plugin pull → assert local file content.

**Verify:** `npm run check` (lint + typecheck + build + all workspace tests),
then the e2e sync harness.

### Phase 5 — Follow-ups (not in this plan's completion bar)

- Create / rename / delete from the web (`POST`, `PATCH`, `DELETE` on
  `…/files`), which also unlocks "Save as copy" in the conflict banner.
- Live-preview decorations in `@tephra/markdown-editor` — reconsider
  `@latentic/live-markdown` if it has matured; must not change persisted bytes.
- Attachment upload from the web.
- Server-push change notification (SSE/WebSocket) to replace the plugin's
  `RECONCILIATION_INTERVAL_MS` polling for web-originated edits.

## 10. Affected files and ownership

| Owner   | Files                                                                                                                                                                                                                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Phase 0 | `AGENTS.md`, `README.md`, `packages/protocol/src/index.ts`, `packages/vault-model/src/index.ts`                                                                                                                                                                                                         |
| Phase 1 | `packages/markdown-editor/**` (new), `apps/web/package.json` (deps + prebuild only)                                                                                                                                                                                                                     |
| Phase 2 | `migrations/sqlite/005_*.sql`, `apps/api/src/app.ts`, `packages/database/core/src/index.ts`, `packages/database/sqlite/src/**`, `apps/api/tests/**`                                                                                                                                                     |
| Phase 3 | `apps/web/src/api/client.ts`, `apps/web/src/api/types.ts`, `apps/web/src/components/NoteViewer.tsx`, `apps/web/src/routes/VaultWorkspace.tsx`, `apps/web/src/styles.css`, `apps/web/tests/**`, `apps/web/e2e/**`                                                                                        |
| Phase 4 | `packages/core/src/index.ts`, `packages/database/**`, `apps/api/src/app.ts` (new route only), `tephra-plugin/src/api/client.ts`, `tephra-plugin/src/sync/puller.ts` (new), `tephra-plugin/src/sync/coordinator.ts`, `tephra-plugin/src/main.ts`, `tephra-plugin/src/ui/status.ts`, `e2e/sync-vault.mjs` |

Phase 2 and Phase 4 both touch `apps/api/src/app.ts`. Sequence them (2 before 4) or keep Phase 4's edit to an appended route block to avoid a conflict.

## 11. Compatibility, deployment, rollback

- **Protocol:** `1` → `2`; minimum plugin `0.1.0` → `0.2.0`. Ship the server
  first; a 0.1.x plugin then fails `/sync/commit` with a clear message rather
  than silently deleting web edits. Call this out in release notes — users
  must update the plugin.
- **Database:** migration 005 rebuilds `vault_revisions`. Back up before
  deploying. Forward-only (§5.3). Verify on copies of production databases at
  every prior `user_version`, as was done for 003.
- **Blobs:** additive. Web saves create new immutable blobs; existing blob GC
  (`apps/api/src/blob-gc.ts`) must be checked to confirm it treats
  `vault_files.blob_hash` plus `file_versions.blob_hash` as roots — otherwise
  it could collect the pre-edit blob a conflicted copy still needs.
- **Graph/index cache:** web writes must trigger `indexVault` and drop the
  `vault_graph_cache` row, or the graph silently serves stale data. Covered in
  §5.2 step 12; add an assertion to the Phase 2 tests.
- **Rollback of app code:** safe at any phase boundary. A server rolled back
  to pre-Phase-2 simply has no write endpoint; the web app's Save then fails
  with 404 and notes remain readable.

### 11.1 Top risks

1. **Pull/commit ordering (I1).** Highest-severity failure in the plan: get it
   wrong and a plugin sync deletes the user's web edits. Mitigated by an
   ordering regression test.
2. **Migration 005 table rebuild.** A botched rebuild loses revision history.
   Mitigated by `foreign_key_check`, real-database dry runs, and a backup.
3. **Clock skew under LWW.** Mitigated, not solved: monotonic web mtimes plus
   conflicted copies (§7.3).
4. **Blob GC collecting still-referenced pre-edit blobs.** Mitigated by
   auditing the GC roots in Phase 2.

## 12. Completion checklist

- [ ] `AGENTS.md` and `README.md` no longer describe Tephra as read-only.
- [ ] `@tephra/markdown-editor` builds standalone and passes its byte-fidelity
      round-trip test over the fixture vault.
- [ ] A markdown note can be edited and saved from the web app; the save
      produces exactly one revision and one `file_versions` row.
- [ ] Saving unmodified content produces no revision.
- [ ] A stale save is rejected with `409 EDIT_CONFLICT` and the UI offers
      Reload / Overwrite.
- [ ] `GET /changes?since=N` returns correctly collapsed net-effect entries
      and pages on revision boundaries.
- [ ] The plugin pulls remote changes into the local vault **before** scanning,
      with a test that fails if the order is reversed.
- [ ] Both-sides-changed resolves by mtime, and a `remote-wins` resolution
      leaves a conflicted copy on disk.
- [ ] A 0.1.x plugin is refused at `/sync/commit`.
- [ ] Migration 005 verified on real database copies from every prior
      `user_version`, `foreign_key_check` clean.
- [ ] Blob GC roots audited against `file_versions`.
- [ ] `npm run check` green.
- [ ] `e2e/sync-vault.mjs` round trip (push → web edit → pull) green.
- [ ] `PROGRESS.md` updated with what was verified.
- [ ] This plan deleted once fully implemented and committed (per the
      `planning` skill lifecycle).
