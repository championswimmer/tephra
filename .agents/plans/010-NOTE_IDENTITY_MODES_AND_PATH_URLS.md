# Note identity modes and path-addressed URLs

> **Status:** implementation plan
> **Target:** `.agents/plans/010-NOTE_IDENTITY_MODES_AND_PATH_URLS.md`
> **Depends on:** `001-TEPHRA_STAGE1_PLAN.md`, `007-REIMAGINED_OBSIDIAN_PLUGIN.md`
> **Packages:** `tephra-plugin`, `tephra-server` (api, web, protocol, database, vault-model, link-resolver, indexer)
> **Compatibility:** none required — Tephra is pre-launch (§3.1)
> **Last updated:** 2026-09-08

---

## 1. Context and user outcome

Today every Markdown file in a synced vault gets a `tephra-file-id` YAML property written into it
(`tephra-plugin/src/sync/scanner.ts:8`, written via `app.fileManager.processFrontMatter` with a raw-text
injection fallback for invalid YAML). That is the plugin's only vault write. It works, but it is invasive:

- it mutates files the user never asked Tephra to touch,
- it pollutes the Obsidian Properties panel on every note,
- it dirties git history and other sync tools' diffs,
- it fights Templater placeholders and pre-existing invalid YAML (hence the fallback path),
- and there is currently **no way to undo it** — a user who stops using Tephra is left with the property
  in every note.

**Outcomes of this plan:**

1. A user can remove every `tephra-file-id` from their vault, from the plugin, with an explicit
   destructive confirmation (§10).
2. A user can choose *how* Tephra remembers note identity: in frontmatter, in a sidecar cache, or not at
   all — with the tradeoffs stated in the UI (§7–§9, §11).
3. Notes are addressable in the web app by their vault-relative path
   (`user.tephra.com/<vault>/#/path/to/file.md`), shareable as links, resolving identically whether the
   vault was synced from macOS, Linux, or Windows (§13–§14).

Requirement (3) is not cosmetic: it is what makes (1) and (2) safe to ship. While the web app addresses
notes by `fileId`, any change in identity breaks every URL a user has bookmarked or shared. Once URLs are
paths, an identity change costs only history continuity. **Path addressing must ship before, or in the
same release as, the mode switch.**

---

## 2. Product decisions

| Decision | Resolution |
| --- | --- |
| Can `hash(path, content)` be the identity? | **No.** It is a rename *matching* heuristic only. Identity is a minted opaque id (§5). |
| Where does the id live in the new mode? | `.tephra/data.json` at the vault root, holding only `path → fileId` (§7). |
| Is the sidecar the source of truth? | **No — it is a cache.** The server's `vault_files` table is the identity authority (§9). |
| Is the sidecar in the sync manifest? | Excluded, structurally (a dot-directory is not a `TFile`) and by `shouldSyncPath` (`scanner.ts:14`). |
| How do multiple devices agree on ids? | Client-side repair from the existing `GET /api/v1/vaults/:vaultId/files`. No protocol change (§9). |
| Server rewrites provisional ids to canonical ones? | **Rejected** — it destroys the client's ability to predict `manifestHash` and makes the server identity-stateful (§9.1). |
| Backwards compatibility | **Not a constraint.** Pre-launch: edit `001_initial.sql` in place, redefine the protocol freely, ship no migrations (§3.1). |
| Id minting | Path-seeded `sha256(vaultId \0 path)`, random-UUID fallback on collision (§6). |
| Modes offered | **A** frontmatter · **B** sidecar (default for new installs) · **C** path identity (§11). |
| Is the mode recorded server-side? | **No.** The server stays identity-agnostic (§11.2). |
| Path lookup mechanism | Query the `path` column directly. **Do not hash the path** (§13.1). |
| Path resolver transport | Query parameter, not a wildcard route — a wildcard route would log note paths (§13.3). |
| Canonical path form | NFC, case-preserving, matched case-sensitively (§14). |
| Old-path links after a rename | Resolved from `file_versions`; current state always beats history (§13.4). |

---

## 3. Scope and non-goals

### In scope

- Plugin: a destructive "Remove Tephra IDs from notes" sweep with preview and confirmation.
- Plugin: an `identityMode` setting with three modes, per-mode help text, and dry-run migrations both ways.
- Plugin: a sidecar identity cache, a pure identity matcher, durable rename hints, and server repair.
- Plugin: NFC normalization of paths at the scanner boundary.
- Server: an additive path-resolution endpoint with case/normalization/history fallbacks.
- Server: NFC canonicalization enforced at the protocol edge and on ingest.
- Server: fix the cross-vault `fileId` steal properly, with a composite primary key (§15.1) — a
  prerequisite for path-seeded minting.
- Web: hash-routed path URLs, canonical-URL rewriting, and a "moved from" hint.
- Plugin: fix the `EventBuffer` rename-chain loss (`event-buffer.ts:17`) and the non-durable rename hints.

### Non-goals

- Web-to-vault writes, merging, or plugin execution (Stage 1 constraint, `AGENTS.md`).
- Vault subdomain/slug addressing (`/<vaultname>/`) — sketched in §13.6, needs its own plan.
- Similarity-based rename detection (simhash / rolling hash). Requires the old bytes, which only the
  server has. Exact-hash matching only.
- Sharding the sidecar. Noted as an escape hatch in §7.6, not built.
- Pruning `file_versions`.

### 3.1 Compatibility posture

**Tephra is not live. Nothing in this plan needs to be backwards compatible, and compatibility scaffolding
is treated as a cost, not a safeguard.** Concretely:

- **Schema:** edit `tephra-server/migrations/sqlite/001_initial.sql` in place. Do not add numbered
  migration files, `ALTER TABLE` steps, or backfill scripts. The SQLite adapter's version guard
  (`if (version > 1) throw`) stays as-is; the schema version stays `1`. Developers re-create their local
  database.
- **Protocol:** change `syncManifestEntrySchema`, `canonicalManifestJson`, and the endpoint shapes freely.
  Do not introduce optional fields, dual code paths, or a `PROTOCOL_VERSION = '2'` step. The version
  handshake machinery (`PROTOCOL_VERSION`, `MINIMUM_PLUGIN_VERSION`, `isSupportedPluginVersion`, the two
  version headers) already exists and stays — it is cheap and will matter after launch — but it must not
  constrain any decision in this plan.
- **Plugin state:** change `TephraPluginState` freely. `parseState` need not preserve fields this plan
  removes; a stale local state is repaired from the server (§9.3), which is the designed path.
- **Existing vaults:** none exist beyond development vaults. Where the earlier draft of this plan proposed
  a data migration (non-NFC paths, `path_fold` backfill), the correct action is now to make the schema and
  the validator right from the start and re-seed dev vaults with `npm run sync:vault`.

Two decisions this posture **changes** relative to a compatibility-constrained design, both toward the
better option:

1. The cross-vault `fileId` steal is fixed with a composite `(vault_id, file_id)` primary key rather than a
   runtime guard bolted on top of a wrong key (§15.1).
2. NFC is **enforced** in `canonicalVaultPathSchema` rather than merely normalized on ingest, so a
   non-canonical path is a `400 INVALID_PATH` at the edge and cannot enter the database at all (§14.1).

One decision it does **not** change: server-assigned canonical ids stay rejected (§9.1). The reasons were
never primarily about compatibility.

---

## 4. Invariants and security

1. **Identity is not a function of observable file state.** No stage may derive a `fileId` from content
   alone, path alone, or both together, except as a deterministic *seed* for a newly minted id (§6).
2. **`diffRevision` continues to key on `fileId` only** (`tephra-server/packages/vault-model/src/index.ts:158`).
   No mode weakens it.
3. **The server stays identity-agnostic.** It diffs by id and enforces uniqueness; it does not know or
   store which mode a device runs.
4. **One manifest, one id per path, no duplicate ids.** `DUPLICATE_FILE_ID` / `DUPLICATE_PATH` validation
   stays. The matcher makes violations structurally impossible from healthy input (§8.1); the guard is
   what lets the plugin self-heal from corrupt input.
5. **Never log a vault path.** `emitRequestLog` (`tephra-server/apps/api/src/app.ts:79`) writes
   `c.req.path` to stdout on every request. Path resolution therefore travels in a query parameter, and
   only `resolve_match` — never the path — is added to `logContext`.
6. **In mode B and C the plugin never writes to a note.** Enforced by test with spies on
   `processFrontMatter` and `vault.modify`.
7. **No identity is persisted or committed on an offline cold start.** Minted ids are provisional until
   the server has been consulted (§9.3).
8. **Blobs stay content-addressed.** An identity change must never cause a re-upload or make a blob
   collectable.
9. **Destructive vault rewrites require explicit, specific confirmation** — never bundled into a mode
   switch (§10, §12).

---

## 5. Why `hash(path, content)` cannot be the identity

