# Tephra Stage 1 — Implementation Plan

> **Status:** Implementation specification  
> **Project:** Tephra  
> **Stage:** 1 — read-only cloud mirror and browser  
> **Primary components:** `tephra-server`, `tephra-plugin`  
> **Audience:** coding agents and engineers implementing the project  
> **Last updated:** 2026-09-06

---

## 0. Purpose of this document

This document is the implementation specification for **Stage 1 of Tephra**.

A coding agent should be able to use this document as the source of truth for building the first working release without needing to make major product or architectural decisions.

Tephra is an open-source service that lets a user:

1. install an Obsidian community plugin,
2. connect that plugin to a Tephra server,
3. upload/synchronize an Obsidian vault to that server in **one direction only**,
4. open the Tephra web application from any browser,
5. browse the vault's file tree,
6. open and render Markdown notes with Obsidian-like link behavior,
7. navigate `[[wikilinks]]`,
8. inspect a dependency/knowledge graph of notes and links.

Stage 1 is intentionally **read-only from the web application**.

The local Obsidian vault remains the source of truth.

The server MUST NOT send mutations back to the local vault in Stage 1.

---

# 1. Product model

## 1.1 Names

Use these names consistently:

- **Tephra** — the open-source project.
- **Tephra Server** — the self-hostable server and web application.
- **Tephra Plugin** — the Obsidian plugin that uploads a vault.
- **Tephra Cloud** — the future centrally hosted SaaS operated by us.
- **Tephra Publish** — provisional future name for publishing a vault or part of a vault as a public website.

Repository names:

```text
tephra-server
tephra-plugin
```

Do not use `obsidian` in the plugin ID.

Recommended Obsidian plugin metadata:

```json
{
  "id": "tephra-sync",
  "name": "Tephra Sync",
  "description": "Sync your vault to a Tephra server for secure browser access.",
  "isDesktopOnly": false
}
```

The exact `minAppVersion` must be set to the oldest Obsidian version actually tested before release.

---

## 1.2 Open-source and hosted model

The open-source version MUST be a real, useful product.

A user MUST be able to self-host it without depending on Tephra Cloud.

The minimum practical self-host installation should be:

```text
one container
one persistent volume
one port
```

Default single-server deployment:

```text
Tephra container
├── API
├── web UI
├── SQLite database
└── local blob store
```

This must be sufficient for:

- a $5 VPS,
- a home server,
- a NAS,
- a single-instance Railway deployment with a persistent volume,
- Docker Compose.

The architecture is disk-only by doctrine (amended 2026-09-06; plans 003/004/005):

```text
Database:
  SQLite (only live database)

Blob storage:
  local filesystem (only live blob store)
```

PostgreSQL, Cloudflare D1, S3-compatible live storage, and Cloudflare R2
adapters were considered in early drafts and are explicitly dropped: the
headless Obsidian Sync sidecar (plan 006) requires a POSIX checkout next to
the server, and one-volume-per-tenant hosting replaces shared infrastructure.
Object storage is used for periodic whole-volume snapshot backups only
(plan 005-STORAGE_ENGINES.md).

This runs in environments such as:

- AWS (ECS/EFS or EC2/EBS),
- GCP (Compute Engine + Persistent Disk, or Cloud Run + Filestore),
- Railway (service + volume),
- Fly.io (machine + volume),
- generic VPS infrastructure.

Serverless runtimes without persistent disks (Vercel Functions, Cloudflare
Workers) are not supported targets; their scaffolds were deleted.

Do not make Kubernetes, Redis, Kafka, Elasticsearch, or any managed database mandatory.

---

## 1.3 Licensing recommendation

Recommended initial license:

```text
AGPL-3.0-or-later
```

Reason:

- users can freely self-host and modify Tephra,
- improvements made to a modified Tephra offered over a network are generally subject to AGPL source-sharing obligations,
- we can still charge for operating Tephra Cloud.

Do not build a licensing enforcement mechanism into Stage 1.

Before final release, the project owner should make a deliberate legal/licensing decision. If a permissive ecosystem is preferred over network-copyleft protection, Apache-2.0 is the main alternative.

Any future proprietary hosted-only modules must be kept behind clearly defined interfaces and reviewed for license compatibility.

---

# 2. Stage 1 product requirements

## 2.1 User-visible functionality

Stage 1 MUST implement:

### Obsidian plugin

- configurable Tephra server URL,
- authentication using a vault-scoped upload token,
- create/select a remote vault,
- initial full vault upload,
- incremental upload after local changes,
- detect:
  - file creation,
  - file modification,
  - file deletion,
  - file rename,
- periodic/full reconciliation so missed events are repaired,
- sync status in plugin settings/status UI,
- retry failed uploads,
- never modify the local vault.

### Tephra web application

After login, the user can:

- see their vaults,
- open a vault,
- browse a hierarchical file tree,
- open Markdown notes,
- render supported Obsidian Markdown syntax,
- click `[[wikilinks]]`,
- resolve links to notes,
- view image/file attachments,
- view a graph of note-to-note dependencies,
- select a graph node and open the note.

The Stage 1 primary vault screen is intentionally small:

```text
┌──────────────────────────────────────────────────────────┐
│ Tephra / My Vault                                       │
├────────────────┬─────────────────────────────────────────┤
│ FILE TREE      │ NOTE                                    │
│                │                                         │
│ ▾ Projects     │ # Example                               │
│   alpha.md     │                                         │
│   beta.md      │ Text with [[Another Note]].             │
│                │                                         │
│ Notes.md       │                                         │
│                │                                         │
├────────────────┴─────────────────────────────────────────┤
│ GRAPH                                                    │
└──────────────────────────────────────────────────────────┘
```

Responsive/mobile browser support is desirable, but desktop web is the primary Stage 1 target.

---

## 2.2 Stage 1 compatibility target

Tephra does **not** embed, copy, or recreate the Obsidian application.

It implements a compatible model for common vault semantics.

Stage 1 compatibility MUST cover:

- folders,
- Markdown files,
- non-Markdown attachments,
- standard Markdown,
- GFM tables,
- fenced code blocks,
- task lists,
- YAML frontmatter/properties,
- headings,
- tags,
- `[[Note]]`,
- `[[Folder/Note]]`,
- `[[Note|Alias]]`,
- `[[Note#Heading]]`,
- `[[Note#^block-id]]`,
- `![[Note]]` note embeds,
- `![[image.png]]` attachment embeds,
- backlinks/index data sufficient for the graph,
- resolved links,
- unresolved links.

Stage 1 SHOULD cover if reasonable during the implementation:

- Obsidian callouts,
- footnotes,
- KaTeX math,
- heading embeds,
- block embeds.

Stage 1 MAY defer:

- Mermaid,
- Canvas,
- Bases,
- custom CSS snippets,
- themes,
- arbitrary raw HTML compatibility.

Security takes precedence over exact rendering compatibility.

---

# 3. Explicitly out of scope for Stage 1

A coding agent MUST NOT implement the following unless this document is changed.

## 3.1 Bidirectional synchronization

Do not:

- download remote changes into Obsidian,
- write to the local vault,
- implement three-way merging,
- implement conflict copies,
- implement server-to-device sync queues.

These belong to Stage 2.

---

## 3.2 Web editing

The web viewer MUST NOT edit notes.

Do not add:

- CodeMirror editor mode,
- save buttons,
- remote note creation,
- remote deletes,
- remote renames.

The Stage 1 API should be designed so mutations can be added later, but those endpoints are not part of Stage 1.

---

## 3.3 Obsidian plugin runtime compatibility

Do not execute third-party Obsidian plugins in Tephra Stage 1.

Do not implement:

- `require("obsidian")` shims,
- `App`,
- `Vault`,
- `Workspace`,
- `MarkdownView`,
- plugin sandboxing,
- iframe plugin runtime,
- CodeMirror plugin integration.

This belongs to Stage 2.

---

## 3.4 Public publishing

Do not make private vaults publicly accessible in Stage 1.

The architecture MUST make future publishing easy, but anonymous/public routes are a later feature.

Future intended feature:

```text
private Tephra vault
        ↓ choose snapshot/subtree
Tephra Publish
        ↓
public static or dynamic website
```

The Markdown renderer and vault read APIs should therefore avoid depending on authenticated React component state.

---

## 3.5 Billing and SaaS-specific control plane

Do not implement:

- Stripe,
- plans,
- quotas,
- subscriptions,
- team billing.

Tephra Cloud will add these later.

The Stage 1 data model MUST still be multi-user and multi-vault so the hosted service can reuse it.

---

# 4. Architectural principles

The following are non-negotiable.

## 4.1 Local vault is the source of truth

For Stage 1:

```text
Obsidian vault → Tephra
```

Never:

```text
Tephra → Obsidian vault
```

The remote copy is a versioned mirror.

---

## 4.2 Markdown files remain canonical

