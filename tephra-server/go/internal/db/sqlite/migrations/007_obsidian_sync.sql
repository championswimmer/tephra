ALTER TABLE vaults ADD COLUMN sync_mode TEXT NOT NULL DEFAULT 'tephra'
  CHECK (sync_mode IN ('tephra', 'obsidian'));
CREATE TRIGGER vault_sync_mode_immutable BEFORE UPDATE OF sync_mode ON vaults
WHEN NEW.sync_mode <> OLD.sync_mode BEGIN
  SELECT RAISE(ABORT, 'vault sync mode is immutable');
END;
CREATE TABLE obsidian_sync (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  remote_vault_id TEXT,
  mode TEXT NOT NULL DEFAULT 'bidirectional' CHECK (mode IN ('bidirectional', 'pull-only')),
  phase TEXT NOT NULL DEFAULT 'pending-login',
  last_error_code TEXT,
  has_synced INTEGER NOT NULL DEFAULT 0 CHECK (has_synced IN (0, 1)),
  last_synced_at INTEGER
);