The requested framing needs correcting before anything is built on it.

Identity is a claim about **history** — "the thing at `B.md` today is the thing that was at `A.md`
yesterday" — not a property of current state. Any pure function of observable current state is
disqualified the moment the system has to survive a change to that state:

| Candidate | Fails because |
| --- | --- |
| `f(content)` | Changes on every edit; edits must preserve identity. Also collides constantly — empty notes, copied templates, stub `README.md`s. |
| `f(path)` | Changes on every rename/move; renames must preserve identity. |
| `f(path, content)` | Changes on **both**. Strictly worse than either, not a combination of their strengths. |

There is no third stable observable. `TFile.stat` exposes only `{ctime, mtime, size}`; Obsidian exposes no
durable per-file handle; inode numbers are neither reachable from the mobile-safe API surface nor stable
across the replication tools (Dropbox, Syncthing, git) Tephra users rely on.

So the roles split:

| Signal | Role |
| --- | --- |
| `path` | Primary **matching key** between two scans (the unchanged / modified case). |
| `sha256(content)` | Secondary **matching key** for rename and move detection across scans — git's `-M`, with exact hashes instead of similarity. Already load-bearing as the blob address. |
| Obsidian `rename` event | Strongest hint, when the plugin was running. |
| Minted opaque `fileId` | The actual **identity**, recorded outside observable state (frontmatter, sidecar, or the server). |

This is exactly why `diffRevision()` keys on `fileId`. That design is correct and stays.

---

## 6. Id minting

`newFileId()` currently returns `file_${crypto.randomUUID()}`, while attachments already use a
deterministic `file_attachment_${sha256(path)}` (`scanner.ts:23`). Generalize the deterministic form:

```ts
// tephra-plugin/src/sync/identity/id-mint.ts
export async function mintFileId(vaultId: string, path: string, kind: VaultFileKind): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(`${vaultId}\u0000${path}`));
  return `${kind === 'attachment' ? 'file_attachment_' : 'file_'}${digest.slice(0, 32)}`;
}
export function randomFileId(): string {
  return `file_${globalThis.crypto.randomUUID()}`;
}
```

Path-seeding is chosen over random UUIDs because:

1. **Two devices with no shared state converge.** A cold second device mints the same ids device A did,
   for every file never renamed — the overwhelming majority. "Device B joins the vault" becomes a near
   no-op even before server repair runs.
2. **Sidecar loss degrades gracefully** — only files renamed since creation churn, not the whole vault.
3. **Uniqueness within a manifest is free** — paths are unique, so freshly minted ids are unique by
   construction.
4. **Mode C becomes a three-line specialization of mode B** (always mint, never remember), so it costs
   almost nothing to ship.

Two traps that must be handled:

- **Recycled path.** `A.md` mints `H(A)`; it is renamed to `B.md` (sidecar keeps `B.md → H(A)`); later a
  *new* `A.md` is created and mints `H(A)` → duplicate id in one manifest → `DUPLICATE_FILE_ID`.
  Mitigation: mint against the ids already claimed in this scan (the scanner already keeps `claimedIds`,
  `scanner.ts:95`) and fall back to `randomFileId()` on collision. Determinism is an optimization;
  uniqueness is correctness and wins.
- **Cross-vault collision.** See §15.1 — this is a live bug today and is a **prerequisite**, not a
  consequence, of this work. The `vaultId` salt fixes newly minted ids; the server guard fixes existing ones.

---

## 7. Sidecar design

### 7.1 Location: `.tephra/data.json` at the vault root

| Location | Visible in Obsidian | Enters the manifest | Survives plugin reinstall | Replicated by |
| --- | --- | --- | --- | --- |
| `tephra-data.json` (vault root) | Yes — clutter | **Yes** — needs an explicit exclusion and fires `modify` events that must be suppressed | Yes | everything, incl. Obsidian Sync |
| `.obsidian/plugins/tephra-sync/data.json` (today) | No | No | **No** | only if plugin-data sync is enabled; commonly excluded |
| **`.tephra/data.json`** | No | **No — structurally** | Yes | git, Dropbox, iCloud, Syncthing (not Obsidian Sync) |

**Chosen: `.tephra/data.json`**, read and written through `app.vault.adapter` (the mobile-safe
`DataAdapter` every plugin uses to touch `.obsidian/…`).

The decisive argument is not replication — it is that a hidden directory *removes* a bug class rather than
mitigating it. Obsidian does not surface dot-directories as `TFile`s, so the sidecar never appears in
`vault.getFiles()`, never enters the manifest, and **never fires a `modify` event**. The write-loop that
`suppressedModify` (`tephra-plugin/src/main.ts:16`) exists to prevent cannot occur. It also survives a
plugin reinstall, unlike `data.json`.

Git users should `.gitignore` it — it is a cache. That removes the "committed, merged with conflict
markers, now invalid JSON" case entirely; the loader still tolerates it (§7.5), because iCloud and Dropbox
can still corrupt it.

Obsidian Sync will not carry `.tephra/`. **That is acceptable**, and is the point of making the sidecar a
cache: losing it costs one `GET` (§9.2). An advanced "identity cache location" option offering the vault
root can be added later for Obsidian Sync users; if it ships it must add `path === settings.identityCachePath`
to `shouldSyncPath`'s exclusions **and** route its write through the existing suppression callback. Not in v1.

### 7.2 Schema — identity only

```jsonc
{
  "version": 1,
  "vaultId": "vlt_7f2c1e…",
  "idScheme": "path-seeded-sha256-v1",
  "files": [
    ["Attachments/diagram.png", "file_attachment_9b1c…"],
    ["Daily/2026-09-08.md",     "file_0f3c8a…"],
    ["Projects/Tephra.md",      "file_91aa2d…"]
  ]
}
```

Validated plugin-side in `tephra-plugin/src/state/identity-store.ts` — **not** in `@tephra/protocol`, since
this is not wire format:

```ts
const sidecarSchema = z.strictObject({
  version: z.literal(1),
  vaultId: z.string().min(1),
  idScheme: z.string().min(1),
  files: z.array(z.tuple([z.string().min(1), z.string().min(1)])),
});
```

Deliberately **excluded**, because every field is write churn:

- `hash`, `size`, `mtime` — change on every edit. Including them would rewrite a multi-megabyte file on
  every debounce flush. They live in `data.json` instead (§7.4). **This is the most important decision in
  the sidecar design:** identity-only content means the sidecar changes only on create, rename, and
  delete — never on edit.
- `kind` — derivable from the extension.
- `deviceId`, `updatedAt`, `lastSyncRevision` — differ on every device, i.e. a guaranteed merge conflict on
  every replication, for no value.

`vaultId` is kept: it detects a sidecar belonging to a different Tephra vault (rebind, restored backup) and
it is the mint salt. It is an opaque identifier, not a secret.

### 7.3 Deterministic serialization

Hand-rolled, mirroring `canonicalManifestJson` in `@tephra/protocol`:

```ts
const lines = pairs
  .sort((a, b) => comparePaths(a[0], b[0]))            // reuse tephra-plugin/src/sync/manifest.ts
  .map(([p, id]) => `    [${JSON.stringify(p)}, ${JSON.stringify(id)}]`);
return `{\n  "version": 1,\n  "vaultId": ${JSON.stringify(vaultId)},\n  "idScheme": ${JSON.stringify(scheme)},\n  "files": [\n${lines.join(',\n')}\n  ]\n}\n`;
```

Three concrete reasons not to `JSON.stringify(record, null, 2)` a `Record<path, id>`:

1. **JS object key order is not insertion order for integer-like keys.** A file named `12` (an
   extensionless attachment) is hoisted to the front, making output non-deterministic with respect to the
   sort. An array of pairs is immune.
2. `Array.prototype.sort()`'s default is UTF-16 code-unit order, which differs from code-point order for
   astral characters — emoji in filenames are common. Reuse `comparePaths`, the same ordering the manifest
   uses.
3. One entry per line with a trailing newline gives minimal git and Obsidian Sync diffs, and makes a
   `merge=union` strategy workable for users who insist on committing it.

### 7.4 What stays in `data.json`

```ts
interface TephraPluginState {
  version: 1;
  settings: TephraSettings;                    // + identityMode
  manifest: Record<string, LocalFileState>;    // last *committed* snapshot — semantics unchanged
  scanCache: Record<string, { hash: string; size: number; mtime: number }>;   // NEW
  pendingRenames: [string, string][];          // NEW — durable rename hints, cleared on commit
  identityRepairNeeded?: boolean;              // NEW
  lastSuccessfulSyncAt?: number;
  lastRemoteRevision?: number;
}
```