Do not convert notes into a proprietary document representation.

Store the original bytes.

Derived data such as:

- links,
- graph edges,
- headings,
- tags,
- frontmatter,

must be rebuildable from stored vault content.

---

## 4.3 Store immutable content by hash

Use SHA-256 for content addressing.

```text
blob hash = SHA-256(file bytes)
```

A file version refers to a blob hash.

Two files with identical contents reuse the same blob.

Never trust the client-provided hash without verification.

---

## 4.4 Version every successful vault commit

Every successful sync that changes the remote vault creates one monotonically increasing vault revision.

Example:

```text
revision 41
revision 42
revision 43
```

Revision history is mostly invisible in the Stage 1 UI, but it is required now because Stage 2 conflict resolution will need historical baselines.

---

## 4.5 Core logic must be runtime-independent

The following packages MUST NOT depend on Node-specific filesystem/process APIs:

```text
vault model
sync protocol types
Markdown parsing
link resolution
graph construction
hashing interface
```

Use browser/Web APIs where possible.

This keeps the plugin mobile-compatible and the shared packages browser-safe.

---

## 4.6 Infrastructure is accessed through adapters

Core application code must use interfaces instead of directly importing:

- SQLite,
- local filesystem.

(Amended 2026-09-06: PostgreSQL, D1, S3, and R2 adapters dropped; disk-only
doctrine in plans 003/005. Snapshot upload to object storage is an external
offline step, not a live adapter.)

Required abstractions:

```ts
Database
BlobStore
SessionStore
Clock
IdGenerator
```

A queue abstraction may be introduced, but Stage 1's default implementation should execute indexing inline.

---

# 5. Recommended technology stack

## 5.1 Language

Use:

```text
TypeScript
```

Use strict TypeScript mode everywhere.

---

## 5.2 Package manager / monorepo

Use:

```text
npm workspaces
```

Recommended:

```text
npm
Turborepo
```

Turborepo is optional; npm workspaces are required.

---

## 5.3 Server HTTP framework

Recommended:

```text
Hono
```

Reasons:

- lightweight,
- TypeScript-native,
- works in Node,
- simple middleware model.

Do not build the core server around Express-specific request/response objects.

---

## 5.4 Web frontend

Use:

```text
React
TypeScript
Vite
```

Recommended supporting libraries:

```text
TanStack Query
React Router
Zustand only if shared UI state becomes necessary
```

Avoid a large app framework dependency unless it solves a concrete Stage 1 requirement.

The web UI should be compilable to static assets.

---

## 5.5 Database access

Recommended:

```text
Drizzle ORM
```

Provide the SQLite adapter only (amended 2026-09-06; PostgreSQL/D1 dropped):

```text
SQLite
```

Keep schema field types simple and explicit:

- IDs: text,
- timestamps: integer epoch milliseconds,
- booleans: integer where needed,
- JSON: serialized text.

---

## 5.6 Markdown

Recommended pipeline:

```text
unified
remark-parse
remark-gfm
remark-frontmatter
remark-math
remark-rehype
rehype-katex
rehype-sanitize
rehype-stringify
yaml
```

Create custom Tephra plugins/utilities for:

```text
wikilinks
embeds
block IDs
Obsidian callouts
tag extraction
```

Do not use unsafe direct `innerHTML` with unsanitized Markdown output.

---

## 5.7 Graph

Recommended:

```text
graphology
sigma.js
```

Graphology owns graph data.

Sigma renders the interactive browser graph.

The graph data itself comes from the server's normalized link index.

---

## 5.8 Tests

Use:

```text
Vitest
Playwright
```

Use a real SQLite database and real filesystem blob store for integration tests.

---

# 6. Repository layout

## 6.1 `tephra-server`

Create:

```text
tephra-server/
├── apps/
│   ├── api/
│   │   ├── src/
│   │   │   ├── app.ts
│   │   │   ├── routes/
│   │   │   ├── middleware/
│   │   │       └── entrypoints/
│   │   │           └── node.ts (only runtime; serverless entrypoints dropped 2026-09-06)
│   │   └── package.json
│   │
│   └── web/
│       ├── src/
│       │   ├── app/
│       │   ├── components/
│       │   ├── routes/
│       │   ├── vault/
│       │   └── api/
│       └── package.json
│
├── packages/
│   ├── protocol/
│   ├── core/
│   ├── vault-model/
│   ├── markdown/
│   ├── link-resolver/
│   ├── indexer/
│   ├── auth/
│   ├── database/
│   │   ├── core/
│   │   └── sqlite/
│   ├── blob-store/
│   │   ├── core/
│   │   └── filesystem/
│   └── test-fixtures/
│
├── deploy/
│   ├── docker/
│   ├── railway/
│   ├── aws/
│   └── gcp/
│
├── migrations/
│   └── sqlite/
│
├── Dockerfile
├── docker-compose.yml
├── package-lock.json
├── package.json
├── LICENSE
├── CONTRIBUTING.md
└── README.md
```

Do not make every package a separately deployed service.

They are code boundaries.

---

## 6.2 `tephra-plugin`

Create:

```text
tephra-plugin/
├── src/
│   ├── main.ts
│   ├── settings.ts
│   ├── api/
│   │   └── client.ts
│   ├── auth/
│   │   └── token.ts
│   ├── sync/
│   │   ├── coordinator.ts
│   │   ├── manifest.ts
│   │   ├── scanner.ts
│   │   ├── hasher.ts
│   │   ├── uploader.ts
│   │   ├── event-buffer.ts
│   │   └── reconciliation.ts
│   ├── state/
│   │   └── plugin-state.ts
│   └── ui/
│       ├── status.ts
│       └── settings-tab.ts
│
├── tests/
├── manifest.json
├── versions.json
├── package.json
├── LICENSE
└── README.md
```

The plugin should consume protocol types from an exported package generated/published from `tephra-server`, for example:

```text
@tephra/protocol
```

The protocol package MUST contain only browser-safe TypeScript and schemas.

---

# 7. Core domain model

Use UUIDv7 or another time-sortable random identifier for application IDs.

Do not use database-generated integer IDs as external API identifiers.

## 7.1 Entities

### User

```ts
interface User {
  id: string;
  email: string;
  createdAt: number;
}
```

### Vault

```ts
interface Vault {
  id: string;
  ownerUserId: string;
  name: string;
  latestRevision: number;
  createdAt: number;
  updatedAt: number;
}
```

### Device

A plugin installation connected to a vault.

```ts
interface Device {
  id: string;
  userId: string;
  name: string;
  platform?: string;
  createdAt: number;
  lastSeenAt: number;
}
```

### CurrentVaultFile

Represents the current remote state only.

```ts
interface CurrentVaultFile {
  fileId: string;
  vaultId: string;
  path: string;
  blobHash: string;
  size: number;
  mtime: number;
  mimeType?: string;
  kind: "markdown" | "attachment";
}
```

### VaultRevision

```ts
interface VaultRevision {
  vaultId: string;
  revision: number;
  manifestHash: string;
  deviceId: string;
  createdAt: number;
}
```

### FileVersion

Append-only historical record.

```ts
type FileChangeType =
  | "create"
  | "modify"
  | "rename"
  | "delete";

interface FileVersion {
  id: string;
  vaultId: string;
  fileId: string;
  revision: number;
  path: string;
  blobHash: string | null;
  size: number | null;
  mtime: number | null;
  changeType: FileChangeType;
}
```

For a delete:

```text
blobHash = null
```

The previous version remains in history.

---

# 8. Database schema

Create the following logical tables.

Exact DDL may differ slightly by database adapter.

```text
users
sessions
vaults
devices
api_tokens
blobs
vault_files
vault_revisions
file_versions
note_metadata
note_links
```

## 8.1 `users`

```text
id                  TEXT PRIMARY KEY
email               TEXT NOT NULL UNIQUE
password_hash       TEXT NULL
created_at          INTEGER NOT NULL
updated_at          INTEGER NOT NULL
```

Stage 1 local auth may use a local password.

Design the auth package so Tephra Cloud can later use an external identity provider.

---

## 8.2 `vaults`

```text
id                  TEXT PRIMARY KEY
owner_user_id       TEXT NOT NULL
name                TEXT NOT NULL
latest_revision     INTEGER NOT NULL DEFAULT 0
created_at          INTEGER NOT NULL
updated_at          INTEGER NOT NULL
```

Index:

```text
(owner_user_id)
```

---

## 8.3 `devices`

```text
id                  TEXT PRIMARY KEY
user_id             TEXT NOT NULL
name                TEXT NOT NULL
platform             TEXT NULL
created_at           INTEGER NOT NULL
last_seen_at         INTEGER NOT NULL
```

---

## 8.4 `api_tokens`

Do not store raw tokens.

