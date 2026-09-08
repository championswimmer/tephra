PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX sessions_expires_at_idx ON sessions(expires_at);

CREATE TABLE vaults (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  latest_revision INTEGER NOT NULL DEFAULT 0 CHECK(latest_revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX vaults_owner_idx ON vaults(owner_user_id);

CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  platform TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX devices_user_idx ON devices(user_id);

CREATE TABLE api_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT REFERENCES vaults(id) ON DELETE CASCADE,
  device_id TEXT REFERENCES devices(id) ON DELETE SET NULL,
  token_hash TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  revoked_at INTEGER
);
CREATE INDEX api_tokens_vault_idx ON api_tokens(vault_id);

CREATE TABLE blobs (
  hash TEXT PRIMARY KEY,
  size INTEGER NOT NULL CHECK(size >= 0),
  mime_type TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE vault_files (
  file_id TEXT NOT NULL,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  path_fold TEXT NOT NULL,
  blob_hash TEXT NOT NULL REFERENCES blobs(hash),
  size INTEGER NOT NULL CHECK(size >= 0),
  mtime INTEGER NOT NULL,
  mime_type TEXT,
  kind TEXT NOT NULL CHECK(kind IN ('markdown', 'attachment')),
  updated_revision INTEGER NOT NULL,
  PRIMARY KEY(vault_id, file_id),
  UNIQUE(vault_id, path)
);
CREATE INDEX vault_files_vault_idx ON vault_files(vault_id);
CREATE INDEX vault_files_kind_idx ON vault_files(vault_id, kind);
CREATE INDEX vault_files_blob_idx ON vault_files(vault_id, blob_hash);
CREATE INDEX vault_files_path_fold_idx ON vault_files(vault_id, path_fold);

CREATE TABLE vault_revisions (
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(revision > 0),
  manifest_hash TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY(vault_id, revision),
  UNIQUE(vault_id, manifest_hash)
);

CREATE TABLE file_versions (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  file_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  path TEXT NOT NULL,
  blob_hash TEXT REFERENCES blobs(hash),
  size INTEGER,
  mtime INTEGER,
  change_type TEXT NOT NULL CHECK(change_type IN ('create', 'modify', 'rename', 'delete')),
  created_at INTEGER NOT NULL,
  FOREIGN KEY(vault_id, revision) REFERENCES vault_revisions(vault_id, revision) ON DELETE CASCADE,
  CHECK((change_type = 'delete' AND blob_hash IS NULL AND size IS NULL AND mtime IS NULL) OR change_type <> 'delete')
);
CREATE INDEX file_versions_revision_idx ON file_versions(vault_id, revision);
CREATE INDEX file_versions_file_idx ON file_versions(vault_id, file_id, revision);
CREATE INDEX file_versions_path_idx ON file_versions(vault_id, path, revision);

CREATE TABLE note_metadata (
  file_id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  indexed_blob_hash TEXT NOT NULL,
  title TEXT,
  frontmatter_json TEXT NOT NULL,
  headings_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  blocks_json TEXT NOT NULL,
  indexed_at INTEGER NOT NULL,
  FOREIGN KEY(vault_id, file_id) REFERENCES vault_files(vault_id, file_id) ON DELETE CASCADE
);
CREATE INDEX note_metadata_vault_idx ON note_metadata(vault_id);

CREATE TABLE note_links (
  id TEXT PRIMARY KEY,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  source_file_id TEXT NOT NULL,
  raw_text TEXT NOT NULL,
  link_path TEXT NOT NULL,
  subpath TEXT,
  display_text TEXT,
  is_embed INTEGER NOT NULL CHECK(is_embed IN (0, 1)),
  target_file_id TEXT,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(vault_id, source_file_id) REFERENCES vault_files(vault_id, file_id) ON DELETE CASCADE,
  FOREIGN KEY(vault_id, target_file_id) REFERENCES vault_files(vault_id, file_id) ON DELETE SET NULL
);
CREATE INDEX note_links_source_idx ON note_links(vault_id, source_file_id);
CREATE INDEX note_links_target_idx ON note_links(vault_id, target_file_id);

CREATE TABLE vault_index_state (
  vault_id TEXT PRIMARY KEY REFERENCES vaults(id) ON DELETE CASCADE,
  indexed_revision INTEGER NOT NULL,
  last_error TEXT
);