- `scanCache` is the `mtime`+`size` → reuse-hash fast path *and* the hash source for rename detection among
  residuals. Today `previousWithRenames()` reads `state.manifest`, which is written only after a successful
  commit — so during an offline streak every scan re-hashes the whole vault and rename detection sees stale
  hashes. The eager `scanCache` fixes both without touching the "commit only after success" invariant of
  plan 001 §12.6.
- `pendingRenames` makes Obsidian's rename hints survive a restart between the rename and the next
  successful sync. Today `coordinator.renamedPaths` is in-memory only (`coordinator.ts:40`).
- `attachmentIds` is **removed outright** rather than deprecated (§3.1). Attachments are no longer a special
  case: they get their ids from the sidecar like every other file, so `VaultScanner.scan()` loses its
  second parameter and `ScanResult.attachmentIds` disappears. A pre-existing `data.json` carrying the field
  is ignored, and the first sync repairs from the server.

### 7.5 Write strategy

- **When:** after identity resolution, before plan/upload/commit — matching the existing eager
  `attachmentIds` save and for the same reason (a failed commit must not cause re-minting on restart).
  **Exception:** if the sidecar was missing and the server has not been consulted, do not persist and do
  not commit (§9.3).
- **Only if changed:** keep the serialized string in memory and skip the write when byte-identical. In
  steady-state editing the sidecar is never touched.
- **Atomicity** via `DataAdapter` (no `fsync`, no rename-over guarantees on mobile — and none needed for a
  cache with a server-side authority):
  1. `adapter.mkdir('.tephra')` if absent
  2. `adapter.write('.tephra/data.json.tmp', text)`
  3. `adapter.remove('.tephra/data.json.bak')` (ignore ENOENT) → `adapter.rename('.tephra/data.json', '.tephra/data.json.bak')` (ignore ENOENT)
  4. `adapter.rename('.tephra/data.json.tmp', '.tephra/data.json')`
- **Load:** parse `data.json`; on missing or invalid, parse `data.json.bak`; if both fail, treat as absent
  and set `identityRepairNeeded`. Never throw out of the loader. Never delete a file the user might want to
  inspect — rename a corrupt one to `data.json.corrupt-<ts>` at most once.

### 7.6 Scale

50 000 entries × ~90 bytes ≈ **4.5 MB**; one `JSON.parse` of ~30–60 ms at load; serialize and write only on
structural change. Compare with a sidecar that mirrored the manifest: ~12 MB rewritten on every debounce
flush — unusable on mobile and iCloud.

Rejected alternative — *store only the exceptions* (files whose current path differs from their mint path),
making the sidecar `O(renames)`: elegant for a fresh mode-B vault, but (a) "entry missing" and "never
renamed" become indistinguishable, so corruption silently re-derives ids with no signal; (b) random-fallback
ids have no mint path and need explicit entries anyway; (c) an A→B migration harvests arbitrary UUIDs, so
every entry becomes an exception and the size win evaporates.

Escape hatch if 4.5 MB ever hurts: shard as `.tephra/ids/<top-level-folder>.json`. Not v1.

---

## 8. The matching algorithm

Pure function, no Obsidian imports, in `tephra-plugin/src/sync/identity/matcher.ts`:

```ts
export interface PrevEntry { path: string; fileId: string; hash?: string }   // sidecar ∪ server ∪ scanCache
export interface CurrEntry { path: string; hash: string; size: number; mtime: number; kind: VaultFileKind }
export interface MatchResult {
  resolved: Array<CurrEntry & { fileId: string; origin: 'hint'|'path'|'frontmatter'|'hash'|'mint' }>;
  deletedIds: string[];
  identityChanged: string[];   // paths in both prev and curr whose id differs → churn-guard input
}
```

Stages run in strict precedence order, each consuming from `unmatchedPrev` / `unmatchedCurr`.

**Stage 0 — rename hints.** For each `(oldPath → newPath)` in `pendingRenames`, if `prev[oldPath]` exists,
`prev[newPath]` does not, and `curr[newPath]` exists: rebind `prev` to `newPath`. Resolve chains to the
terminal path first.

Two existing bugs this stage depends on fixing:

1. `EventBuffer.add` (`tephra-plugin/src/sync/event-buffer.ts:17`) does `this.events.delete(event.oldPath)`
   on a rename, so a chain `A→B→C` inside one debounce window loses the `A→B` link entirely and the plugin
   never learns that `A` became `C` — silent id churn on a double rename today. Fix: when an incoming
   rename's `oldPath` matches a buffered rename's `path`, rewrite that entry's `path` instead of deleting it.
2. `previousWithRenames()` (`tephra-plugin/src/sync/coordinator.ts:138`) is correct only by Map
   insertion-order luck. Resolve chains explicitly.

**Stage 1 — exact path match.** For every `curr` path also in `prev`: **keep the id**, regardless of hash.
Equal hash → unchanged; differing → modified. Running this before Stage 2 is precisely what makes the copy
case correct.

**Stage 1b — frontmatter id (mode B only, read-only).** For a residual `curr` file whose content carries
`tephra-file-id` (from `metadataCache`, already parsed — no extra I/O), adopt it if unclaimed. This is free
identity that travels inside the file: it makes A→B migration lossless and lets an A device and a B device
share a vault coherently. If two paths claim the same frontmatter id (a copied note), the winner is the path
`prev`/server records for that id, else the code-point-lowest path; the loser falls through.

**Stage 2 — hash-based rename/move detection over residuals.**

```
unmatchedPrev = prev entries whose path ∉ curr
unmatchedCurr = curr entries whose path ∉ prev, still unresolved

group both by content hash
for each hash H present in both groups:
    A = unmatchedPrev[H] sorted by comparePaths(path)
    B = unmatchedCurr[H] sorted by comparePaths(path)
    for i in 0 .. min(|A|,|B|)-1:  assign A[i].fileId to B[i]      // rename / move
    leftover A → deletions
    leftover B → fall through to Stage 4
```

- **Copy does not steal.** File `X` copied to `Y`: `X` still exists at its own path, so Stage 1 consumed it
  and it is not in `unmatchedPrev`. Only `Y` is unmatched, no prev entry carries its hash, so `Y` mints a
  fresh id. Correct by construction.
- **Duplicate content (N identical files).** Deterministic: both sides sorted by code point, paired
  positionally. If two byte-identical notes are renamed in the same interval, ids may be *crossed*. The
  resulting state is still correct — same paths, same bytes, same id set — and only two history edges are
  swapped. Identity between byte-identical files is not observable. Accept this and test for
  *determinism*, not for "correct" pairing.

**Stage 3 — rename + edit in the same interval, no hint.** Path changed *and* hash changed:
**unresolvable.** The prev entry becomes a delete; the curr path mints a new id.

- Lost: the server records `delete`+`create` instead of `rename`+`modify`; revision history restarts; a
  shared old-path URL returns 410 instead of redirecting (§13.4).
- Acceptable because it requires the rename and the edit to both happen while the plugin is not running —
  a running plugin gets a Stage 0 hint, and hints are now durable. Current state stays fully correct; only
  continuity is lost, which is exactly the allowance in plan 001 §11.