```text
id                  TEXT PRIMARY KEY
user_id             TEXT NOT NULL
vault_id            TEXT NULL
device_id           TEXT NULL
token_hash          TEXT NOT NULL UNIQUE
name                TEXT NOT NULL
scopes_json         TEXT NOT NULL
created_at          INTEGER NOT NULL
last_used_at        INTEGER NULL
expires_at          INTEGER NULL
revoked_at          INTEGER NULL
```

Stage 1 plugin token scopes:

```json
[
  "vault:read-metadata",
  "vault:upload"
]
```

The plugin does not need an account-wide bearer token.

---

## 8.5 `blobs`

```text
hash                TEXT PRIMARY KEY
size                INTEGER NOT NULL
mime_type           TEXT NULL
created_at          INTEGER NOT NULL
```

The actual bytes live in `BlobStore`.

---

## 8.6 `vault_files`

Current state.

```text
file_id             TEXT PRIMARY KEY
vault_id            TEXT NOT NULL
path                TEXT NOT NULL
blob_hash           TEXT NOT NULL
size                INTEGER NOT NULL
mtime               INTEGER NOT NULL
mime_type           TEXT NULL
kind                TEXT NOT NULL
updated_revision    INTEGER NOT NULL
```

Unique constraint:

```text
UNIQUE(vault_id, path)
```

Indexes:

```text
(vault_id)
(vault_id, kind)
(vault_id, blob_hash)
```

---

## 8.7 `vault_revisions`

```text
vault_id            TEXT NOT NULL
revision            INTEGER NOT NULL
manifest_hash       TEXT NOT NULL
device_id           TEXT NOT NULL
created_at          INTEGER NOT NULL

PRIMARY KEY(vault_id, revision)
```

Unique:

```text
UNIQUE(vault_id, manifest_hash)
```

A manifest that is identical to the latest manifest is a no-op and MUST NOT create a new revision.

---

## 8.8 `file_versions`

```text
id                  TEXT PRIMARY KEY
vault_id            TEXT NOT NULL
file_id             TEXT NOT NULL
revision            INTEGER NOT NULL
path                TEXT NOT NULL
blob_hash           TEXT NULL
size                INTEGER NULL
mtime               INTEGER NULL
change_type         TEXT NOT NULL
created_at          INTEGER NOT NULL
```

Indexes:

```text
(vault_id, revision)
(vault_id, file_id, revision)
```

This table is append-only in Stage 1.

---

## 8.9 `note_metadata`

Only Markdown files have a row.

```text
file_id             TEXT PRIMARY KEY
vault_id            TEXT NOT NULL
indexed_blob_hash   TEXT NOT NULL
title               TEXT NULL
frontmatter_json    TEXT NOT NULL
headings_json       TEXT NOT NULL
tags_json           TEXT NOT NULL
blocks_json         TEXT NOT NULL
indexed_at          INTEGER NOT NULL
```

---

## 8.10 `note_links`

```text
id                  TEXT PRIMARY KEY
vault_id            TEXT NOT NULL
source_file_id      TEXT NOT NULL
raw_text            TEXT NOT NULL
link_path           TEXT NOT NULL
subpath             TEXT NULL
display_text        TEXT NULL
is_embed            INTEGER NOT NULL
target_file_id      TEXT NULL
created_at          INTEGER NOT NULL
```

Indexes:

```text
(vault_id, source_file_id)
(vault_id, target_file_id)
```

`target_file_id = null` means unresolved.

---

# 9. Blob storage

Define:

```ts
interface BlobStore {
  has(hash: string): Promise<boolean>;

  put(input: {
    hash: string;
    bytes: ReadableStream<Uint8Array> | Uint8Array;
    size: number;
    mimeType?: string;
  }): Promise<void>;

  get(hash: string): Promise<BlobReadResult | null>;

  delete(hash: string): Promise<void>;
}
```

## 9.1 Filesystem implementation

Default self-host implementation:

```text
/data/blobs/ab/cd/abcdef...
```

For hash:

```text
abcdef...
```

use a two-level prefix to avoid huge flat directories.

Blob writes MUST:

1. stream to a temporary file,
2. calculate SHA-256 while writing,
3. reject the upload if calculated hash does not equal requested hash,
4. fsync/close,
5. atomically rename the temp file into place.

If blob already exists, return success.

---

## 9.2 Object storage (snapshot backups only)

Dropped as a live adapter 2026-09-06 (plans 003/005). S3-compatible storage,
GCS, R2, and Railway buckets hold periodic whole-volume snapshot tarballs
(`tephra snapshot create/upload`) for backup only. They never serve live
reads or writes. Bucket layout for snapshots:

```text
<snap-prefix>/tephra-snap-<tenant>-<utc-timestamp>.tar.zst
```

Buckets stay private. Live object key on disk remains:

```text
blobs/ab/cd/<sha256>
```

---

# 10. Path rules

Paths are security-sensitive.

Canonical vault paths:

- UTF-8 strings,
- forward slash `/`,
- relative to vault root,
- no leading slash,
- no NUL characters,
- no empty path,
- no `.` segment,
- no `..` segment.

Examples:

```text
Notes.md
Projects/Alpha.md
Attachments/image.png
```

Invalid:

```text
/Notes.md
../secret
a/../../secret
C:\foo
```

The server MUST validate paths independently of the plugin.

Do not ever concatenate an untrusted vault path directly onto a server filesystem path.

Blob storage is addressed by hashes, not vault paths.

---

# 11. Plugin state

Use Obsidian plugin data storage via `loadData()` / `saveData()`.

Example:

```ts
interface TephraPluginState {
  version: 1;

  serverUrl?: string;
  token?: string;

  remoteVaultId?: string;
  deviceId?: string;

  manifest: Record<string, LocalFileState>;

  lastSuccessfulSyncAt?: number;
  lastRemoteRevision?: number;
}
```

Local file state:

```ts
interface LocalFileState {
  fileId: string;
  path: string;
  mtime: number;
  size: number;
  hash: string;
}
```

The stable `fileId` is generated by the plugin.

On rename:

```text
fileId remains unchanged
path changes
```

If plugin state is lost, Tephra is allowed to treat existing files as new file IDs. The resulting remote state must still be correct; only historical rename continuity may be lost.

---

# 12. Obsidian plugin implementation

## 12.1 Platform compatibility

The Stage 1 plugin SHOULD remain mobile-compatible.

Do not depend on:

```text
fs
path
electron
child_process
native Node modules
```

Use:

- Obsidian Vault APIs,
- Web Crypto,
- `requestUrl` for HTTP requests where appropriate.

Obsidian currently documents Node/Electron use as desktop-only and recommends Web API alternatives for portable plugins.

---

## 12.2 Startup sequence

`onload()` must remain cheap.

Do not scan the entire vault directly inside `onload()`.

Startup sequence:

```text
plugin onload
    ↓
load plugin settings/state
    ↓
register settings tab
    ↓
wait for workspace.onLayoutReady()
    ↓
register vault event listeners
    ↓
schedule reconciliation
```

The Obsidian developer documentation notes that vault `create` events can fire during vault initialization. Event processing should therefore begin after layout readiness.

---

## 12.3 Vault file enumeration

Use:

```ts
this.app.vault.getFiles()
```

This includes Markdown files and normal visible attachments.

Do not directly crawl the vault filesystem.

Do not sync hidden Obsidian internals in Stage 1.

In particular, do not sync:

```text
.obsidian/plugins
.obsidian/workspace*
```

Do not use Adapter APIs merely to reach hidden folders.

---

## 12.4 Reading files

For Markdown display/upload:

```ts
await this.app.vault.cachedRead(file)
```

is appropriate when reading plaintext for upload.

For binary content use the Vault binary read API available in the targeted Obsidian version.

Normalize content to bytes before hashing.

For text files:

```text
UTF-8 bytes of exact returned text
```

The hash sent to the server MUST be over exactly the bytes uploaded.

---

## 12.5 SHA-256

Implement a browser-safe hasher using Web Crypto:

```ts
crypto.subtle.digest("SHA-256", bytes)
```

For very large files, Web Crypto may require loading the whole file into memory.

Stage 1 can accept this limitation for normal vault sizes, but the hashing abstraction must allow a streaming implementation later.

---

## 12.6 Initial scan

Algorithm:

```text
files = vault.getFiles()

for each file:
    read metadata {path, mtime, size}

    if saved manifest contains same path
       and saved mtime == current mtime
       and saved size == current size:
        reuse previous hash + fileId
    else:
        read bytes
        calculate SHA-256
        reuse old fileId when the file is known
        otherwise generate fileId

sort entries by normalized path

calculate manifestHash

POST sync plan
upload missing blobs
POST sync commit

save local manifest only after commit succeeds
```

Do not update the local "last synced manifest" after merely uploading blobs.

---

# 13. Incremental event handling

Listen for vault events:

```text
create
modify
delete
rename
```

