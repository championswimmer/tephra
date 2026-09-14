# 016 — Graph payload cache (server materialized + client IndexedDB) and cold-start fixes

## Scope

Cut graph cold-start time on both ends of the wire:

1. **Lane A — server materialized graph cache.** The `GET /api/v1/vaults/:vaultId/graph`
   handler in `tephra-server/apps/api/src/app.ts` (~line 949) rebuilds the payload from
   three queries (`vaultFiles.listByVault` + `noteIndex.listMetadata` + `noteIndex.listLinks`)
   plus aggregation on every cold load. Materialize one row per vault, keyed by
   `(revision, indexedRevision)`, and serve it directly on a hit.
2. **Lane B — client IndexedDB graph cache (stale-while-revalidate).** `ApiClient.graph`
   (`tephra-server/apps/web/src/api/client.ts` ~line 120) keeps the ETag/body only in a
   memory `Map`, so every page reload pays full download + parse + `buildGraphModel`.
   Persist `{etag, body}` per vault in IndexedDB; paint stale instantly, revalidate in
   the background.
3. **Lane C — cold-start quick wins.** Cap the unconditional fallback `<ul>` DOM list in
   `GraphView.tsx` (~line 270, one `<button>` per note, up to 10k nodes) and replace the
   `signatureFor` mega-string in `packages/graph-renderer/src/renderer.ts` (~line 151)
   with a cheap incremental comparison.

## Non-goals

- No layout/position persistence across sessions (first paint is already static — the
  renderer settles immediately on `setModel` — so cached positions buy almost nothing).
- No payload format change (`GraphResponse` / `graphResponseSchema` untouched); no new
  public routes; no worker/offscreen rendering.
- No web-to-vault writes, merging, or plugin execution (Stage 1 read-only invariant holds:
  the server cache is pure derived state, rebuildable from vault content at any time).

## Design

### Lane A — server cache

- New migration `tephra-server/migrations/sqlite/004_graph_cache.sql`:
  `vault_graph_cache(vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL, indexed_revision INTEGER NOT NULL, etag TEXT NOT NULL,
  payload_json TEXT NOT NULL, updated_at INTEGER NOT NULL)`.
  Register as version 4 in `packages/database/sqlite/src/index.ts` (`MIGRATIONS`).
- `packages/database/core/src/index.ts` (must stay browser-safe — types only): add
  `GraphCacheEntry` + `GraphCacheRepository { find(vaultId), upsert(entry),
  deleteByVault(vaultId) }`, expose on `Repositories` (hence `TransactionRepositories`).
- SQLite implementation in `packages/database/sqlite/src/index.ts` next to `noteIndex`.
- Extract the pure payload builder out of the `app.ts` graph handler into
  `@tephra/indexer` as `buildGraphPayload({ files, metadataRows, links, latestRevision,
  indexedRevision })` returning the exact current JSON shape (`revision`, `truncated`,
  optional `indexPending`, `nodes`, `edges`). The handler keeps ETag computation
  (`W/"<rev>-<indexed>-graph-v2"`) and the 304 path unchanged, then: cache hit with
  matching `(revision, indexedRevision)` → return stored JSON with ETag; else run the
  three queries, build, `upsert` the cache, return.
- Recalculation trigger: `createRuntimeIndexService.indexVault`
  (`tephra-server/apps/api/src/runtime-index.ts`) — **after** the indexing transaction
  commits successfully, re-read the three inputs and `upsert` the cache row (needs the
  vault's `latestRevision` for the key). On indexing failure, `deleteByVault` so the next
  request rebuilds instead of serving a stale `indexedRevision`. Sync commits alone do
  NOT rewrite the cache: the graph depends on `noteIndex`, and `indexPending` state must
  stay truthful (payload must reflect the `indexedRevision` it was built from).

### Lane B — client cache

- New module `tephra-server/apps/web/src/api/graphCache.ts`: minimal promise-wrapped
  IndexedDB (`tephra-graph` DB, `graphs` store, key = vaultId,
  value `{ etag, body: GraphResponse, savedAt }`). All IDB access wrapped in try/catch —
  quota/privacy-mode failures must degrade to network-only, never throw into the UI.
- `ApiClient.graph`: lazily hydrate the existing in-memory `Map` from IDB so reloads
  send `If-None-Match` (server answers 304 after a cheap `getState`, no fan-out), and
  persist every 200 response to IDB. Map behavior otherwise unchanged.
- `GraphView.tsx` fetch effect: `loadGraphCache(vaultId)` → `setGraph` immediately for
  instant paint, then `api.graph(vaultId)` revalidates in background; skip the second
  `setGraph` when `result.revision` is unchanged to avoid a redundant
  `buildGraphModel` + canvas pass. No stale badge (data is seconds old at most, and
  `indexPending` already communicates index lag).

### Lane C — quick wins

- Fallback list: render at most 200 note buttons, then a single
  `…and N more — use search to open a note` line. Keeps the no-canvas accessibility
  story while removing the multi-thousand-DOM-node commit from every cold load.
- `signatureFor`: stop allocating `` `${len}:${ids.join('\n')}` `` per `setModel`. Keep
  the last id array and compare element-wise (length + `===` per id, O(n) time, O(1)
  extra garbage); update the stored array only on change.

## Affected packages

- `tephra-server/migrations/sqlite/004_graph_cache.sql` (new), `packages/database/sqlite`
  (migration registration + impl), `packages/database/core` (repo interface),
  `packages/indexer` (pure `buildGraphPayload` + unit tests), `apps/api` (handler +
  `runtime-index` recalc + API tests), `apps/web` (`graphCache.ts`, `client.ts`,
  `GraphView.tsx` + tests), `packages/graph-renderer` (`renderer.ts` signature fix).

## Migration / API consequences

- SQLite `user_version` 3 → 4; fresh and existing DBs converge via the standard runner.
  Cache table is derived state — safe to drop/rebuild; `deleteByVault` on vault deletion
  comes free via `ON DELETE CASCADE`.
- No wire change: same route, same `GraphResponse`, same ETag format. Old clients
  interoperate; new web client degrades to network-only when IDB is unavailable.

## Verification

- `npm run check` (strict TS + lint) must pass.
- New tests: `buildGraphPayload` unit tests (parity with current handler output for
  notes/attachments/tags/unresolved/edges/truncation); API test for cache-hit serving
  and post-`indexVault` invalidation; client test for IDB stale-paint + revalidate
  (following existing web test patterns; skip IDB test only if no harness exists and say
  so explicitly).
- Manual smoke via the dev-server skill on the sample vault: cold reload paints from
  cache, a sync + reindex updates the graph, fallback list is capped.

## Rollout risks

- **Stale graph served**: mitigated by keying the row on `(revision, indexedRevision)`
  and deleting on index failure, plus tests covering both paths.
- **Unbounded IDB growth**: one row per vault, payload already capped at 10k nodes;
  overwrite (never append). Quota errors caught and ignored.
- **Migration failure on user DBs**: single `CREATE TABLE IF NOT EXISTS`, no backfill,
  no table rebuild — same low-risk shape as 003.
