-- 006: short-lived, single-use OAuth authorization codes for MCP client sign-in (plan 022).
--
-- A code is created when a signed-in user approves an MCP client in the web app
-- and is consumed (deleted) when the client exchanges it, with its PKCE verifier,
-- for an API token. Only the SHA-256 hash of the code is stored. Rows are
-- disposable: expired rows are purged opportunistically.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  vault_id TEXT NOT NULL REFERENCES vaults(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_codes_expires_idx ON oauth_codes(expires_at);