Register them using plugin lifecycle registration so listeners are automatically removed on unload.

Events are hints, not the source of truth.

## 13.1 Event buffer

Do not sync every keystroke.

Use an event buffer:

```text
debounce: 2 seconds
maximum delay after first event: 10 seconds
```

Repeated modify events for the same path collapse into one dirty entry.

Example:

```text
modify A
modify A
modify A
modify B
        ↓
one reconciliation for A + B
```

---

## 13.2 Rename handling

When Obsidian reports a rename:

```text
oldPath → newPath
```

update the local manifest mapping so:

```text
same fileId
new path
```

The next commit lets the server record a `rename` file version rather than delete/create.

---

## 13.3 Delete handling

Remove the path from the candidate local manifest.

A deletion becomes authoritative only when a complete manifest commit succeeds.

---

# 14. Reconciliation

A correct sync system cannot depend solely on events.

Run full reconciliation:

- after plugin startup/layout ready,
- after reconnecting after network failure,
- after settings/server changes,
- manually when user presses **Sync now**,
- periodically while Obsidian is running.

Default periodic interval:

```text
10 minutes
```

Make it configurable later if needed.

Reconciliation compares:

```text
current vault files
        versus
saved local manifest
```

Use `mtime + size` as a fast "probably unchanged" test.

Only rehash files that appear changed.

This catches:

- missed events,
- plugin restarts,
- files changed while Obsidian/plugin was stopped,
- external filesystem modifications.

---

# 15. Sync protocol

Use versioned endpoints:

```text
/api/v1/...
```

Protocol types live in `@tephra/protocol`.

Validate every body with a runtime schema library such as:

```text
zod
```

---

## 15.1 Manifest entry

```ts
interface SyncManifestEntry {
  fileId: string;
  path: string;
  hash: string;
  size: number;
  mtime: number;
  mimeType?: string;
  kind: "markdown" | "attachment";
}
```

Manifest entries MUST be sorted by:

```text
path ascending, byte/codepoint deterministic ordering
```

Manifest hash:

```text
SHA-256(canonical JSON representation)
```

Do not rely on normal JavaScript object key iteration for canonicalization.

---

## 15.2 Plan endpoint

```http
POST /api/v1/vaults/{vaultId}/sync/plan
Authorization: Bearer <device-token>
Content-Type: application/json
```

Body:

```json
{
  "deviceId": "device_...",
  "manifestHash": "sha256...",
  "files": [
    {
      "fileId": "file_...",
      "path": "Notes.md",
      "hash": "abc...",
      "size": 1234,
      "mtime": 1788640000000,
      "kind": "markdown",
      "mimeType": "text/markdown"
    }
  ]
}
```

Response:

```json
{
  "status": "upload-required",
  "latestRevision": 17,
  "missingBlobs": [
    {
      "hash": "abc...",
      "size": 1234
    }
  ]
}
```

If the manifest already matches the remote latest revision:

```json
{
  "status": "up-to-date",
  "latestRevision": 17,
  "missingBlobs": []
}
```

The server MUST NOT create a revision during `plan`.

---

# 16. Blob upload API

Minimum universal endpoint:

```http
PUT /api/v1/vaults/{vaultId}/blobs/{sha256}
Authorization: Bearer <device-token>
Content-Type: application/octet-stream
X-Tephra-Blob-Size: <bytes>
```

The server:

1. checks token can upload to this vault,
2. checks configured max size,
3. streams bytes,
4. independently calculates SHA-256,
5. rejects if hash mismatches,
6. stores blob atomically,
7. inserts blob metadata if necessary,
8. returns idempotent success.

Response:

```json
{
  "hash": "abc...",
  "stored": true
}
```

If it already existed:

```json
{
  "hash": "abc...",
  "stored": false
}
```

---

## 16.1 Upload path

Uploads are proxied through the API to the filesystem blob store. Direct-to-
object-storage upload is dropped with the S3 live adapter (2026-09-06).

---

# 17. Commit endpoint

```http
POST /api/v1/vaults/{vaultId}/sync/commit
Authorization: Bearer <device-token>
```

Body contains the same complete manifest:

```json
{
  "deviceId": "device_...",
  "manifestHash": "...",
  "files": [...]
}
```

Server algorithm:

```text
BEGIN transaction

authorize token

lock/serialize updates for vault

if manifestHash == latest manifest hash:
    return existing latest revision

validate:
    no duplicate paths
    no duplicate file IDs
    every path is canonical
    every referenced blob exists
    blob size matches
    file kind is valid

load current vault_files

diff incoming manifest against current state by fileId/path

for each create:
    append file_versions(create)

for each modified blob:
    append file_versions(modify)

for each same fileId with changed path:
    append file_versions(rename)

for each current file absent from incoming manifest:
    append file_versions(delete)

revision = vault.latest_revision + 1

insert vault_revisions

replace/update vault_files to exactly match incoming manifest

update vault.latest_revision

COMMIT

index changed Markdown files

return revision
```

The transaction must make the current vault state all-or-nothing.

If indexing fails after commit, the vault commit remains valid and indexing is retried. Do not roll back uploaded user content because derived metadata failed.

---

# 18. Concurrency

Stage 1 is one-way, but multiple plugin devices may point at the same remote vault.

The server must serialize commits per vault.

For SQLite:

- transaction locking is sufficient in the single-process deployment
  (SQLite is the only database adapter; PostgreSQL/D1 dropped 2026-09-06).

Stage 1 conflict policy between two upload devices:

```text
latest successful complete manifest becomes the remote current state
```

However, the server MUST preserve revisions.

Do not delete older blobs/file versions.

This is not Stage 2 merge semantics; it is only a Stage 1 mirror rule.

The UI should optionally display the last syncing device and sync time so unexpected device behavior is visible.

---

# 19. Markdown indexing

Create a pure package:

```text
packages/markdown
```

Primary API:

```ts
interface ParsedNote {
  frontmatter: Record<string, unknown>;
  headings: HeadingInfo[];
  tags: string[];
  blocks: BlockInfo[];
  links: ParsedLink[];
}

function parseNote(markdown: string): ParsedNote;
```

This package must work in Node and the browser.

---

## 19.1 Code-aware parsing

Do not detect wikilinks/tags by blindly applying a regex to the entire Markdown string.

Wikilinks inside:

```markdown
`[[not a link]]`
```

or:

````markdown
```js
const x = "[[not a link]]";
```
````

must not become graph links.

Use a Markdown AST to identify ranges that are code/inline-code and exclude those ranges from Obsidian-specific token scanning.

---

## 19.2 Wikilink grammar

Support:

```text
[[Target]]
[[Target|Display]]
[[Target#Heading]]
[[Target#Heading|Display]]
[[Target#^block-id]]
[[Target#^block-id|Display]]

![[Target]]
![[image.png]]
![[Target#Heading]]
```

Parse into:

```ts
interface ParsedLink {
  raw: string;
  linkPath: string;
  subpath?: string;
  displayText?: string;
  isEmbed: boolean;
}
```

Examples:

```text
[[Project Alpha#Design|design doc]]
```

becomes:

```json
{
  "linkPath": "Project Alpha",
  "subpath": "Design",
  "displayText": "design doc",
  "isEmbed": false
}
```

---

# 20. Link resolution

Create a separate package:

```text
packages/link-resolver
```

One central resolver must be used by:

- note rendering,
- graph indexing,
- backlinks,
- future editor autocomplete,
- future plugin compatibility.

API:

```ts
interface ResolveLinkResult {
  targetFileId: string | null;
  targetPath: string | null;
  unresolved: boolean;
}

function resolveLink(
  sourcePath: string,
  linkPath: string,
  vaultIndex: VaultPathIndex
): ResolveLinkResult;
```

## 20.1 Resolution rules

Implement and test this deterministic approximation:

1. normalize separators and strip a trailing `.md` for comparison,
2. exact vault-relative path match,
3. exact path relative to source note's folder,
4. if link contains folders, match normalized suffix/path,
5. find Markdown files with matching basename,
6. if exactly one basename match exists, use it,
7. if multiple basename matches exist:
   - rank by longest common folder prefix with source,
   - then shortest path distance,
   - then lexical path as deterministic tie-breaker,
8. otherwise unresolved.

Keep the resolver implementation isolated because exact behavioral compatibility may need refinement against Obsidian test fixtures.

---

# 21. Dependency graph index

For each indexed Markdown note:

```text
source note
    ↓ every non-embed wikilink and normal internal Markdown link
target note
```

Store one `note_links` row per occurrence or deduplicate at query time.

Recommended Stage 1 graph semantics:

- node = Markdown file,
- edge = resolved note-to-note link,
- unresolved links excluded from main graph,
- embeds may use a visually distinct edge later but can initially be treated as links.

Graph endpoint:

```http
GET /api/v1/vaults/{vaultId}/graph
```

Response:

