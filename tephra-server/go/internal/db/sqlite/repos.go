package sqlite

import (
	"context"
	"database/sql"
	"errors"
	"sort"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// querier is satisfied by *sql.DB and *sql.Tx.
type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// repos serves every repository. r is used for reads, w for writes; for a
// transaction both are the same *sql.Tx.
type repos struct{ r, w querier }

func newRepos(r, w querier) *repos { return &repos{r: r, w: w} }

func (s *repos) ObsidianSync() db.ObsidianSyncRepository    { return obsidianRepo{s} }
func (s *repos) Users() db.UserRepository                   { return userRepo{s} }
func (s *repos) Sessions() db.SessionRepository             { return sessionRepo{s} }
func (s *repos) Vaults() db.VaultRepository                 { return vaultRepo{s} }
func (s *repos) Devices() db.DeviceRepository               { return deviceRepo{s} }
func (s *repos) ApiTokens() db.ApiTokenRepository           { return tokenRepo{s} }
func (s *repos) OAuthCodes() db.OAuthCodeRepository         { return oauthRepo{s} }
func (s *repos) Blobs() db.BlobRepository                   { return blobRepo{s} }
func (s *repos) VaultFiles() db.VaultFileRepository         { return fileRepo{s} }
func (s *repos) VaultRevisions() db.VaultRevisionRepository { return revisionRepo{s} }
func (s *repos) FileVersions() db.FileVersionRepository     { return versionRepo{s} }
func (s *repos) NoteIndex() db.NoteIndexRepository          { return noteRepo{s} }
func (s *repos) GraphCache() db.GraphCacheRepository        { return graphRepo{s} }

func one[T any](ctx context.Context, q querier, scan func(scanner) (T, error), query string, args ...any) (*T, error) {
	v, err := scan(q.QueryRowContext(ctx, query, args...))
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &v, nil
}

// many always returns a non-nil slice so JSON marshals as [].
func many[T any](ctx context.Context, q querier, scan func(scanner) (T, error), query string, args ...any) ([]T, error) {
	rows, err := q.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []T{}
	for rows.Next() {
		v, err := scan(rows)
		if err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

func affected(res sql.Result, err error) (int64, error) {
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// inTx runs fn atomically: directly when w is already a transaction, else in a
// new BEGIN IMMEDIATE transaction on the write connection.
func (s *repos) inTx(ctx context.Context, fn func(q querier) error) error {
	d, ok := s.w.(*sql.DB)
	if !ok {
		return fn(s.w)
	}
	tx, err := d.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

// ---- obsidian_sync ----
type obsidianRepo struct{ *repos }

func (s obsidianRepo) Find(ctx context.Context, vaultID string) (*vm.ObsidianSyncSettings, error) {
	return one(ctx, s.r, scanObsidian, "SELECT "+obsidianCols+" FROM obsidian_sync WHERE vault_id=?", vaultID)
}
func (s obsidianRepo) List(ctx context.Context) ([]vm.ObsidianSyncSettings, error) {
	return many(ctx, s.r, scanObsidian, "SELECT "+obsidianCols+" FROM obsidian_sync ORDER BY vault_id")
}
func (s obsidianRepo) Upsert(ctx context.Context, v vm.ObsidianSyncSettings) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO obsidian_sync (`+obsidianCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(vault_id) DO UPDATE SET enabled=excluded.enabled,
		remote_vault_id=excluded.remote_vault_id, mode=excluded.mode,
		phase=excluded.phase, last_error_code=excluded.last_error_code,
		has_synced=excluded.has_synced, last_synced_at=excluded.last_synced_at`,
		v.VaultID, boolInt(v.Enabled), nullStr(v.RemoteVaultID), string(v.Mode), string(v.Phase),
		nullStr(v.LastErrorCode), boolInt(v.HasSynced), nullInt(v.LastSyncedAt))
	return err
}

// ---- users ----
type userRepo struct{ *repos }

func (s userRepo) Count(ctx context.Context) (int64, error) {
	var n int64
	err := s.r.QueryRowContext(ctx, "SELECT count(*) AS count FROM users").Scan(&n)
	return n, err
}
func (s userRepo) FindByID(ctx context.Context, id string) (*vm.User, error) {
	return one(ctx, s.r, scanUser, "SELECT "+userCols+" FROM users WHERE id = ?", id)
}
func (s userRepo) FindByEmail(ctx context.Context, email string) (*vm.User, error) {
	return one(ctx, s.r, scanUser, "SELECT "+userCols+" FROM users WHERE email = ?", email)
}
func (s userRepo) Insert(ctx context.Context, v vm.User) error {
	_, err := s.w.ExecContext(ctx, "INSERT INTO users ("+userCols+") VALUES (?, ?, ?, ?, ?)",
		v.ID, v.Email, nullStr(v.PasswordHash), v.CreatedAt, v.UpdatedAt)
	return err
}
func (s userRepo) Update(ctx context.Context, v vm.User) error {
	_, err := s.w.ExecContext(ctx, "UPDATE users SET email=?, password_hash=?, created_at=?, updated_at=? WHERE id=?",
		v.Email, nullStr(v.PasswordHash), v.CreatedAt, v.UpdatedAt, v.ID)
	return err
}

// ---- sessions ----
type sessionRepo struct{ *repos }

func (s sessionRepo) FindByID(ctx context.Context, id string) (*vm.Session, error) {
	return one(ctx, s.r, scanSession, "SELECT "+sessionCols+" FROM sessions WHERE id=?", id)
}
func (s sessionRepo) Insert(ctx context.Context, v vm.Session) error {
	_, err := s.w.ExecContext(ctx, "INSERT INTO sessions ("+sessionCols+") VALUES (?, ?, ?, ?)", v.ID, v.UserID, v.ExpiresAt, v.CreatedAt)
	return err
}
func (s sessionRepo) Delete(ctx context.Context, id string) error {
	_, err := s.w.ExecContext(ctx, "DELETE FROM sessions WHERE id=?", id)
	return err
}
func (s sessionRepo) DeleteExpired(ctx context.Context, now int64) (int64, error) {
	return affected(s.w.ExecContext(ctx, "DELETE FROM sessions WHERE expires_at <= ?", now))
}

// ---- vaults ----
type vaultRepo struct{ *repos }

func (s vaultRepo) FindByID(ctx context.Context, id string) (*vm.Vault, error) {
	return one(ctx, s.r, scanVault, "SELECT "+vaultCols+" FROM vaults WHERE id=?", id)
}
func (s vaultRepo) FindByName(ctx context.Context, name string) (*vm.Vault, error) {
	return one(ctx, s.r, scanVault, "SELECT "+vaultCols+" FROM vaults WHERE name=?", name)
}
func (s vaultRepo) ListByOwner(ctx context.Context, owner string) ([]vm.Vault, error) {
	return many(ctx, s.r, scanVault, "SELECT "+vaultCols+" FROM vaults WHERE owner_user_id=? ORDER BY created_at, id", owner)
}
func (s vaultRepo) Insert(ctx context.Context, v vm.Vault) error {
	mode := string(v.SyncMode)
	if mode == "" {
		mode = string(vm.SyncModeTephra)
	}
	_, err := s.w.ExecContext(ctx, "INSERT INTO vaults ("+vaultCols+") VALUES (?, ?, ?, ?, ?, ?, ?)",
		v.ID, v.OwnerUserID, v.Name, v.LatestRevision, v.CreatedAt, v.UpdatedAt, mode)
	return err
}
func (s vaultRepo) Update(ctx context.Context, v vm.Vault) error {
	var mode any
	if v.SyncMode != "" {
		mode = string(v.SyncMode)
	}
	_, err := s.w.ExecContext(ctx, "UPDATE vaults SET owner_user_id=?, name=?, latest_revision=?, created_at=?, updated_at=?, sync_mode=COALESCE(?, sync_mode) WHERE id=?",
		v.OwnerUserID, v.Name, v.LatestRevision, v.CreatedAt, v.UpdatedAt, mode, v.ID)
	return err
}
func (s vaultRepo) Delete(ctx context.Context, id string) error {
	_, err := s.w.ExecContext(ctx, "DELETE FROM vaults WHERE id=?", id)
	return err
}

// ---- devices ----
type deviceRepo struct{ *repos }

func (s deviceRepo) FindByID(ctx context.Context, id string) (*vm.Device, error) {
	return one(ctx, s.r, scanDevice, "SELECT "+deviceCols+" FROM devices WHERE id=?", id)
}
func (s deviceRepo) ListByUser(ctx context.Context, userID string) ([]vm.Device, error) {
	return many(ctx, s.r, scanDevice, "SELECT "+deviceCols+" FROM devices WHERE user_id=? ORDER BY created_at, id", userID)
}
func (s deviceRepo) Insert(ctx context.Context, v vm.Device) error {
	_, err := s.w.ExecContext(ctx, "INSERT INTO devices ("+deviceCols+") VALUES (?, ?, ?, ?, ?, ?)",
		v.ID, v.UserID, v.Name, nullStr(v.Platform), v.CreatedAt, v.LastSeenAt)
	return err
}
func (s deviceRepo) Update(ctx context.Context, v vm.Device) error {
	_, err := s.w.ExecContext(ctx, "UPDATE devices SET user_id=?, name=?, platform=?, created_at=?, last_seen_at=? WHERE id=?",
		v.UserID, v.Name, nullStr(v.Platform), v.CreatedAt, v.LastSeenAt, v.ID)
	return err
}

// ---- api_tokens ----
type tokenRepo struct{ *repos }

func (s tokenRepo) FindByID(ctx context.Context, id string) (*vm.ApiToken, error) {
	return one(ctx, s.r, scanToken, "SELECT "+tokenCols+" FROM api_tokens WHERE id=?", id)
}
func (s tokenRepo) FindByTokenHash(ctx context.Context, hash string) (*vm.ApiToken, error) {
	return one(ctx, s.r, scanToken, "SELECT "+tokenCols+" FROM api_tokens WHERE token_hash=?", hash)
}
func (s tokenRepo) ListByVault(ctx context.Context, vaultID string) ([]vm.ApiToken, error) {
	return many(ctx, s.r, scanToken, "SELECT "+tokenCols+" FROM api_tokens WHERE vault_id=? ORDER BY created_at, id", vaultID)
}
func (s tokenRepo) Insert(ctx context.Context, v vm.ApiToken) error {
	scopes, err := scopesJSON(v.Scopes)
	if err != nil {
		return err
	}
	_, err = s.w.ExecContext(ctx, "INSERT INTO api_tokens ("+tokenCols+") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		v.ID, v.UserID, nullStr(v.VaultID), nullStr(v.DeviceID), v.TokenHash, v.Name, scopes, v.CreatedAt,
		nullInt(v.LastUsedAt), nullInt(v.ExpiresAt), nullInt(v.RevokedAt))
	return err
}
func (s tokenRepo) Update(ctx context.Context, v vm.ApiToken) error {
	scopes, err := scopesJSON(v.Scopes)
	if err != nil {
		return err
	}
	_, err = s.w.ExecContext(ctx, "UPDATE api_tokens SET user_id=?, vault_id=?, device_id=?, token_hash=?, name=?, scopes_json=?, created_at=?, last_used_at=?, expires_at=?, revoked_at=? WHERE id=?",
		v.UserID, nullStr(v.VaultID), nullStr(v.DeviceID), v.TokenHash, v.Name, scopes, v.CreatedAt,
		nullInt(v.LastUsedAt), nullInt(v.ExpiresAt), nullInt(v.RevokedAt), v.ID)
	return err
}
func (s tokenRepo) Delete(ctx context.Context, id string) error {
	_, err := s.w.ExecContext(ctx, "DELETE FROM api_tokens WHERE id=?", id)
	return err
}

// ---- oauth_codes ----
type oauthRepo struct{ *repos }

func (s oauthRepo) Insert(ctx context.Context, v db.OAuthCode) error {
	scopes, err := scopesJSON(v.Scopes)
	if err != nil {
		return err
	}
	_, err = s.w.ExecContext(ctx, "INSERT INTO oauth_codes ("+oauthCodeCols+") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		v.CodeHash, v.UserID, v.VaultID, v.ClientID, v.ClientName, v.RedirectURI, v.CodeChallenge, scopes, v.CreatedAt, v.ExpiresAt)
	return err
}

// Consume deletes and returns the code in one atomic statement (DELETE ... RETURNING).
func (s oauthRepo) Consume(ctx context.Context, hash string) (*db.OAuthCode, error) {
	return one(ctx, s.w, scanOAuthCode, "DELETE FROM oauth_codes WHERE code_hash=? RETURNING "+oauthCodeCols, hash)
}
func (s oauthRepo) DeleteExpired(ctx context.Context, now int64) (int64, error) {
	return affected(s.w.ExecContext(ctx, "DELETE FROM oauth_codes WHERE expires_at <= ?", now))
}

// ---- blobs ----
type blobRepo struct{ *repos }

func (s blobRepo) FindByHash(ctx context.Context, hash string) (*vm.BlobMetadata, error) {
	return one(ctx, s.r, scanBlob, "SELECT "+blobCols+" FROM blobs WHERE hash=?", hash)
}

const findByHashesChunk = 500

func (s blobRepo) FindByHashes(ctx context.Context, hashes []string) ([]vm.BlobMetadata, error) {
	out := []vm.BlobMetadata{}
	seen := make(map[string]struct{}, len(hashes))
	unique := make([]any, 0, len(hashes))
	for _, h := range hashes {
		if _, dup := seen[h]; !dup {
			seen[h] = struct{}{}
			unique = append(unique, h)
		}
	}
	for start := 0; start < len(unique); start += findByHashesChunk {
		end := min(start+findByHashesChunk, len(unique))
		chunk := unique[start:end]
		placeholders := strings.TrimSuffix(strings.Repeat("?,", len(chunk)), ",")
		part, err := many(ctx, s.r, scanBlob, "SELECT "+blobCols+" FROM blobs WHERE hash IN ("+placeholders+") ORDER BY hash", chunk...)
		if err != nil {
			return nil, err
		}
		out = append(out, part...)
	}
	if len(unique) > findByHashesChunk {
		sort.Slice(out, func(i, j int) bool { return out[i].Hash < out[j].Hash })
	}
	return out, nil
}
func (s blobRepo) FindUnreferencedOlderThan(ctx context.Context, cutoff int64, limit int) ([]vm.BlobMetadata, error) {
	if limit <= 0 {
		return []vm.BlobMetadata{}, nil
	}
	return many(ctx, s.r, scanBlob, "SELECT "+blobCols+" FROM blobs WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM vault_files WHERE vault_files.blob_hash = blobs.hash) AND NOT EXISTS (SELECT 1 FROM file_versions WHERE file_versions.blob_hash = blobs.hash) ORDER BY created_at ASC LIMIT ?", cutoff, limit)
}
func (s blobRepo) Insert(ctx context.Context, v vm.BlobMetadata) error {
	_, err := s.w.ExecContext(ctx, "INSERT INTO blobs ("+blobCols+") VALUES (?, ?, ?, ?)", v.Hash, v.Size, nullStr(v.MimeType), v.CreatedAt)
	return err
}
func (s blobRepo) Delete(ctx context.Context, hash string) error {
	_, err := s.w.ExecContext(ctx, "DELETE FROM blobs WHERE hash=?", hash)
	return err
}

// ---- vault_files ----
type fileRepo struct{ *repos }

func (s fileRepo) FindByID(ctx context.Context, vaultID, fileID string) (*vm.CurrentVaultFile, error) {
	return one(ctx, s.r, scanVaultFile, "SELECT "+vaultFileCols+" FROM vault_files WHERE vault_id=? AND file_id=?", vaultID, fileID)
}
func (s fileRepo) FindByPath(ctx context.Context, vaultID, path string) (*vm.CurrentVaultFile, error) {
	return one(ctx, s.r, scanVaultFile, "SELECT "+vaultFileCols+" FROM vault_files WHERE vault_id=? AND path=?", vaultID, path)
}
func (s fileRepo) FindByPathFold(ctx context.Context, vaultID, pathFold string) ([]vm.CurrentVaultFile, error) {
	return many(ctx, s.r, scanVaultFile, "SELECT "+vaultFileCols+" FROM vault_files WHERE vault_id=? AND path_fold=? ORDER BY path", vaultID, pathFold)
}
func (s fileRepo) ListByVault(ctx context.Context, vaultID string) ([]vm.CurrentVaultFile, error) {
	return many(ctx, s.r, scanVaultFile, "SELECT "+vaultFileCols+" FROM vault_files WHERE vault_id=? ORDER BY path", vaultID)
}
func (s fileRepo) Upsert(ctx context.Context, v vm.CurrentVaultFile) error {
	pathFold := jstext.Lower(jstext.NFC(v.Path))
	_, err := s.w.ExecContext(ctx, `INSERT INTO vault_files (file_id, vault_id, path, path_fold, blob_hash, size, mtime, mime_type, kind, updated_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(vault_id, file_id) DO UPDATE SET path=excluded.path,path_fold=excluded.path_fold,blob_hash=excluded.blob_hash,size=excluded.size,mtime=excluded.mtime,mime_type=excluded.mime_type,kind=excluded.kind,updated_revision=excluded.updated_revision`,
		v.FileID, v.VaultID, v.Path, pathFold, v.BlobHash, v.Size, v.Mtime, nullStr(v.MimeType), string(v.Kind), v.UpdatedRevision)
	return err
}
func (s fileRepo) Delete(ctx context.Context, vaultID, fileID string) error {
	_, err := s.w.ExecContext(ctx, "DELETE FROM vault_files WHERE vault_id=? AND file_id=?", vaultID, fileID)
	return err
}

// ---- vault_revisions ----
type revisionRepo struct{ *repos }

func (s revisionRepo) Find(ctx context.Context, vaultID string, revision int64) (*vm.VaultRevision, error) {
	return one(ctx, s.r, scanRevision, "SELECT "+revisionCols+" FROM vault_revisions WHERE vault_id=? AND revision=?", vaultID, revision)
}
func (s revisionRepo) FindLatest(ctx context.Context, vaultID string) (*vm.VaultRevision, error) {
	return one(ctx, s.r, scanRevision, "SELECT "+revisionCols+" FROM vault_revisions WHERE vault_id=? ORDER BY revision DESC LIMIT 1", vaultID)
}

// FindByManifestHash is newest-wins: since 005 the same manifest hash may
// appear on several revisions (edit-then-revert).
func (s revisionRepo) FindByManifestHash(ctx context.Context, vaultID, hash string) (*vm.VaultRevision, error) {
	return one(ctx, s.r, scanRevision, "SELECT "+revisionCols+" FROM vault_revisions WHERE vault_id=? AND manifest_hash=? ORDER BY revision DESC LIMIT 1", vaultID, hash)
}
func (s revisionRepo) List(ctx context.Context, vaultID string) ([]vm.VaultRevision, error) {
	return many(ctx, s.r, scanRevision, "SELECT "+revisionCols+" FROM vault_revisions WHERE vault_id=? ORDER BY revision", vaultID)
}
func (s revisionRepo) Insert(ctx context.Context, v vm.VaultRevision) error {
	_, err := s.w.ExecContext(ctx, "INSERT INTO vault_revisions ("+revisionCols+") VALUES (?, ?, ?, ?, ?)", v.VaultID, v.Revision, v.ManifestHash, v.DeviceID, v.CreatedAt)
	return err
}

// ---- file_versions ----
type versionRepo struct{ *repos }

func (s versionRepo) ListByRevision(ctx context.Context, vaultID string, revision int64) ([]vm.FileVersion, error) {
	return many(ctx, s.r, scanVersion, "SELECT "+versionCols+" FROM file_versions WHERE vault_id=? AND revision=? ORDER BY id", vaultID, revision)
}
func (s versionRepo) ListByFile(ctx context.Context, vaultID, fileID string) ([]vm.FileVersion, error) {
	return many(ctx, s.r, scanVersion, "SELECT "+versionCols+" FROM file_versions WHERE vault_id=? AND file_id=? ORDER BY revision, id", vaultID, fileID)
}
func (s versionRepo) FindLatestByPath(ctx context.Context, vaultID, path string) (*vm.FileVersion, error) {
	return one(ctx, s.r, scanVersion, "SELECT "+versionCols+" FROM file_versions WHERE vault_id=? AND path=? ORDER BY revision DESC LIMIT 1", vaultID, path)
}
func (s versionRepo) ListSince(ctx context.Context, vaultID string, since int64, limit int) ([]vm.FileVersion, error) {
	if limit <= 0 {
		return []vm.FileVersion{}, nil
	}
	return many(ctx, s.r, scanVersion, "SELECT "+versionCols+" FROM file_versions WHERE vault_id=? AND revision>? ORDER BY revision, id LIMIT ?", vaultID, since, limit)
}

// InsertMany is atomic (the TS adapter inserted row by row; atomic is a strict improvement).
func (s versionRepo) InsertMany(ctx context.Context, versions []vm.FileVersion) error {
	if len(versions) == 0 {
		return nil
	}
	return s.inTx(ctx, func(q querier) error {
		for _, v := range versions {
			if _, err := q.ExecContext(ctx, "INSERT INTO file_versions ("+versionCols+") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				v.ID, v.VaultID, v.FileID, v.Revision, v.Path, nullStr(v.BlobHash), nullInt(v.Size), nullInt(v.Mtime), string(v.ChangeType), v.CreatedAt); err != nil {
				return err
			}
		}
		return nil
	})
}

// ---- note index ----
type noteRepo struct{ *repos }

func (s noteRepo) FindMetadata(ctx context.Context, fileID string) (*vm.NoteMetadata, error) {
	return one(ctx, s.r, scanNoteMetadata, "SELECT "+noteMetaCols+" FROM note_metadata WHERE file_id=?", fileID)
}
func (s noteRepo) ListMetadata(ctx context.Context, vaultID string) ([]vm.NoteMetadata, error) {
	return many(ctx, s.r, scanNoteMetadata, "SELECT "+noteMetaCols+" FROM note_metadata WHERE vault_id=? ORDER BY file_id", vaultID)
}
func (s noteRepo) UpsertMetadata(ctx context.Context, v vm.NoteMetadata) error {
	if v.Frontmatter == nil {
		v.Frontmatter = map[string]any{}
	}
	if v.Headings == nil {
		v.Headings = []any{}
	}
	if v.Tags == nil {
		v.Tags = []string{}
	}
	if v.Blocks == nil {
		v.Blocks = []any{}
	}
	var enc [4]string
	for i, val := range []any{v.Frontmatter, v.Headings, v.Tags, v.Blocks} {
		str, err := toJSON(val)
		if err != nil {
			return err
		}
		enc[i] = str
	}
	_, err := s.w.ExecContext(ctx, `INSERT INTO note_metadata (`+noteMetaCols+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET vault_id=excluded.vault_id,indexed_blob_hash=excluded.indexed_blob_hash,title=excluded.title,frontmatter_json=excluded.frontmatter_json,headings_json=excluded.headings_json,tags_json=excluded.tags_json,blocks_json=excluded.blocks_json,indexed_at=excluded.indexed_at`,
		v.FileID, v.VaultID, v.IndexedBlobHash, nullStr(v.Title), enc[0], enc[1], enc[2], enc[3], v.IndexedAt)
	return err
}
func (s noteRepo) DeleteMetadata(ctx context.Context, fileID string) error {
	_, err := s.w.ExecContext(ctx, "DELETE FROM note_metadata WHERE file_id=?", fileID)
	return err
}
func (s noteRepo) ListLinksBySource(ctx context.Context, vaultID, fileID string) ([]vm.NoteLink, error) {
	return many(ctx, s.r, scanNoteLink, "SELECT "+noteLinkCols+" FROM note_links WHERE vault_id=? AND source_file_id=? ORDER BY id", vaultID, fileID)
}
func (s noteRepo) ListLinksByTarget(ctx context.Context, vaultID, fileID string) ([]vm.NoteLink, error) {
	return many(ctx, s.r, scanNoteLink, "SELECT "+noteLinkCols+" FROM note_links WHERE vault_id=? AND target_file_id=? ORDER BY id", vaultID, fileID)
}
func (s noteRepo) ListLinks(ctx context.Context, vaultID string) ([]vm.NoteLink, error) {
	return many(ctx, s.r, scanNoteLink, "SELECT "+noteLinkCols+" FROM note_links WHERE vault_id=? ORDER BY id", vaultID)
}

// ReplaceLinksForSource is atomic (delete + insert in one transaction).
func (s noteRepo) ReplaceLinksForSource(ctx context.Context, vaultID, sourceFileID string, links []vm.NoteLink) error {
	for _, l := range links {
		if l.VaultID != vaultID || l.SourceFileID != sourceFileID {
			return errors.New("Link does not belong to requested source")
		}
	}
	return s.inTx(ctx, func(q querier) error {
		if _, err := q.ExecContext(ctx, "DELETE FROM note_links WHERE vault_id=? AND source_file_id=?", vaultID, sourceFileID); err != nil {
			return err
		}
		for _, l := range links {
			if _, err := q.ExecContext(ctx, "INSERT INTO note_links ("+noteLinkCols+") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
				l.ID, l.VaultID, l.SourceFileID, l.RawText, l.LinkPath, nullStr(l.Subpath), nullStr(l.DisplayText),
				boolInt(l.IsEmbed), nullStr(l.TargetFileID), l.CreatedAt); err != nil {
				return err
			}
		}
		return nil
	})
}
func (s noteRepo) GetState(ctx context.Context, vaultID string) (*vm.VaultIndexState, error) {
	return one(ctx, s.r, func(sc scanner) (vm.VaultIndexState, error) {
		var st vm.VaultIndexState
		var e sql.NullString
		err := sc.Scan(&st.VaultID, &st.IndexedRevision, &e)
		st.LastError = strPtr(e)
		return st, err
	}, "SELECT vault_id, indexed_revision, last_error FROM vault_index_state WHERE vault_id=?", vaultID)
}
func (s noteRepo) SetState(ctx context.Context, v vm.VaultIndexState) error {
	_, err := s.w.ExecContext(ctx, "INSERT INTO vault_index_state (vault_id, indexed_revision, last_error) VALUES (?, ?, ?) ON CONFLICT(vault_id) DO UPDATE SET indexed_revision=excluded.indexed_revision,last_error=excluded.last_error",
		v.VaultID, v.IndexedRevision, nullStr(v.LastError))
	return err
}

// ---- graph cache ----
type graphRepo struct{ *repos }

func (s graphRepo) Find(ctx context.Context, vaultID string) (*db.GraphCacheEntry, error) {
	return one(ctx, s.r, scanGraphCache, "SELECT "+graphCacheCols+" FROM vault_graph_cache WHERE vault_id=?", vaultID)
}
func (s graphRepo) Upsert(ctx context.Context, v db.GraphCacheEntry) error {
	_, err := s.w.ExecContext(ctx, "INSERT INTO vault_graph_cache ("+graphCacheCols+") VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(vault_id) DO UPDATE SET revision=excluded.revision,indexed_revision=excluded.indexed_revision,etag=excluded.etag,payload_json=excluded.payload_json,updated_at=excluded.updated_at",
		v.VaultID, v.Revision, v.IndexedRevision, v.ETag, v.PayloadJSON, v.UpdatedAt)
	return err
}
func (s graphRepo) DeleteByVault(ctx context.Context, vaultID string) error {
	_, err := s.w.ExecContext(ctx, "DELETE FROM vault_graph_cache WHERE vault_id=?", vaultID)
	return err
}
