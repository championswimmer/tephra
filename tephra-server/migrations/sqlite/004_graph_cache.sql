-- 004: vault_graph_cache for the materialized graph payload (plan 016, Lane A).
--
-- The GET /vaults/:vaultId/graph handler rebuilds its payload from three
-- queries (vault_files + note_metadata + note_links) plus aggregation on
-- every cold load. This table materializes one row per vault, keyed by the
-- (revision, indexed_revision) pair the payload was built from, so a request
-- whose vault and index revisions still match can serve the stored JSON
-- without the fan-out. Pure derived state: safe to drop and rebuild at any
-- time; rows disappear with their vault via ON DELETE CASCADE, and indexing
-- failures delete the row so the next request rebuilds instead of serving a
-- stale indexed_revision.
CREATE TABLE IF NOT EXISTS vault_graph_cache (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  indexed_revision INTEGER NOT NULL,
  etag TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