```json
{
  "revision": 17,
  "nodes": [
    {
      "id": "file_1",
      "path": "Notes/A.md",
      "title": "A"
    }
  ],
  "edges": [
    {
      "source": "file_1",
      "target": "file_2",
      "count": 2
    }
  ]
}
```

Aggregate multiple links between the same pair into `count`.

For Stage 1, returning the whole graph is acceptable up to a configurable limit such as 10,000 Markdown files.

Add pagination/subgraph queries later if real-world vaults require it.

---

# 22. Rendering pipeline

Create:

```ts
async function renderMarkdown(input: {
  markdown: string;
  sourcePath: string;
  vaultIndex: VaultPathIndex;
  attachmentUrl: (fileId: string) => string;
}): Promise<RenderedNote>;
```

The output MUST be sanitized.

Pipeline:

```text
Markdown
  ↓
remark parse
  ↓
GFM/frontmatter/math plugins
  ↓
Tephra wikilink/embed transform
  ↓
remark → rehype
  ↓
safe Obsidian-specific transforms
  ↓
KaTeX if enabled
  ↓
rehype sanitize
  ↓
HTML
```

Do not allow scripts.

Do not pass arbitrary inline event handlers.

---

## 22.1 Raw HTML

Stage 1 default:

```text
raw HTML disabled or restricted to a sanitized allowlist
```

Correctness/security priority:

```text
security > exact Obsidian HTML rendering compatibility
```

Document unsupported HTML behavior in the user README.

---

## 22.2 Attachments

Render common safe media:

- PNG,
- JPEG,
- GIF,
- WebP,
- AVIF if browser-supported,
- audio/video only if served with appropriate headers,
- PDF as link initially.

Treat SVG conservatively because it can contain executable content.

Recommended Stage 1 behavior:

```text
SVG attachments are served as download links, not embedded inline.
HTML attachments are downloads, not rendered inline.
```

---

## 22.3 Content endpoint

```http
GET /api/v1/vaults/{vaultId}/files/{fileId}/content
```

For Markdown, return original Markdown bytes/text.

For attachments, use a separate authenticated blob/content response.

Security headers:

```text
X-Content-Type-Options: nosniff
Content-Security-Policy: sandbox
```

where appropriate.

Future Tephra Cloud SHOULD serve user-controlled attachments from a cookieless content origin such as:

```text
content.tephra.example
```

rather than the account/auth origin.

---

# 23. Web API

Minimum authenticated Stage 1 API.

## Authentication

```text
POST   /api/v1/auth/bootstrap
POST   /api/v1/auth/login
POST   /api/v1/auth/logout
GET    /api/v1/auth/me
```

## Vaults

```text
GET    /api/v1/vaults
POST   /api/v1/vaults
GET    /api/v1/vaults/:vaultId
DELETE /api/v1/vaults/:vaultId
```

Vault deletion is allowed from the server UI because it does not mutate the local Obsidian vault.

Require an explicit confirmation.

## Plugin/device tokens

```text
GET    /api/v1/vaults/:vaultId/tokens
POST   /api/v1/vaults/:vaultId/tokens
DELETE /api/v1/vaults/:vaultId/tokens/:tokenId
```

The raw token is shown only once after creation.

## Sync

```text
POST   /api/v1/vaults/:vaultId/sync/plan
PUT    /api/v1/vaults/:vaultId/blobs/:hash
POST   /api/v1/vaults/:vaultId/sync/commit
```

## Browsing

```text
GET    /api/v1/vaults/:vaultId/files
GET    /api/v1/vaults/:vaultId/files/:fileId
GET    /api/v1/vaults/:vaultId/files/:fileId/content
GET    /api/v1/vaults/:vaultId/files/:fileId/rendered
GET    /api/v1/vaults/:vaultId/graph
GET    /api/v1/vaults/:vaultId/links
```

---

# 24. Authentication

Stage 1 must support self-hosting without requiring an external identity provider.

## 24.1 Bootstrap flow

On first deployment there are no users.

Environment variable:

```text
TEPHRA_BOOTSTRAP_TOKEN=<random secret>
```

First visit to the server:

```text
no users exist
    ↓
show bootstrap page
    ↓
user supplies bootstrap token
    ↓
create first admin account
    ↓
bootstrap endpoint becomes permanently unavailable
```

Never accept the bootstrap token once a user exists.

For local Docker convenience, if `TEPHRA_BOOTSTRAP_TOKEN` is omitted, the Node entrypoint MAY generate one and print it once to stdout.

Do not do this in hosted multi-tenant mode.

---

## 24.2 Password hashing

Keep password hashing behind:

```ts
interface PasswordHasher
```

Choose a production-suitable Node implementation (the server is Node-only;
serverless/edge runtimes are not supported targets).

Do not store plaintext passwords.

---

## 24.3 Browser sessions

Use:

```text
HttpOnly
Secure in HTTPS deployments
SameSite=Lax
```

cookies.

Use CSRF protection for state-changing browser endpoints.

Plugin bearer-token API endpoints do not use cookie auth.

---

# 25. Tephra web application

## 25.1 Routes

Minimum routes:

```text
/
  redirect to /vaults or /login

/login
/setup

/vaults

/vaults/:vaultId
/vaults/:vaultId/note/:fileId
/vaults/:vaultId/graph

/settings
/settings/tokens
```

The main vault route can use panes instead of separate full-page navigation.

---

## 25.2 File tree

Fetch:

```text
GET /api/v1/vaults/:vaultId/files
```

Return flat file entries.

Build the folder hierarchy client-side.

Requirements:

- directories first,
- alphabetical sorting,
- collapsible folders,
- current note highlighted,
- hide unsupported internal metadata,
- attachment files visible.

Do not infer folder identity from a database folder table; folders can be reconstructed from paths in Stage 1.

---

## 25.3 Note viewer

When user opens a Markdown file:

1. update route to include file ID,
2. fetch rendered note or raw + renderer data,
3. show note title,
4. render HTML,
5. intercept internal Tephra links,
6. navigate without full-page reload.

Clicking an unresolved link should show a non-destructive message such as:

```text
Note not found: Foo
```

Do not create it.

---

## 25.4 Graph

Use Sigma.

Requirements:

- pan,
- zoom,
- hover label,
- click node to open note,
- highlight direct neighbors,
- graph can be shown below note or on dedicated graph route.

Do not spend Stage 1 effort reproducing every Obsidian graph control.

A basic usable graph is sufficient.

---

# 26. Indexing lifecycle

After a vault commit:

```text
changed Markdown blobs
        ↓
parse note metadata
        ↓
update note_metadata
        ↓
delete old outgoing note_links
        ↓
insert newly parsed links
        ↓
resolve targets using current vault path index
        ↓
re-resolve unresolved links affected by changed paths
```

Important:

A rename can change link resolution even if the source note was not modified.

After any commit that adds/deletes/renames Markdown files, run a vault-level link resolution pass.

Optimization later:

- only recalculate candidate links whose target basename/path may have changed.

Correctness first.

---

# 27. Indexing failure model

Index data is derived.

Therefore:

```text
vault bytes committed successfully
indexing fails
```

must result in:

```text
sync success with index pending/degraded
```

not loss of the commit.

Store an index state:

```text
vault_index_state
  indexed_revision
  last_error
```

If:

```text
indexed_revision < vault.latest_revision
```

the server should retry indexing.

For the initial single-process Node implementation, retry:

- immediately once,
- then on application startup,
- then periodically every few minutes.

A distributed queue is not required in Stage 1.

---

# 28. Self-host deployment profiles

The project MUST document these profiles.

## 28.1 Profile A — single-container VPS

This is the primary development target.

```text
Database: SQLite
Blobs: local filesystem
Web: served by same container
API: Node/Hono
```

Environment:

```text
TEPHRA_DATABASE_DRIVER=sqlite
TEPHRA_SQLITE_PATH=/data/tephra.db
TEPHRA_BLOB_DRIVER=filesystem
TEPHRA_BLOB_PATH=/data/blobs
TEPHRA_PUBLIC_URL=https://notes.example.com
TEPHRA_SESSION_SECRET=...
TEPHRA_BOOTSTRAP_TOKEN=...
```

Docker volume:

```text
/data
```

The whole installation can be backed up by backing up this volume while the service is stopped, or using a documented consistent SQLite backup process plus blob directory backup.

---

## 28.2 Profile B — Railway

Supported simple mode:

```text
Tephra Docker image
+ Railway persistent volume mounted at /data
```

Same config as VPS.

Document clearly:

- single instance only when using SQLite/local blobs,
- more tenants means more services, each with its own volume (never share
  one volume across services or replicas).

---

## 28.3 Profile C — AWS (disk-only)

Simple:

```text
Lightsail/EC2
Docker
SQLite/local disk
```

Larger single-tenant:

