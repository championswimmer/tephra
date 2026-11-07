-- 005: relax UNIQUE(vault_id, manifest_hash) on vault_revisions (plan 017, Phase 2).
--
-- The manifest-hash lookup backs the /sync/plan and /sync/commit idempotency
-- short-circuit ("this exact vault state was already committed → up-to-date").
-- Web editing breaks the uniqueness assumption: edit a note, then edit it
-- back, and the resulting vault state — therefore its manifest hash — equals
-- an earlier revision's. Keeping the constraint would reject that legitimate
-- later revision, and every workaround that keeps it (salting the hash,
-- skipping the revision) leaves vault_files and latest_revision disagreeing.
--
-- The constraint becomes a plain index so a later revision may reproduce an
-- earlier vault state, and VaultRevisionRepository.findByManifestHash returns
-- the NEWEST revision carrying the hash (a retried plugin commit still finds
-- the revision it just created and short-circuits to up-to-date).
--
-- SQLite cannot drop a table constraint in place, so this is a table rebuild.
-- file_versions holds a composite FK onto (vault_id, revision): dropping the
-- parent with enforcement on would cascade-delete the child rows, and
-- PRAGMA foreign_keys is a no-op inside a transaction, so the migration
-- runner suspends enforcement around the whole migration run and runs
-- foreign_key_check before stamping user_version. The PRAGMAs below are
-- belt-and-braces for anyone applying this file by hand (e.g. sqlite3 CLI).
PRAGMA foreign_keys=OFF;

CREATE TABLE vault_revisions_new (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  manifest_hash TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(vault_id, revision)
);

INSERT INTO vault_revisions_new (vault_id, revision, manifest_hash, device_id, created_at)
  SELECT vault_id, revision, manifest_hash, device_id, created_at FROM vault_revisions;

DROP TABLE vault_revisions;

ALTER TABLE vault_revisions_new RENAME TO vault_revisions;

CREATE INDEX IF NOT EXISTS vault_revisions_manifest_idx ON vault_revisions(vault_id, manifest_hash);

PRAGMA foreign_keys=ON;