- **Explicitly rejected for v1:** blind 1:1 residual pairing ("exactly one deletion and one creation ⇒
  call it a rename"). Cheap and handles the common case, but it silently merges a genuine `delete A` +
  `create B` into a rename, inheriting one note's history and URL into an unrelated note.

**Stage 4 — mint.** `mintFileId(vaultId, path, kind)`, falling back to `randomFileId()` on collision with
the claimed set.

Complexity: O(n) hash maps plus O(k log k) sorts over residuals only. At 50k files with 100 residuals this
is microseconds.

### 8.1 Uniqueness proof

Stages 0, 1, and 1b bind each `prev` id to at most one `curr` path (paths are unique keys). Stage 2 pairs
disjoint sets positionally, consuming each `prev` entry at most once. Stage 4 mints against the claimed
set. Therefore every `curr` path receives exactly one id and no id appears twice — `DUPLICATE_FILE_ID` is
structurally impossible from healthy input.

The `claimedIds` guard is nonetheless kept, because a *corrupt* sidecar can bind the same id to two paths
(git merge, hand edit). The loader deduplicates deterministically: the code-point-lowest path keeps the
binding, the other is dropped to unknown.

### 8.2 Sidecar absent, corrupt, or foreign — recovery

Two corrections to the intuitive fear that this means "re-upload the whole vault":

**It is not a re-upload.** Blobs are content-addressed. `/sync/plan` reports `missingBlobs` **by hash**, and
the hashes are unchanged, so nothing uploads. `blob-gc` keeps blobs alive via `file_versions.blob_hash`, so
nothing is collected. The real costs of id churn are history noise (`delete`+`create` rows for the whole
vault), a full re-index (`note_metadata` / `note_links` dropped and rebuilt through `ON DELETE CASCADE`),
and — today only — every web URL breaking. Bandwidth is not a cost.

**With path-seeded minting it is not the whole vault.** Only files renamed since creation get new ids;
everything else re-mints to its original id.

**The fix — server repair, zero protocol change.** `GET /api/v1/vaults/:vaultId/files` already returns
exactly the `prev` shape the matcher needs (`fileDto`: `fileId`, `path`, `blobHash`, `size`, `mtime`,
`kind`), and the plugin's upload token already carries `vault:read-metadata` — verified: the plugin omits
`scopes` when provisioning (`tephra-plugin/src/api/client.ts:121`), so it receives the schema default
`['vault:read-metadata','vault:upload']` (`tephra-server/apps/api/src/app.ts:128`), and `/files` requires
exactly that scope. So:

> On repair, fetch the server's file list, feed it to the matcher as `prev` (with `hash = blobHash`), adopt
> the resulting ids, write the sidecar, continue.

Sidecar loss becomes one extra `GET`, and churn drops to zero for every file the server already knows —
including renamed ones, because the server's recorded `path` is the pre-loss path and Stage 1 matches it.

---

## 9. Multi-device reconciliation

### 9.1 Rejected: server-assigned canonical ids

The option of sending provisional (or absent) ids and having the server match by path-then-hash and return
canonical ids is **rejected** — and it stays rejected under §3.1, because the reasons were never about
compatibility. `fileId` is inside `canonicalManifestJson` and therefore inside `manifestHash`, which is the
commit idempotency key (`vaultRevisions.findByManifestHash`) and the `UNIQUE(vault_id, manifest_hash)`
constraint. If the server rewrites ids:

- `verifyManifest` can no longer validate the client's hash against the client's files;
- the client can no longer predict the committed manifest hash, so it cannot ask "am I up to date?" without
  a round trip — the `up-to-date` short circuit in `/sync/plan` dies;
- a two-phase flow is required (`POST /sync/resolve-ids` → client rewrites → re-hash → `POST /sync/commit`);
- the server becomes stateful about identity policy, which it currently is not.

**The option §3.1 newly unblocks, and why it is still not taken.** Without compatibility constraints we
could simply **remove `fileId` from `canonicalManifestJson`**, making `manifestHash` a pure function of the
path/content layout. That restores hash predictability under server-assigned ids and is worth stating
explicitly, because compatibility was the only thing hiding it. It is rejected on its own merits: a
deliberate identity change — a mode switch to C, or a repair adopting different ids — would then produce a
manifest hash **identical** to the previous revision's, so `/sync/commit` would answer `up-to-date` and the
new ids would never land. The user's explicit mode switch would silently not take effect server-side. Keeping
`fileId` in the manifest hash is what makes an identity change a committable event. Client-side repair
(§9.2) gets the same convergence with none of this.

Also rejected: a **replicated sidecar with union merge**. Obsidian Sync ignores `.tephra/` entirely; a
`union` merge on a path→id map produces duplicate keys for the same path with different ids whenever two
devices minted independently (union merges lines, it does not resolve semantics); conflict copies are
silently ignored; last-write-wins clobbers the other device's bindings. A reconciliation authority is needed
regardless.

### 9.2 Chosen: client-side repair against the server's file table

**The server's `vault_files` table is the identity authority; the sidecar is a local cache.** The
reconciliation *logic* stays in the plugin, over an existing read endpoint.

| Property | Server-assigned ids | Client-side repair (chosen) |
| --- | --- | --- |
| `manifestHash` idempotency preserved | ✗ | ✓ |
| Protocol version bump | required | none |
| Old plugins keep working | needs a matrix | untouched |
| Server stays identity-agnostic (invariant 3) | ✗ | ✓ |
| Testable without a server | ✗ | ✓ (pure matcher) |
| Steady-state cost | 0 extra requests | 0 extra requests |
| Cold-start / divergence cost | 0 | 1 `GET` |

### 9.3 Repair triggers

Repair runs when any of:

1. Sidecar missing, unparseable, `vaultId` mismatched, or `idScheme` unknown.
2. `plan.latestRevision !== state.lastRemoteRevision` — someone else committed since our last sync, so the
   cache may be stale. Precise, free (the plan response already carries `latestRevision`), and the mechanism
   that makes concurrent multi-device editing converge.
3. A commit failed with `DUPLICATE_FILE_ID` or `DUPLICATE_PATH` — self-heal, retry once.
4. The user pressed **Repair identities from server**.

Loop shape in `coordinator.reconcile()`:

```
scan (mtime/size fast path via scanCache; NFC-normalize paths)
resolve identity from sidecar → manifest, hash
POST /sync/plan
if repairTriggered(plan):
    status('repairing')
    server = GET /files
    re-resolve identity with the server list as prev
    if identityChanged.length > churnThreshold and not allowChurnOnce: abort + prompt
    persist sidecar
    rebuild manifest + hash; POST /sync/plan again
upload missing blobs
POST /sync/commit
persist manifest, scanCache, lastRemoteRevision; clear pendingRenames
```

**Offline rule.** If the sidecar is absent and the server has not been reached, do not persist minted ids
and do not commit. Set status `needs-identity-repair` and retry. Exception: `latestRevision === 0` (empty
vault), where minting is authoritative. This replaces today's unconditional eager `attachmentIds` save,
which would otherwise bake in wrong ids during an offline cold start.

**Churn guard.** Block and require explicit confirmation when `identityChanged` — paths present in both
prev and curr whose id differs — exceeds `max(25, 2% of files)`. This counts only identity churn on
*surviving* paths, which is never legitimate outside a deliberate mode switch or repair, so it is
false-positive-free. It is the safety net for "a mode-C device ran against a mode-B vault", "an old sidecar
was restored", and "bound to the wrong vault".

---

## 10. Removing `tephra-file-id` from notes

This is deliverable (1) and ships independently of the rest.

### 10.1 Strip helper

Add to `tephra-plugin/src/sync/scanner.ts`, as the inverse of `injectFrontmatterFileId`:

```ts
export function stripFrontmatterFileId(content: string): string | undefined; // undefined = no change
```

Cases to handle:

- property alongside other keys → drop that line, keep the block;
- property is the only key → drop the whole `---` … `---` block **and** one following blank line, so a
  clean file is left rather than a stray empty frontmatter;
- CRLF preserved; closing delimiter `---` or `...`;
- quoted values and trailing `# comment` (the existing `extractFrontmatterFileId` regex already covers
  these shapes);
- no frontmatter, or property absent → return `undefined`, reported as *skipped*.

Preferred write path is `app.fileManager.processFrontMatter(file, fm => { delete fm[FILE_ID_PROPERTY] })`,
which re-serializes correctly and removes the block when it becomes empty. Fall back to the raw strip when
YAML is invalid — mirroring the existing fallback in `writeMarkdownFileId` (`scanner.ts:180-208`), which
exists precisely because Templater placeholders and malformed YAML make `processFrontMatter` throw.

### 10.2 The sweep

New `tephra-plugin/src/sync/id-cleanup.ts`:

```ts
scanForFileIds(app): Promise<Array<{ path: string; id: string }>>
removeFileIds(app, files, opts): Promise<{ removed: number; skipped: number; failed: Array<{path: string; reason: string}> }>
```

- Iterates `app.vault.getMarkdownFiles()` — **all** Markdown, including files `shouldSyncPath()` excludes,
  so an uninstall leaves nothing behind.
- Chunked (≈25 files) with a yield between chunks, so mobile stays responsive; progress reported to the
  caller.
- Every write goes through the existing `beforeFrontmatterWrite` suppression hook so the sweep does not
  trigger a self-inflicted sync storm; the suppression window is extended for the batch.
- One file's failure never aborts the batch; failures are collected and reported.

### 10.3 Confirmation modal

New `tephra-plugin/src/ui/confirm-modal.ts` (Obsidian `Modal`):

- **Title:** `Remove Tephra file IDs from N notes?`
- **Body:**
  - This rewrites N notes in your vault to delete the `tephra-file-id` property.
  - It cannot be undone by Tephra. Back up the vault or commit to git first.
  - *(when ids were harvested first)* Identity has been copied to `.tephra/data.json` — the server will see
    no change.
  - *(when they were not)* Identity will be **lost**. On the next sync Tephra treats every note as new:
    rename history resets, and existing `#file/<id>` links break.
  - *(when sync is on and the mode is still frontmatter)* Direct sync is on and identity mode is still
    "Frontmatter property" — IDs will be re-added on the next scan. Switch mode or turn sync off first.
    The confirm button is **disabled** in this state, with a link that fixes it.
- **Checkbox:** "I understand this rewrites N files." **Button:** destructive, `Remove from N notes`.

### 10.4 Entry points and ordering

- Settings → Note identity section: a danger-styled **Remove Tephra IDs from notes** button.
- Command palette: **Tephra: Remove file IDs from all notes**.

Both run preview → modal → sweep → summary `Notice` plus a console list of failures.

**Ordering rule:** removal runs *after* the mode switch has harvested ids into the sidecar, never before.
In the mode-switch flow the harvest is a precondition, not an option.

Note the cost, and state it in the dry run: stripping the property changes the content hash of **every**
note, so it produces one large revision with N `modify` rows and a full re-upload of all Markdown blobs
(roughly vault-sized). Identity is preserved throughout, because the sidecar already holds the ids.

---

## 11. Mode selection

`TephraSettings` gains `identityMode: 'frontmatter' | 'sidecar' | 'path'`.

| | **A — Frontmatter IDs** | **B — Sidecar (recommended)** | **C — Path identity** |
| --- | --- | --- | --- |
| Writes to your notes | yes, in every note | **never** | never |
| Stores anything | nothing extra | `.tephra/data.json` (gitignored cache) | nothing |
| Rename keeps identity | always | almost always | **never** |
| Rename + edit while Obsidian is closed | preserved | new identity | n/a |
| Second device with no sidecar | automatic | one `GET /files` on first sync | automatic (paths agree) |
| Properties panel / git diffs | polluted | clean | clean |
| Fights Templater / invalid YAML | yes | no | no |
| Old shared links after a rename | redirect | redirect | **410 Gone** |
| For whom | maximal robustness, doesn't mind the property | **everyone else** | single device, few renames, zero footprint |

Mode B **reads** frontmatter ids when present but never writes them (Stage 1b), so A→B is lossless and an
A device and a B device can share one vault.

### 11.1 Settings UI

New `renderIdentitySection(containerEl)` in `tephra-plugin/src/ui/settings-tab.ts`, between
`renderVaultSection` and `renderSyncSection`, rendered only when `enableSync` is true.

- **Setting "Note identity"** — dropdown. Desc: *"How Tephra remembers which note is which across renames."*
- Per-mode help paragraph, swapped on change:
  - **Frontmatter property** — "Most portable. Tephra writes a `tephra-file-id` property into every note.
    Renames and multi-device setups always keep the same identity — but your notes are modified, the
    property appears in Obsidian Properties, and it shows up in git diffs."
  - **Sidecar file (recommended)** — "Tephra never modifies your notes. Identities are cached in
    `.tephra/data.json` and repaired from your Tephra server when needed. Renames are preserved. A note
    renamed *and* edited while Obsidian was closed may get a new identity."
  - **Path only** — "Nothing is stored. A note's identity is its path. Renaming a note looks like deleting
    and re-creating it: its history restarts and previously shared links to the old path stop working. Best
    for a single device that rarely renames."
- **Preview changes** button → the dry-run modal (§12), always shown before switching.
- **Repair identities from server** button → forces trigger 4.
- **Remove Tephra IDs from notes** button (§10), danger-styled.
- Inline warning when the churn guard has fired: *"Blocked: 1,240 notes would change identity. Review
  before continuing."* with an **Allow once** button.

**Default:** `sidecar`, for every install. There is no installed base to preserve (§3.1), so `parseState`
defaults a missing `identityMode` to `'sidecar'` and no upgrade banner or grandfathering path is built. A
developer whose vault already carries `tephra-file-id` properties is served by the normal A→B migration
(§12) plus the removal sweep (§10) — the same path a user takes deliberately. Never switch mode silently
once set.

### 11.2 The mode is not recorded server-side

The server never interprets identity semantics; it diffs by id and validates uniqueness. Recording the mode
would add a column and a new inconsistency class (recorded mode ≠ the mode the committing device actually
runs) while enabling nothing the server can act on — it cannot reject a manifest for "wrong
mode" without breaking the "one commit is one complete manifest" invariant. Devices in different modes
already interoperate through Stage 1b plus server repair, and the one genuinely dangerous combination (a
mode-C device fighting a mode-B device) is caught by the plugin-side churn guard, which is precise and needs
no server state. The server already records `deviceId` per revision if churn ever needs attributing.

---

## 12. Switching modes and migration

All migrations run through `tephra-plugin/src/sync/identity/migrations.ts` and one confirmation modal, and
**every one starts with a dry run**.

**Dry-run report**, always, before any switch: *identities preserved: N · identities changed: M · notes to
be rewritten: K · bytes to upload: B · shared links that will break: L.* Never proceed silently when `M > 0`.

| Migration | Effect |
| --- | --- |
| **A → B** (frontmatter → sidecar) | Non-destructive, zero server churn. Harvest every `tephra-file-id` from `metadataCache`, write `.tephra/data.json`, set the mode. Ids identical ⇒ the next commit is a no-op (`diffRevision.isNoOp`), nothing uploads. Stripping the property is a **separate** destructive step (§10). |
| **B → A** (sidecar → frontmatter) | Write each sidecar id into the file's frontmatter. Ids preserved, so no server churn — but every Markdown content hash changes, so all Markdown blobs re-upload. Confirmation plus dry run. Files failing both `processFrontMatter` and raw injection keep their sidecar id and are listed in the report; the sidecar is retained as a fallback, not deleted. |
| **anything → C** (path identity) | Every file whose id ≠ `mintFileId(vaultId, currentPath, kind)` gets a new id ⇒ `delete`+`create` on the server and a broken old-path link. Pleasant property: for a fresh mode-B vault with no renames this is a **no-op**, because path-seeded minting already produced exactly those ids. The dry run tells the user which case they are in. Confirmation required whenever `M > 0`; sets `allowIdentityChurnOnce`. |
| **C → B** | Adopt current ids into the sidecar. Zero churn. |

Any switch clears `pendingRenames` and forces a repair fetch on the next sync, so the server's view is
authoritative before anything is committed.

---

## 13. Path-addressed, shareable URLs

Target shape: `user.tephra.com/<vault>/#/path/to/file.md`, case-sensitive, shareable.

### 13.1 Do not hash the path

`vault_files` already has `UNIQUE(vault_id, path)` (`tephra-server/migrations/sqlite/001_initial.sql:71`) —
an exact, unique, indexed lookup — and `vaultFiles.findByPath` already exists
(`tephra-server/packages/database/sqlite/src/index.ts:185`). Hashing the path before lookup buys nothing and
costs:

- the URL stops being human-readable and hand-editable, which is the entire point of path addressing;
- no prefix queries (folder listings, "everything under `Projects/`");
- a hash cannot do case-folding, NFC-tolerant matching, or historic resolution — all of which need the
  literal path;
- an extra column and index to maintain, and a second thing that can drift.

The only things a hash would offer — fixed key length, no encoding worries — are non-problems
(`encodeURIComponent`; SQLite indexes variable-length `TEXT` fine). **Resolve on the path directly.**

### 13.2 Schema

Edited directly into `tephra-server/migrations/sqlite/001_initial.sql` — no numbered migration, no backfill
(§3.1):

```sql
-- vault_files: add alongside the existing columns
  path_fold TEXT NOT NULL,
-- and alongside the existing indexes
CREATE INDEX vault_files_path_fold_idx ON vault_files(vault_id, path_fold);
CREATE INDEX file_versions_path_idx    ON file_versions(vault_id, path, revision);
```

`path_fold` is `nfc(path).toLocaleLowerCase('en')`, written by `vaultFiles.upsert` inside the SQLite
adapter. It is a lookup index, not domain state, so `CurrentVaultFile` in `packages/vault-model` does
**not** expose it. Being `NOT NULL` without a default is deliberate: every write path must supply it, and a
missed one fails loudly at insert rather than silently resolving nothing.

### 13.3 The resolver endpoint

```
GET /api/v1/vaults/:vaultId/resolve?path=<encodeURIComponent per segment, joined by '/'>
scope: vault:read-metadata

200 {
  match: 'exact' | 'case' | 'normalized' | 'historic',
  requestedPath: string,
  canonicalPath: string,
  file: VaultFileDto,
  movedFromPath?: string,
  movedAtRevision?: number
}
404 { error: { code: 'VAULT_NOT_FOUND',  message: 'File was not found.' } }
410 { error: { code: 'FILE_DELETED',     message: '…' } }   // new ApiErrorCode
409 { error: { code: 'AMBIGUOUS_PATH',   message: '…' } }   // new ApiErrorCode
```

**Why a query parameter and not `GET /…/by-path/:path{.+}`** — a decisive reason, not taste:
`emitRequestLog` writes `c.req.path` to stdout on **every** request
(`tephra-server/apps/api/src/app.ts:79`), and Hono's `req.path` excludes the query string. A wildcard route
would write users' note paths — `Personal/Therapy/2026-09-02.md` — verbatim into the access log, violating
the `AGENTS.md` rule against logging vault contents. The query-parameter form leaks nothing. Secondarily, a
literal `%` in a filename encoded as `%25` is unambiguous in a query parameter, whereas in a wildcard route
`%2F` inside a segment is indistinguishable from a separator.

Add only `path_resolved: true` and `resolve_match: <match>` to `logContext`. Never the path.

The resolver returns the file; **all existing `/files/:fileId/*` endpoints stay exactly as they are.** The
SPA resolves once, then uses `fileId` for `content` / `rendered` / `links` / `backlinks`. That is one new
endpoint and no duplicated content-serving code — chosen because it is the right shape, not because
anything forbids changing the existing routes (§3.1).

### 13.4 Resolution precedence

```
1. exact:      vault_files WHERE vault_id=? AND path=?                    → 200 match:'exact'
2. normalized: the same query with nfc(path)                              → 200 match:'normalized'
3. case-fold:  vault_files WHERE vault_id=? AND path_fold=?
                 exactly 1 row → 200 match:'case', canonicalPath=row.path
                 >1 row        → 409 AMBIGUOUS_PATH with the candidate list
4. historic:   SELECT file_id FROM file_versions
                 WHERE vault_id=? AND path=? ORDER BY revision DESC LIMIT 1
               then vault_files.findById(file_id):
                 exists, current path ≠ requested → 200 match:'historic', canonicalPath=current path
                 gone                             → 410 FILE_DELETED
5. otherwise 404
```

The ambiguity rule falls out of the ordering: **a path currently occupied by a different file always beats
history**, because steps 1–3 precede step 4. Within history, `ORDER BY revision DESC LIMIT 1` picks the most
recent occupant, so a recycled path resolves to the last file that lived there, and a file renamed away and
back resolves to itself. There is exactly **one hop** by construction — history yields a `file_id`,
`vault_files` yields its current path — so there is no chain to follow and no cycle risk.

**How far back:** unbounded. `file_versions` is append-only and never pruned, and is already load-bearing
for blob GC. If pruning is ever added, resolution degrades to 404 with no code change.

**Response shape:** `200` plus `canonicalPath`, not an HTTP `302`. The SPA needs the payload anyway, a 302
across `fetch` is awkward to test, and the redirect is a *fragment* change (`#/old.md` → `#/new.md`), which
HTTP redirects cannot express. The web app does `history.replaceState` to the canonical hash URL and shows a
subtle "moved from `Old/Path.md`" hint. A future server-rendered path route (e.g. `/v/:slug/raw/*`) would
use a real 302.

### 13.5 URL encoding and the hash-routing choice

`'#/' + segments.map(encodeURIComponent).join('/')`. That encodes `#` (`%23`, mandatory — RFC 3986 forbids
`#` inside a fragment), `?`, `%`, space, and all non-ASCII as UTF-8 escapes, while leaving `/` literal so
the URL still reads like a path. Normalize to NFC **before** encoding. When rendering a link for display,
decode everything except the reserved set.

Keeping the path in the **fragment** rather than the path (`/v/:slug/Notes/a.md`) is right for three
reasons: the fragment is never sent to the server, so (1) no SPA-fallback or static-asset rewrite rules are
needed for URLs that look like files (`…/a.md`), (2) note paths stay out of every proxy, CDN, and server
access log, and (3) it works unchanged under every hosting profile (plans 004/005).

The app keeps `BrowserRouter` (`tephra-server/apps/web/src/main.tsx:12`) and reads `location.hash`;
`App.tsx:21`'s route becomes `/v/:vaultSlug/*`, and `parseView`
(`tephra-server/apps/web/src/routes/VaultWorkspace.tsx:14-19`) is rewritten to parse the hash instead of the
`*` splat.

### 13.6 Vault addressed by name (adjacent — own plan)

`vaults` currently has `name TEXT NOT NULL` with no uniqueness and no slug
(`001_initial.sql:19`). `/<vaultname>/` needs `vaults.slug` with `UNIQUE(owner_user_id, slug)` given the
per-user subdomain; derivation NFKC → lowercase → `[^a-z0-9]+` → `-` → trim → dedupe with `-2`, `-3`; a
reserved set for sibling top-level routes (`login`, `setup`, `settings`, `vaults`, `api`, `assets`,
`healthz`, `readyz`); and old slugs kept resolvable on rename (an alias table, or `previous_slug` for one
hop). `/v/:vaultId/…` must keep working forever as the id-addressed fallback — it is what the plugin's
"Open Web Mirror" button builds (`tephra-plugin/src/ui/settings-tab.ts:195`). Flag as its own plan; it is
not identity work.

### 13.7 Re-ranking the modes against path URLs

| | Mode A | Mode B | Mode C |
| --- | --- | --- | --- |
| Shared URL after a **rename** | old path → `historic` → canonical rewrite | same | **410 Gone, permanently** |
| Shared URL after an **edit** | works | works | works |
| Revision history across a rename | `rename` row | `rename` row | `delete`+`create`; history restarts |
| Backlinks / graph across a rename | preserved | preserved | edges reset then rebuilt |
| Blob re-upload on rename | none | none | none (content-addressed) |
| Cost of a one-off id churn | — | **now invisible to users** | n/a |

Two conclusions:

1. **The recommendation does not change — mode B stays the default.** Identity is still required by the
   sync diff, by revision history, and now *also* by the rename redirect, which only works when the rename
   was recorded as a `rename` version row.
2. **Path addressing materially de-risks the migration**, which is why §18 sequences it first.

Optional consolation for mode C, scoped out of v1: at the revision where path `P` was deleted, look for a
`create` in the *same* revision with the same `blob_hash` and redirect there — recovering rename redirects
with no identity at all. Needs a `file_versions(vault_id, revision, blob_hash)` index.

### 13.8 Does path addressing change the reconciliation decision?

No, and it slightly weakens the batch-resolve idea. A path→id resolver is per-path; the plugin needs the
*entire* mapping plus `blobHash` for rename matching, which `GET /files` already returns in one request.
N resolves — or one batch `POST /paths/resolve` — would be strictly worse: more requests, more payload for
the same information, and note paths in a request body the plugin must then be careful never to log. Keep
the plugin on `GET /files`. If big-vault repair fetches ever become a problem, the right optimization is a
narrower **read** endpoint, `GET /api/v1/vaults/:vaultId/files/identity` →
`{revision, files: [{fileId, path, blobHash}]}`.

---

## 14. Cross-platform path canonicalization

The requirement is that a shared link resolves to the same file regardless of whether the vault was synced
from macOS, Linux, or Windows — including when a second device on a different OS joins the same vault.

**There is no Unicode normalization anywhere in the codebase today.** Verified: `grep -rn "normalize|NFC|NFD"`
across `tephra-plugin/src` and `tephra-server/{packages,apps}` returns only unrelated hits — the
`normalize()` in `tephra-server/packages/link-resolver/src/index.ts:32` is path *cleaning*, not Unicode
normalization. So this is an existing bug class, not merely a new risk.

### 14.1 Unicode normalization

macOS filesystems have historically returned decomposed (NFD) filenames; Linux and Windows generally carry
NFC. `Café.md` therefore arrives as two byte-different strings that a user considers identical. Three
consequences today:

- **Storage:** `UNIQUE(vault_id, path)` compares bytes (BINARY collation), so the NFD and NFC forms are two
  rows in the same vault — a duplicate file, not a conflict.
- **Links:** `link-resolver` matches wikilink targets against stored `entry.path` by string equality, so
  `[[Café]]` typed on one OS silently fails to resolve against a filename stored from another — an
  unresolved link and a missing graph edge, with no error surfaced.
- **URLs:** the new resolver inherits the problem from both ends — the stored path *and* the path the
  browser hands back from a shared link can differ in form.

**Decision: canonicalize to NFC at a single ingest boundary, with defence in depth at lookup.**

| Layer | Action |
| --- | --- |
| Plugin scanner (**primary**) | `path.normalize('NFC')` before the path enters the manifest, the sidecar, or the mint input. |
| Protocol edge (**enforced**) | `canonicalVaultPathSchema` refines `s.normalize('NFC') === s`, so a non-canonical path is `400 INVALID_PATH` and cannot enter the database. |
| Server resolver | Normalize the incoming `?path=` before querying — step 2 of §13.4. |
| `link-resolver` / `indexer` | Rely on ingest canonicalization rather than normalizing at each comparison site; add a regression test that an NFD-stored path resolves an NFC wikilink. |

**Add NFC as a hard refinement** in `isCanonicalVaultPath` / `canonicalVaultPathSchema`
(`tephra-server/packages/protocol/src/index.ts`). An earlier draft deferred this because it would make
existing NFD vaults fail `/sync/commit`; under §3.1 there are no such vaults, so enforcing it now is
strictly better — it turns a silent duplicate-row bug into a loud `400 INVALID_PATH` at the edge, and it
means every consumer downstream of the protocol (indexer, link-resolver, resolver, `path_fold`) can assume
NFC without re-checking. `hasOnlyUnicodeScalarValues()` already rejects lone surrogates and needs no change.

Because the schema rejects non-NFC, the plugin's scanner normalization is not merely defence in depth — it
is what keeps a macOS vault syncable at all. Cover it with a test that an NFD filename produces an NFC
manifest entry, and a server test that a hand-crafted NFD path is rejected.

**No data migration is required or written** (§3.1). Development vaults are re-seeded with
`npm run sync:vault`.

### 14.2 Case

The requirement is case-sensitive URLs; the filesystems disagree with each other. macOS (APFS default) and
Windows are case-*insensitive*, so only a Linux-authored vault can contain `Notes/Foo.md` and
`notes/foo.md` side by side.

- **Primary lookup stays byte-exact and case-sensitive.** SQLite `TEXT` defaults to `BINARY` collation, so
  `WHERE path = ?` already is, and `UNIQUE(vault_id, path)` is likewise binary. This is what makes a
  Linux vault's case-differing siblings individually addressable.
- **Case-insensitive fallback fires only on a unique match** (step 3), which handles the common
  human-typo and cross-OS-casing case without ever guessing between two real files. More than one match is
  `409 AMBIGUOUS_PATH` with candidates, not a coin flip.
- **A casing change from a Windows/macOS device** (`foo.md` → `Foo.md`) reaches the manifest as a path
  change with an unchanged hash, so Stage 0/2 treats it as a rename, identity is preserved, and the old-cased
  URL resolves via `case` (unique) or `historic`.

SQLite traps to respect:

- `LIKE` is ASCII-case-insensitive by default — **never use `LIKE` for path resolution**. The existing
  search uses JS `toLocaleLowerCase().includes()` (`apps/api/src/runtime-index.ts:74`), which is deliberate
  and unaffected.
- `lower()` is ASCII-only, so `CREATE INDEX … (lower(path))` would not fold `Ä`. Fold in the app layer and
  store it (`path_fold`, §13.2).
- Any future Postgres adapter (plans 003/005) must declare `path TEXT COLLATE "C"`; a non-deterministic ICU
  collation would break the unique index's semantics.

### 14.3 Windows path shapes

Backslashes are already rejected by `isCanonicalVaultPath`. For the rest:

| Shape | Treatment |
| --- | --- |
| Drive prefixes (`C:/…`), UNC (`//server/share`) | Rejected at the protocol edge — a vault-relative path never has them; `//` already fails the empty-segment check. |
| Reserved device names (`CON`, `NUL`, `PRN`, `COM1`, `LPT1`, …) | Accepted as-is. They are legal on Linux and the server never opens files by name. Documented as "may not sync to a Windows device". |
| Trailing dots or spaces in a segment (`foo. .md`) | Accepted as-is server-side, and documented as not round-tripping to Windows, which silently strips them. Do not normalize — silently rewriting a Linux user's filename is worse. |
| Segment / total length | Accepted as-is; note that Windows clients may fail on paths over 260 chars. |

### 14.4 Order of operations at the resolver

`decode` (percent-decode the query value) → `normalize('NFC')` → `validate` (`isCanonicalVaultPath`) →
`match` (§13.4). Normalizing the *incoming* URL path is not optional: a browser may hand back a
differently-normalized string than the one in the shared link.

---

## 15. Consequences for server and web

### 15.1 Prerequisite: fix the cross-vault `fileId` steal

**This is a live bug today**, verified in the code, and it is a blocker for path-seeded minting.

`vault_files.file_id` is a **global** `PRIMARY KEY` (`001_initial.sql:62`) with `UNIQUE(vault_id, file_id)`
only as a redundant secondary, and `upsert` is
`ON CONFLICT(file_id) DO UPDATE SET vault_id=excluded.vault_id, …`
(`packages/database/sqlite/src/index.ts:187`). Attachments already derive
`file_attachment_${sha256(path)}` from the path alone (`scanner.ts:23`), so two vaults on one server that
both contain `Attachments/logo.png` derive the **identical** id, and vault B's commit **moves vault A's row
into vault B**. Vault A's next commit sees the id missing from `listByVault(A)`, calls it a `create`, and
moves it back — a permanent ping-pong, cascading `note_metadata` and `note_links` each time. Path-seeded
Markdown ids would widen this from attachments to every note.

**Fix it properly, at the key.** An earlier draft split this into a cheap runtime guard now and a composite
primary key "later, scheduled separately", because changing the key implied a migration. Under §3.1 there is
no migration to fear, so the correct fix is the only fix:

- `vault_files` PRIMARY KEY → `(vault_id, file_id)`, dropping the now-redundant `UNIQUE(vault_id, file_id)`.
- Composite foreign keys in `note_metadata`, `note_links.source_file_id`, and `note_links.target_file_id`
  (each gains a `vault_id` column in the FK, which they already carry as a plain column).
- `vaultFiles.findById(fileId)` → `findById(vaultId, fileId)`; likewise `delete`. `upsert`'s conflict target
  becomes `ON CONFLICT(vault_id, file_id)`, so a cross-vault id can no longer move a row between vaults —
  it inserts a second, correctly-scoped row instead.
- Keep the `vaultId` mint salt (§6) regardless: it prevents two vaults from *sharing* an id in the first
  place, which keeps revision history readable even though the key now makes sharing harmless.

Files: `tephra-server/migrations/sqlite/001_initial.sql` (edited in place),
`tephra-server/packages/database/core/src/index.ts` (repository signatures),
`tephra-server/packages/database/sqlite/src/index.ts`, and the `findById` call sites in
`tephra-server/apps/api/src/app.ts` (`/files/:fileId` and the resolver's history hop, which must now pass
the vault — a latent authorization sharpening, since `findById` currently looks up a file id without
scoping it to the vault in the URL).

### 15.2 Required for path addressing

| File | Change |
| --- | --- |
| `tephra-server/migrations/sqlite/001_initial.sql` | Edited in place: composite `vault_files` PK (§15.1), `path_fold` column and index, `file_versions(vault_id, path, revision)` index. No numbered migration. |
| `tephra-server/packages/database/core/src/index.ts` | `vaultFiles.findByPathFold`, `fileVersions.findLatestByPath`. |
| `tephra-server/packages/database/sqlite/src/index.ts` | Implement both; write `path_fold` in `upsert`. |
| `tephra-server/apps/api/src/app.ts` | The `resolve` route; vault-scoped `findById` call sites (§15.1); `logContext` records `resolve_match` only. |
| `tephra-server/packages/protocol/src/index.ts` | `resolveResponseSchema`; `FILE_DELETED` and `AMBIGUOUS_PATH` error codes; NFC refinement on `canonicalVaultPathSchema` (§14.1). `syncManifestEntrySchema` and `canonicalManifestJson` are left alone because §9.1 wants them that way, not because compatibility requires it. |
| `tephra-server/apps/web/src/app/App.tsx`, `routes/VaultWorkspace.tsx` | Hash parsing, `open()` navigating by path, `replaceState` on `historic` / `case` matches, the "moved from" hint. |
| `tephra-server/apps/web/src/api/client.ts` | `resolve()`. |
| `tephra-server/apps/web/src/components/{FileTree,NoteViewer,AttachmentViewer}.tsx` | `onSelect` and link interception emit paths. |
| `tephra-server/packages/link-resolver/src/index.ts` | NFC regression coverage; rely on ingest canonicalization. |

### 15.3 Deliberately unchanged

- **`diffRevision`** — correct for all three modes.
- **`DUPLICATE_FILE_ID` validation** — kept; it is what lets the plugin self-heal (trigger 3).
- **Blob GC** — unaffected. Id churn neither orphans blobs (`file_versions.blob_hash` keeps them
  referenced) nor triggers re-upload (`missingBlobs` is by hash).
- **Indexer** — stays keyed by `fileId`; `note_links` edges are internal, not addresses. An id churn causes
  a full re-index, which is bounded and already handled by the per-commit `indexVault` call.
- **`note_links.target_file_id ON DELETE SET NULL`** — backlinks null out briefly during a churn revision
  and are rebuilt by the reindex.
- **Web URL stability** — solved by §13, not by identity mode.

---

## 16. Risks and failure modes

| # | Risk | Mitigation |
| --- | --- | --- |
| 1 | Cross-vault id steal (§15.1) — pre-existing, worsened by path-seeded minting | Composite `(vault_id, file_id)` primary key, in phase 1 |
| 2 | Offline cold start bakes in wrong ids | No persist and no commit before repair (§9.3) |
| 3 | `EventBuffer` loses rename chains (`event-buffer.ts:17`) | Rewrite the buffered entry instead of deleting; durable `pendingRenames` |
| 4 | NFC/NFD drift → duplicate paths, dead URLs, unresolved wikilinks | NFC enforced at the protocol edge, normalized in the scanner, plus the resolver fallback (§14.1) |
| 5 | Sidecar corrupted by a git merge or iCloud conflict | `.gitignore`, `.bak` recovery, repair, deterministic dedupe |
| 6 | A mode-C device fighting a mode-B device | Churn guard (§9.3) |
| 7 | `LIKE` or `lower()` accidentally used for path resolution | Stored fold column plus a test asserting case sensitivity |
| 8 | ID removal (§10) rewrites every note and re-uploads all Markdown | Stated in the dry run; separate destructive confirmation; harvest first |

---

## 17. Tests

**Plugin** (`tephra-plugin/tests/`, vitest, in the style of `path-and-id.test.ts` / `reconciliation.test.ts`)

- `id-cleanup.test.ts` (new) — strip: only key / among keys / absent / CRLF / `...` terminator / quoted
  value / trailing comment; sweep counts removed / skipped / failed; one file's failure does not abort the
  batch; `processFrontMatter` throws → raw fallback; both throw → recorded failed; suppression hook called
  once per written file; a second sweep reports 0 removed.
- `identity-matching.test.ts` (new) — every stage in precedence order; copy-does-not-steal; N byte-identical
  files → deterministic **and** unique ids; rename+edit → new id plus delete; rename chain `A→B→C`;
  frontmatter-id duplicate tie-break; a property test over randomized prev/curr asserting one entry per path
  and no duplicate ids; a 50 000-entry performance assertion.
- `identity-store.test.ts` (new) — byte-identical serialization for the same map; code-point sort including
  astral characters; a path named `12` does not reorder; `.bak` recovery; JSON containing `<<<<<<< HEAD`
  conflict markers → treated as absent, repair flagged, original preserved; foreign `vaultId`; duplicate
  ids inside the sidecar → deterministic dedupe; `.tephra` created when missing.
- `identity-modes.test.ts` (new) — mode B **never** calls `processFrontMatter` or `vault.modify` (spies);
  mode B still *reads* frontmatter ids; mode C ids always equal `mintFileId`; A→B harvest preserves every
  id; churn guard fires and does not fire at the boundary.
- `path-and-id.test.ts` (extend) — `.tephra/**` excluded by `shouldSyncPath`; NFC normalization applied in
  the scanner; NFD input yields an NFC manifest path.
- `coordinator.test.ts` (extend) — repair triggers on `plan.latestRevision !== lastRemoteRevision`; repair
  after `DUPLICATE_FILE_ID` then retry; **`listFiles` is not called in the steady state**; sidecar written
  only when the map changes; offline with no sidecar ⇒ no commit and no persist; `pendingRenames` survives a
  simulated restart.
- `event-buffer.test.ts` (extend) — `A→B→C` in one window yields `A→C`.
- `client.test.ts` (extend) — `listFiles` and `resolve` parsing.

**Server**

- `apps/api/tests/app.test.ts` — two vaults with identical paths keep independent rows and neither commit
  moves the other's row (regression for §15.1); a commit carrying a non-NFC path is rejected `400
  INVALID_PATH`; `resolve` covers exact / normalized / case /
  ambiguous(409) / historic / deleted(410) / 404; **a path currently occupied by a different file beats
  history**; a case-only miss (`note.md` vs `Note.md`) returns `match:'case'`, not `'exact'`; the access log
  contains no path (assert against captured stdout — `observability.test.ts` sets the precedent).
- `packages/vault-model/tests/revision-diff.test.ts` — a wholesale id change produces `delete`+`create` and
  references no new blobs.
- `apps/api/tests/blob-gc.test.ts` — an id churn does not make blobs collectable.
- `apps/api/tests/sync-concurrency-perf.test.ts` (extend) — two devices committing concurrently converge on
  one id set.
- `packages/link-resolver/tests/link-resolver.test.ts` — an NFD-stored path resolves an NFC wikilink.
- `packages/database/sqlite/tests/sqlite.test.ts` — two vaults holding the same `file_id` keep independent
  rows under the composite key, and `findById` scoped to one vault never returns the other's row.
- `packages/protocol/tests/protocol.test.ts` — a non-NFC path fails `canonicalVaultPathSchema`; the NFC form
  of the same name passes.
- `apps/web/e2e/vault-flow.spec.ts` — open by path; rename; the old link redirects with a "moved" hint.

---

## 18. Phased implementation

Non-overlapping file ownership. Phase 1 lands the schema and key changes in one shot (§3.1: edited in
place, no migration), so phases 2 and 5 can run alongside it while 3 waits on it.

| Phase | Owns | Depends on |
| --- | --- | --- |
| **1. Schema and key correctness** | `migrations/sqlite/001_initial.sql` (composite PK, `path_fold`, indexes), `packages/database/{core,sqlite}/src/index.ts` (vault-scoped `findById`/`delete`), `apps/api/src/app.ts` (call sites), `packages/protocol/src/index.ts` (NFC refinement), `apps/api/tests/app.test.ts` | — |
| **2. ID removal (plugin)** | `src/sync/scanner.ts` (`stripFrontmatterFileId`), **new** `src/sync/id-cleanup.ts`, **new** `src/ui/confirm-modal.ts`, `src/main.ts` (command), `src/ui/settings-tab.ts` (button), **new** `tests/id-cleanup.test.ts` | — |
| **3. Path addressing (server)** | `packages/database/{core,sqlite}/src/index.ts` (`findByPathFold`, `findLatestByPath`), `packages/protocol/src/index.ts` (`resolveResponseSchema`, error codes), `apps/api/src/app.ts` (`/resolve`) | 1 |
| **4. Path addressing (web)** | `apps/web/src/app/App.tsx`, `routes/VaultWorkspace.tsx`, `api/client.ts`, `components/{FileTree,NoteViewer,AttachmentViewer}.tsx` | 3 |
| **5. Identity core (pure)** | **new** `src/sync/identity/{types,id-mint,matcher}.ts`, **new** `tests/identity-matching.test.ts` | — |
| **6. Sidecar store and state** | **new** `src/state/identity-store.ts`, `src/state/plugin-state.ts`, **new** `tests/identity-store.test.ts` | 5 |
| **7. Scanner** | `src/sync/scanner.ts` (mode-driven; frontmatter write only in mode A; NFC), **new** `tests/identity-modes.test.ts` | 2, 5, 6 |
| **8. Coordinator and client** | `src/sync/coordinator.ts` (repair triggers, churn guard, durable renames), `src/sync/event-buffer.ts` (rename chains), `src/api/client.ts` (`listFiles`), `src/main.ts` (wiring) | 7 |
| **9. Settings and migrations** | `src/ui/settings-tab.ts`, **new** `src/ui/identity-migration-modal.ts`, **new** `src/sync/identity/migrations.ts` | 8 |
| **10. Docs** | `README.md`, `tephra-plugin/README.md`, `PROGRESS.md` | all |
| **11. Vault slugs** | separate plan (§13.6) | 4 |

**Sequencing constraint:** ship phases 3–4 before phase 9, so that by the time users can switch identity
modes, an id churn no longer breaks any URL they have shared.

Phase 2 is independently shippable and delivers the most-requested outcome (a way out) on its own.

---

## 19. Verification

- `npm run check` at the repository root after every phase (`AGENTS.md`).
- The phase's new or extended test file, per §17.
- `npm run sync:plugin` then a manual pass in a real vault for phases 2, 7, 8, and 9 — specifically:
  frontmatter removal on a vault with invalid YAML; a mode switch with the dry run; a second device joining
  with no sidecar; a rename while Obsidian is closed.
- `npm run sync:vault` against `sample-vault/` plus `npm run test:e2e` for phases 3 and 4.
- Manual cross-platform check for §14: sync a vault containing a decomposed filename from macOS, then
  resolve it by an NFC URL, and the reverse.

---

## 20. Completion checklist

- [ ] Composite `(vault_id, file_id)` primary key, vault-scoped `findById`, with a regression test
- [ ] `stripFrontmatterFileId` plus the chunked removal sweep
- [ ] Destructive confirmation modal, settings button, and command
- [ ] `001_initial.sql` carrying `path_fold` and the new indexes, edited in place — no migration file
- [ ] `GET /…/resolve` with all five precedence steps and no path in the logs
- [ ] Web app routing on `#/<path>`, with canonical rewriting and a "moved from" hint
- [ ] `mintFileId` / `randomFileId` and the pure matcher, with all stages tested
- [ ] `.tephra/data.json` store: atomic write, `.bak` recovery, deterministic serialization
- [ ] Mode-driven scanner; modes B and C provably never write to a note
- [ ] Repair triggers, churn guard, durable `pendingRenames`, `EventBuffer` chain fix
- [ ] Three-mode setting with per-mode help text and dry-run migrations both directions
- [ ] NFC enforced in `canonicalVaultPathSchema`, normalized in the scanner, with `link-resolver`
      regression coverage
- [ ] READMEs and `PROGRESS.md` updated; `.tephra/` documented as gitignorable