```text
ECS/Fargate + EFS access point at /data, or EC2 + EBS
private S3 for snapshot tarballs only (never live blobs)
```

Do not require anything beyond one disk for self-host users. Multi-tenant
hosting is more copies of the single-disk shape (plan 004), never a shared
RDS/S3 backend.

---

## 28.4 Profile D — GCP (disk-only)

```text
Compute Engine VM + Persistent Disk at /data, or
Cloud Run (min=max=1) + Filestore NFS at /data
private GCS for snapshot tarballs only (never live blobs)
```

Same single-disk rules as AWS. See `tephra-server/deploy/gcp/`.

---

# 29. Docker image

Build one production image for Node deployments.

Desired usage:

```bash
docker run \
  --name tephra \
  -p 8080:8080 \
  -v tephra-data:/data \
  -e TEPHRA_PUBLIC_URL=http://localhost:8080 \
  -e TEPHRA_SESSION_SECRET=change-me \
  -e TEPHRA_BOOTSTRAP_TOKEN=change-me \
  ghcr.io/<org>/tephra:latest
```

Default image behavior:

```text
SQLite
filesystem blob store
/data
```

The image should contain built web assets.

The Node server should serve:

```text
/api/*
static SPA assets
```

from one port.

---

# 30. Configuration

Use environment variables.

Minimum (disk-only; amended 2026-09-06 — no DATABASE_URL/S3 variables exist):

```text
TEPHRA_PUBLIC_URL
TEPHRA_SESSION_SECRET

TEPHRA_DATABASE_DRIVER (sqlite only)
TEPHRA_SQLITE_PATH

TEPHRA_BLOB_DRIVER (filesystem only)
TEPHRA_BLOB_PATH

TEPHRA_BOOTSTRAP_TOKEN

TEPHRA_MAX_BLOB_BYTES
```

Defaults:

```text
TEPHRA_DATABASE_DRIVER=sqlite
TEPHRA_SQLITE_PATH=/data/tephra.db

TEPHRA_BLOB_DRIVER=filesystem
TEPHRA_BLOB_PATH=/data/blobs

TEPHRA_MAX_BLOB_BYTES=104857600
```

Default max blob:

```text
100 MiB
```

Self-hosters can increase it.

Hosted Tephra Cloud can impose plan-specific limits later.

---

# 31. Compatibility fixture vault

Create a permanent test fixture:

```text
packages/test-fixtures/compat-vault/
```

It MUST contain cases for:

```text
Root.md
Simple.md

Folders/
  Alpha.md
  Beta.md

Duplicate/
  A/Shared.md
  B/Shared.md

Links/
  Aliases.md
  Headings.md
  Blocks.md
  Embeds.md
  Unresolved.md

Markdown/
  Tables.md
  Tasks.md
  Code.md
  Math.md
  Callouts.md
  Frontmatter.md
  Tags.md

Attachments/
  image.png
  sample.pdf

Unicode/
  Café.md
  日本語.md
  Spaces in name.md
```

Test examples:

```markdown
[[Simple]]
[[Folders/Alpha]]
[[Alpha]]
[[Simple|Custom label]]
[[Headings#Section One]]
[[Blocks#^block-one]]
![[Embeds]]
![[Attachments/image.png]]
[[Does Not Exist]]
```

Also include tokens inside code blocks that MUST NOT resolve.

---

# 32. Unit tests

Minimum unit test suites.

## 32.1 Paths

Test:

- normalization,
- Unicode,
- spaces,
- rejection of traversal,
- rejection of absolute paths.

## 32.2 Manifest canonicalization

Given the same set of entries in different input order:

```text
manifestHash MUST be identical
```

Any metadata/content change:

```text
manifestHash MUST change
```

## 32.3 Wikilink parser

Every supported syntax variant.

## 32.4 Link resolver

Test:

- exact path,
- relative path,
- unique basename,
- duplicate basename,
- nearest path,
- unresolved link,
- Unicode.

## 32.5 Markdown safety

Test that rendered Markdown cannot emit:

```html
<script>
<img onerror=...>
<a href="javascript:...">
```

## 32.6 Revision diff

Test:

- create,
- modify,
- delete,
- rename,
- identical manifest no-op.

---

# 33. Integration tests

Run API against:

```text
SQLite
filesystem BlobStore
```

Required scenarios:

### Initial sync

```text
empty server
→ upload 10-file manifest
→ upload blobs
→ commit
→ revision 1
→ all files browseable
```

### Idempotent sync

```text
same manifest
→ no uploads
→ no new revision
```

### Modify

```text
change one Markdown file
→ only one new blob required
→ revision increments
→ old file version remains
```

### Rename

```text
same fileId
old path → new path
→ rename FileVersion
→ graph re-resolves
```

### Delete

```text
file absent from new manifest
→ removed from vault_files
→ delete FileVersion retained
```

### Failed blob upload

```text
wrong bytes for declared SHA-256
→ rejected
→ commit cannot reference nonexistent blob
```

### Server restart

```text
sync
restart process
browse vault
→ identical state
```

---

# 34. End-to-end tests

Use Playwright against Docker or local Node server.

Required:

1. bootstrap account,
2. login,
3. create vault,
4. seed vault through sync API,
5. open vault,
6. expand folders,
7. open note,
8. click `[[wikilink]]`,
9. verify destination note,
10. open graph,
11. click node,
12. verify note navigation.

Plugin-specific end-to-end testing inside Obsidian may be partly manual initially.

Mock the Obsidian Vault API for automated plugin sync logic tests.

---

# 35. Observability

Use structured JSON logs on the server.

Every request should have:

```text
request_id
```

Relevant sync logs:

```text
vault_id
device_id
manifest_hash
revision
changed_file_count
uploaded_blob_count
duration_ms
```

Never log:

- bearer tokens,
- session cookies,
- note contents,
- passwords.

Health endpoints:

```text
GET /healthz
GET /readyz
```

`readyz` should validate database connectivity and writable blob storage if feasible without expensive operations.

---

# 36. Privacy and security requirements

## 36.1 Private by default

All vaults are private in Stage 1.

Every vault/file/graph endpoint checks ownership/authorization.

Never rely only on a random vault ID as authorization.

---

## 36.2 Least-privilege plugin token

A stolen plugin token should not permit:

- changing account password,
- viewing other vaults,
- creating billing actions,
- deleting account.

Scope it to one vault.

Tokens must be revocable.

---

## 36.3 Hash verification

Do not trust:

```text
hash
size
mime type
path
```

from the plugin without server validation.

Mime type is metadata/hint only.

---

## 36.4 Markdown XSS

All Markdown rendering is untrusted content.

Sanitize output.

Never render user-provided JavaScript.

This matters even for a single-user installation because synced vault content may contain copied malicious HTML.

---

## 36.5 Attachment safety

Do not execute attachments.

Use `nosniff`.

Do not inline arbitrary HTML/SVG on the authenticated application origin.

---

## 36.6 CORS

Browser web UI should use same-origin API when possible.

Plugin requests are not normal browser page requests and should use Obsidian-supported network APIs.

Do not enable:

```text
Access-Control-Allow-Origin: *
```

on authenticated cookie endpoints.

---

# 37. Tephra Cloud compatibility requirements

Although Stage 1 is open-source/self-host-first, do not make assumptions that prevent a centralized hosted deployment.

The schema and APIs MUST support:

```text
many users (one instance + one disk per tenant; plan 003)
many vaults per user
many devices
offline snapshot copies to object storage (plan 005)
```

Do not put user state into process-global singleton variables.

Do not use local filesystem paths for current vault semantics.

Only the filesystem BlobStore adapter may depend on local disk.

---

# 38. Future Tephra Publish compatibility

Publishing is not Stage 1, but Stage 1 must create reusable components.

Future publishing should be able to call:

```ts
renderVaultFile(vaultId, revision, fileId)
```

without running the private React app.

Therefore:

- Markdown rendering belongs in a shared package,
- link resolution belongs in a shared package,
- attachment resolution is injected,
- renderer cannot require a user browser session,
- vault reads are revision-addressable internally.

Future flow:

```text
choose vault revision
       ↓
choose root/subtree
       ↓
generate public routing map
       ↓
render notes
       ↓
serve dynamic pages OR produce static output
```

Do not implement public routes now.

---

# 39. Stage 2 reserved design

The following decisions are intentionally preserved by Stage 1.

## 39.1 Bidirectional sync baseline

Stage 2 will track:

```text
base revision
base blob
local blob
remote blob
```

and use three-way merge.

The Stage 1 `file_versions` table and immutable blob storage provide these historical baselines.

---

## 39.2 Web editing

Stage 2 may add CodeMirror 6.

A web edit will become a normal vault revision.

Expected future API shape:

```text
baseHash
new content
optimistic concurrency
```

Do not implement now.

---

## 39.3 Conflict handling

Future Markdown conflict algorithm:

