-- 003: vault_files.path_fold for databases created before it existed.
--
-- `path_fold` (NFC-normalized, lowercased path for case-insensitive
-- resolution) was added to 001 after databases were already live at
-- user_version 1/2, so those databases never received the column and every
-- sync commit crashed with `table vault_files has 9 columns but 10 values
-- were supplied` (HTTP 500). 001 intentionally does NOT define the column;
-- it is added here so fresh (001→002→003) and existing (2→3, 1→2→3)
-- databases converge.
--
-- Backfill fidelity: SQLite's lower() is ASCII-only while the server folds
-- with NFC + full Unicode lowercase. Rows with non-ASCII uppercase paths
-- get an approximate fold until the next sync commit rewrites every row
-- (commits upsert the full manifest), which self-heals the backfill.
-- Case-insensitive resolution of such paths may miss in the interim.
--
-- Deliberately NOT rebuilding the table for the composite primary key:
-- the pre-existing UNIQUE(vault_id, file_id) already satisfies the
-- upsert's ON CONFLICT target, so a rebuild would be risk without benefit.
ALTER TABLE vault_files ADD COLUMN path_fold TEXT NOT NULL DEFAULT '';
UPDATE vault_files SET path_fold = lower(path);
CREATE INDEX IF NOT EXISTS vault_files_path_fold_idx ON vault_files(vault_id, path_fold);
CREATE INDEX IF NOT EXISTS file_versions_path_idx ON file_versions(vault_id, path, revision);