```text
base
local
remote
    ↓
diff3
```

If automatic merge fails:

```text
preserve both versions
```

Never silently last-write-wins for Stage 2.

---

## 39.4 Obsidian-compatible plugin API

Future package:

```text
@tephra/obsidian-compat
```

Potential supported types:

```text
App
Vault
TFile
TFolder
MetadataCache
Plugin
Component
MarkdownRenderer
Workspace
```

Third-party plugin execution must be sandboxed.

Do not start this in Stage 1.

---

# 40. Implementation phases

A coding agent should implement in this order.

---

## Phase 0 — repository scaffolding

### Deliverables

- [ ] create `tephra-server`
- [x] configure npm workspace
- [ ] configure TypeScript strict mode
- [ ] configure ESLint
- [ ] configure Prettier
- [ ] configure Vitest
- [ ] create CI workflow
- [ ] create AGPL license placeholder/recommended license
- [ ] create packages listed in repository layout
- [ ] create `tephra-plugin`
- [ ] create protocol package consumption mechanism

### Exit criteria

```bash
npm ci
npm run lint
npm run test
npm run build
```

all succeed from a clean checkout.

---

# 41. Phase 1 — core storage server

Implement:

- [ ] IDs
- [ ] clock abstraction
- [ ] path validation
- [ ] SHA-256 utilities
- [ ] SQLite database adapter
- [ ] filesystem BlobStore
- [ ] migrations
- [ ] Hono Node entrypoint
- [ ] `/healthz`
- [ ] bootstrap auth
- [ ] sessions
- [ ] vault CRUD
- [ ] device token CRUD

### Exit criteria

A Docker-launched server can:

```text
bootstrap
login
create vault
create upload token
restart
retain all state
```

---

# 42. Phase 2 — sync protocol

Implement:

- [ ] protocol schemas
- [ ] canonical manifest serialization
- [ ] `sync/plan`
- [ ] blob upload
- [ ] server SHA-256 verification
- [ ] `sync/commit`
- [ ] revision diff
- [ ] `vault_files`
- [ ] `file_versions`
- [ ] idempotent manifest commit

### Exit criteria

An integration test can mirror a directory into a Tephra vault through API calls and correctly handle:

```text
create
modify
rename
delete
```

Do not build the Obsidian plugin until this protocol works using tests/CLI fixtures.

---

# 43. Phase 3 — Markdown model/index

Implement:

- [ ] Markdown AST parsing
- [ ] frontmatter
- [ ] headings
- [ ] tags
- [ ] wikilinks
- [ ] embeds
- [ ] block IDs
- [ ] path index
- [ ] link resolver
- [ ] note metadata persistence
- [ ] note links persistence
- [ ] index revision state
- [ ] indexing after commit

### Exit criteria

The compatibility fixture vault produces deterministic expected:

```text
metadata
resolved links
unresolved links
graph edges
```

---

# 44. Phase 4 — safe renderer

Implement:

- [ ] unified rendering pipeline
- [ ] GFM
- [ ] frontmatter handling
- [ ] Tephra wikilink transform
- [ ] attachment transform
- [ ] embeds
- [ ] sanitization
- [ ] XSS tests
- [ ] rendered API endpoint

### Exit criteria

Fixture notes render safely and all supported internal links navigate using Tephra file IDs.

---

# 45. Phase 5 — web viewer

Implement:

- [ ] login/setup screens
- [ ] vault list
- [ ] vault layout
- [ ] file tree
- [ ] note viewer
- [ ] internal navigation
- [ ] attachment viewing
- [ ] graph API
- [ ] Sigma graph
- [ ] click graph node → note

### Exit criteria

A user can navigate the entire fixture vault from a browser without opening Obsidian.

---

# 46. Phase 6 — Obsidian plugin

Implement:

- [ ] plugin settings
- [ ] server URL
- [ ] upload token
- [ ] test connection
- [ ] select/create remote vault
- [ ] local manifest storage
- [ ] initial scan
- [ ] hashing
- [ ] sync plan
- [ ] blob upload
- [ ] commit
- [ ] status reporting
- [ ] event listeners after layout ready
- [ ] debounced reconciliation
- [ ] periodic reconciliation
- [ ] retries
- [ ] manual Sync Now

### Exit criteria

Against a local Tephra server:

1. install plugin,
2. connect token,
3. sync a real test vault,
4. open Tephra in browser,
5. see files/notes/graph,
6. edit local note,
7. within the debounce/reconciliation window, browser sees updated content,
8. rename local note,
9. remote path updates,
10. delete local note,
11. remote copy disappears from current file tree.

---

# 47. Phase 7 — self-host packaging

Implement/document:

- [ ] production Dockerfile
- [ ] persistent `/data`
- [ ] Docker Compose example
- [ ] automatic migrations on startup with safe locking
- [ ] backup guide
- [ ] upgrade guide
- [ ] Railway template/config
- [ ] generic VPS guide
- [ ] AWS guide
- [ ] GCP guide (Compute Engine + Cloud Run)
- [ ] snapshot backup/restore guide
- [ ] environment variable reference

### Exit criteria

At least these must be continuously tested:

```text
Docker + SQLite + filesystem
Railway volume smoke
AWS and GCP disk smokes
```

---

# 48. Phase 8 — release hardening

- [ ] rate/size limits
- [ ] clean error messages
- [ ] token revocation
- [ ] recovery from interrupted sync
- [ ] orphan upload handling
- [ ] structured logs
- [ ] privacy policy template
- [ ] plugin README network/account disclosure
- [ ] server README
- [ ] threat model
- [ ] dependency audit
- [ ] security headers
- [ ] compatibility matrix
- [ ] manual mobile Obsidian test if `isDesktopOnly=false`

---

# 49. Sync error semantics

Use machine-readable error codes.

Example:

```json
{
  "error": {
    "code": "BLOB_HASH_MISMATCH",
    "message": "Uploaded content does not match the declared SHA-256 hash."
  }
}
```

Required codes:

```text
AUTH_REQUIRED
TOKEN_REVOKED
VAULT_NOT_FOUND
VAULT_ACCESS_DENIED
INVALID_PATH
INVALID_MANIFEST
DUPLICATE_PATH
DUPLICATE_FILE_ID
BLOB_TOO_LARGE
BLOB_HASH_MISMATCH
BLOB_MISSING
COMMIT_FAILED
INDEX_PENDING
INTERNAL_ERROR
```

The plugin should classify failures:

### Retryable

```text
network error
HTTP 429
HTTP 5xx
timeout
```

### Non-retryable until user action

```text
401
403
invalid server URL
revoked token
blob too large
```

Use exponential backoff with jitter.

Example:

```text
2s
5s
10s
30s
60s
max 5 minutes
```

A manual **Sync now** bypasses the current timer.

---

# 50. Plugin UI requirements

Settings page:

```text
Tephra Server
[ https://tephra.example.com ]

Access Token
[ ************************ ]

[Test connection]

Remote Vault
[ My Vault ▼ ]

Sync Status
Connected
Last sync: 30 seconds ago
Revision: 42

[Sync now]
[Disconnect]
```

If no vault is selected:

```text
[Create remote vault]
```

Status bar item is optional.

Do not show intrusive notices on every successful sync.

Use notices only for:

- first successful connection,
- authentication failure,
- persistent sync error.

---

# 51. Remote vault deletion semantics

Deleting a remote vault from Tephra:

- deletes Tephra's current view,
- does NOT touch the local vault,
- plugin next sync MUST fail with `VAULT_NOT_FOUND`,
- plugin UI prompts the user to select/create another remote vault.

Do not automatically recreate a deleted remote vault without confirmation.

For safety, actual blob garbage collection can be delayed.

---

# 52. Blob retention / garbage collection

Because history is being preserved:

- blobs referenced by `vault_files` are live,
- blobs referenced by `file_versions` are historical and live,
- recently uploaded blobs referenced by neither may be abandoned uploads.

Stage 1 garbage collector may delete only blobs that:

```text
have no database references
AND were uploaded more than 7 days ago
```

Run GC manually or periodically.

Do not aggressively prune revision history in Stage 1.

---

# 53. Backup and restore

## Single-container mode

Required documented backup unit:

```text
SQLite database
+
blob directory
```

The backup must represent a mutually consistent point in time.

Simplest documented method:

1. stop Tephra,
2. copy `/data`,
3. start Tephra.

Later add online SQLite backup tooling.

Restore:

1. stop Tephra,
2. restore `/data`,
3. start same/newer compatible Tephra,
4. migrations run,
5. verify `/readyz`.

---

# 54. Performance targets

These are design targets, not strict public SLAs.

Reference vault:

```text
10,000 files
5,000 Markdown notes
5 GB attachments
```

Targets:

- unchanged reconciliation should avoid reading/hashing all file bytes,
- initial file tree API under ~1 second on ordinary self-host hardware after DB warm-up,
- opening a normal note should feel immediate after request round trip,
- graph rendering with several thousand nodes remains interactive,
- sync memory use should not require loading the whole vault at once.

For initial full manifest, metadata for 10k–50k files may be sent in one request.

If practical limits appear, add chunked manifests later without changing domain semantics.

---

# 55. API compatibility/versioning

All public protocol endpoints are under:

```text
/api/v1
```

The plugin sends:

```text
X-Tephra-Plugin-Version
X-Tephra-Protocol-Version
```

Server response may include:

```text
minimumPluginVersion
protocolVersion
```

Do not silently introduce incompatible sync protocol changes.

---

# 56. Database migration policy

Every schema change requires a migration.

Node startup:

```text
acquire migration lock
run pending migrations
start serving
```

For a single SQLite server, only one Tephra process may use automatic migration at a time.

Never edit previously released migrations.

Test migration:

```text
previous release schema
→ current release
```

in CI after the first public release.

---

# 57. CI/CD

GitHub Actions minimum jobs:

```text
lint
typecheck
unit-test
integration-test-sqlite
web-e2e
build-node
build-web
build-plugin
docker-build
```

On tagged release:

```text
GitHub release
Docker image → GHCR
plugin release assets
checksums
```

Plugin release assets should follow Obsidian community plugin expectations when ready for directory submission.

---

# 58. README requirements

## `tephra-server` README

Must explain:

- what Tephra is,
- Stage 1 read-only behavior,
- self-host quick start,
- Docker command,
- environment variables,
- backup,
- supported storage adapters,
- privacy model,
- limitations,
- how Tephra Cloud differs,
- Stage 2 roadmap.

## `tephra-plugin` README

Must disclose clearly:

- account/network access is required for remote Tephra usage,
- which server receives vault contents,
- user may point the plugin at a self-hosted server,
- the plugin uploads visible vault files,
- Stage 1 does not write files back,
- how to revoke a token,
- privacy policy for Tephra Cloud if/when centralized hosting is used.

This is important for Obsidian community plugin policies regarding network services/accounts.

---

# 59. Definition of Done for Stage 1

Stage 1 is complete only when all of the following are true.

## Open-source server

- [ ] repository is publicly buildable
- [ ] license included
- [ ] `docker run` can start a useful single-node installation
- [ ] SQLite/local blob setup needs no external database
- [ ] persistent data survives restart
- [ ] first-user bootstrap works
- [ ] vault/token management works

## Plugin

- [ ] can point to arbitrary self-hosted Tephra URL
- [ ] can authenticate with vault-scoped token
- [ ] initial sync works
- [ ] create/modify/delete/rename are reflected remotely
- [ ] missed events are repaired by reconciliation
- [ ] local vault is never modified
- [ ] sync survives restart/network interruption

## Viewer

- [ ] file tree works
- [ ] Markdown note rendering works
- [ ] supported wikilinks work
- [ ] images/attachments work safely
- [ ] dependency graph works
- [ ] unresolved links do not crash viewer
- [ ] malicious Markdown cannot execute arbitrary script in app origin

## Architecture

- [ ] every commit has a revision
- [ ] file history points to immutable blobs
- [ ] database interface is adapter-based
- [ ] blob store is adapter-based
- [ ] renderer is shared/reusable
- [ ] link resolver is shared/reusable
- [ ] system is multi-user/multi-vault capable
- [ ] no Stage 2 writeback/plugin runtime code has leaked into Stage 1

## Deployment

- [ ] Docker/VPS deployment documented and tested
- [ ] Railway volume deployment documented
- [ ] AWS options documented
- [ ] AWS disk deployment documented
- [ ] GCP disk deployment documented
- [ ] snapshot backup/restore documented and drilled

---

# 60. Recommended first coding-agent prompt

Once the repository is empty, give a coding agent this document plus the following instruction:

```text
Implement Tephra Stage 1 exactly according to TEPHRA_STAGE1_PLAN.md.

Work phase by phase. Do not implement Stage 2 functionality.

Start with Phase 0 and Phase 1 only.

For every phase:
1. implement the code,
2. add tests,
3. run lint/typecheck/tests/build,
4. update a PROGRESS.md file with completed checklist items,
5. do not mark an item complete if it is untested.

Prefer the simplest portable implementation that satisfies the architecture.
Do not introduce infrastructure not required by the plan.
Do not bypass adapter boundaries for convenience.
```

Then proceed with separate agent iterations:

```text
Continue with Phase 2.
Continue with Phase 3.
...
```

This is preferable to asking an agent to implement the entire system in one unconstrained pass.

---

# 61. Implementation invariants

These should appear in code comments/tests where relevant.

```text
INVARIANT 1:
A Stage 1 Tephra server never causes a local vault mutation.

INVARIANT 2:
A successful commit represents one complete current-vault manifest.

INVARIANT 3:
A remote revision is immutable after commit.

INVARIANT 4:
Every blob is addressed and verified by SHA-256.

INVARIANT 5:
Derived indexes can be deleted and rebuilt without losing user data.

INVARIANT 6:
Current vault paths are unique within a vault.

INVARIANT 7:
A rename preserves fileId when the plugin knows the identity.

INVARIANT 8:
User Markdown is untrusted input.

INVARIANT 9:
A plugin upload token is scoped to one vault.

INVARIANT 10:
SQLite + filesystem is a first-class production configuration for small self-hosts, not merely a development mode.
```

---

# 62. Architecture summary

Final Stage 1 architecture:

```text
                        LOCAL DEVICE

┌───────────────────────────────────────────────────┐
│ Obsidian                                          │
│                                                   │
│ Vault                                              │
│   ├── Notes.md                                    │
│   ├── Projects/...                                │
│   └── Attachments/...                             │
│          │                                        │
│          ▼                                        │
│ Tephra Sync plugin                                │
│   - scan/reconcile                                │
│   - SHA-256                                       │
│   - full manifest                                 │
│   - incremental blob upload                       │
│   - NO local writes                               │
└───────────────────┬───────────────────────────────┘
                    │ HTTPS
                    ▼

                        TEPHRA SERVER

┌───────────────────────────────────────────────────┐
│ Hono API                                          │
│                                                   │
│  ┌──────────────────┐    ┌────────────────────┐  │
│  │ Database adapter │    │ BlobStore adapter  │  │
│  │                  │    │                    │  │
│  │ SQLite (only)    │    │ filesystem (only)  │  │
│  └────────┬─────────┘    └──────────┬─────────┘  │
│           │                         │             │
│           └────────────┬────────────┘             │
│                        ▼                          │
│                 Vault revision model             │
│                        │                          │
│                        ▼                          │
│               Markdown/index pipeline            │
│                  │             │                  │
│                  ▼             ▼                  │
│             metadata        link graph            │
│                        │                          │
│                        ▼                          │
│               safe shared renderer               │
└────────────────────────┬──────────────────────────┘
                         │
                         ▼

                       WEB CLIENT

┌───────────────────────────────────────────────────┐
│ File tree     │ Note viewer                       │
│               │                                   │
│               │                                   │
├───────────────┴───────────────────────────────────┤
│ Dependency / knowledge graph                      │
└───────────────────────────────────────────────────┘
```

The same server core later becomes:

```text
Self-hosted Tephra
        +
Tephra Cloud hosted operations/billing
        +
Tephra Publish
        +
Stage 2 web editing/bidirectional sync
        +
Stage 2 browser-safe plugin compatibility
```

without changing the fundamental vault storage model.

---

# 63. References and implementation notes

The implementation should verify current upstream APIs while coding.

Useful current documentation:

- Obsidian developer documentation: https://docs.obsidian.md/
- Obsidian Vault API guide: https://docs.obsidian.md/Plugins/Vault
- Obsidian plugin lifecycle guide: https://docs.obsidian.md/plugins/guides/lifecycle-management
- Obsidian plugin submission requirements: https://docs.obsidian.md/community-directory/submission-requirements-for-plugins
- Obsidian community developer policies: https://docs.obsidian.md/community-directory/developer-policies
- Obsidian manifest reference: https://docs.obsidian.md/Reference/Manifest

Do not copy proprietary Obsidian implementation code.

Treat the public Obsidian APIs and documented vault syntax/behavior as compatibility targets, and implement Tephra independently.

---

# 64. Final scope statement

**Stage 1 is successful when Tephra is a reliable, self-hostable, one-way cloud mirror and web browser for an Obsidian vault.**

The product should feel useful before any bidirectional synchronization exists.

The core value proposition is:

```text
Keep writing locally in Obsidian.
Install Tephra Sync.
Point it at your own server or Tephra Cloud.
Open your notes, links, files, and graph from any browser.
```

Everything that risks local-data corruption—remote editing, writeback, merge/conflict handling, and third-party plugin execution—remains deliberately outside Stage 1.
