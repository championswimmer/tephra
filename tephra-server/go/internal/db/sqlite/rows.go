package sqlite

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// Explicit column lists: never SELECT * / positional VALUES, because migration
// 003 appends path_fold last on upgraded databases while fresh ones also add
// it last (ALTER), and 005 rebuilds tables; names are the stable contract.
const (
	userCols       = "id, email, password_hash, created_at, updated_at"
	sessionCols    = "id, user_id, expires_at, created_at"
	vaultCols      = "id, owner_user_id, name, latest_revision, created_at, updated_at, sync_mode"
	deviceCols     = "id, user_id, name, platform, created_at, last_seen_at"
	tokenCols      = "id, user_id, vault_id, device_id, token_hash, name, scopes_json, created_at, last_used_at, expires_at, revoked_at"
	oauthCodeCols  = "code_hash, user_id, vault_id, client_id, client_name, redirect_uri, code_challenge, scopes_json, created_at, expires_at"
	blobCols       = "hash, size, mime_type, created_at"
	vaultFileCols  = "file_id, vault_id, path, blob_hash, size, mtime, mime_type, kind, updated_revision"
	revisionCols   = "vault_id, revision, manifest_hash, device_id, created_at"
	versionCols    = "id, vault_id, file_id, revision, path, blob_hash, size, mtime, change_type, created_at"
	noteMetaCols   = "file_id, vault_id, indexed_blob_hash, title, frontmatter_json, headings_json, tags_json, blocks_json, indexed_at"
	noteLinkCols   = "id, vault_id, source_file_id, raw_text, link_path, subpath, display_text, is_embed, target_file_id, created_at"
	graphCacheCols = "vault_id, revision, indexed_revision, etag, payload_json, updated_at"
	obsidianCols   = "vault_id, enabled, remote_vault_id, mode, phase, last_error_code, has_synced, last_synced_at"
)

type scanner interface{ Scan(dest ...any) error }

func strPtr(n sql.NullString) *string {
	if !n.Valid {
		return nil
	}
	s := n.String
	return &s
}
func intPtr(n sql.NullInt64) *int64 {
	if !n.Valid {
		return nil
	}
	v := n.Int64
	return &v
}
func nullStr(p *string) any {
	if p == nil {
		return nil
	}
	return *p
}
func nullInt(p *int64) any {
	if p == nil {
		return nil
	}
	return *p
}
func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// toJSON marshals like JSON.stringify as far as practical (no HTML escaping).
func toJSON(v any) (string, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return "", err
	}
	return strings.TrimSuffix(buf.String(), "\n"), nil
}

func isTokenScope(s vm.ApiTokenScope) bool {
	switch s {
	case vm.ScopeVaultReadMetadata, vm.ScopeVaultUpload, vm.ScopeVaultWrite:
		return true
	}
	return false
}

func scopesJSON(scopes []vm.ApiTokenScope) (string, error) {
	if scopes == nil {
		scopes = []vm.ApiTokenScope{}
	}
	for _, s := range scopes {
		if !isTokenScope(s) {
			return "", fmt.Errorf("Invalid API token scopes")
		}
	}
	return toJSON(scopes)
}

func scopesFromJSON(raw, field string) ([]vm.ApiTokenScope, error) {
	var scopes []vm.ApiTokenScope
	var generic any
	if err := json.Unmarshal([]byte(raw), &generic); err != nil {
		return nil, fmt.Errorf("Invalid JSON stored in %s", field)
	}
	arr, ok := generic.([]any)
	if !ok {
		return nil, fmt.Errorf("Invalid JSON stored in %s", field)
	}
	scopes = make([]vm.ApiTokenScope, 0, len(arr))
	for _, item := range arr {
		s, ok := item.(string)
		if !ok || !isTokenScope(vm.ApiTokenScope(s)) {
			return nil, fmt.Errorf("Invalid JSON stored in %s", field)
		}
		scopes = append(scopes, vm.ApiTokenScope(s))
	}
	return scopes, nil
}

func scanUser(s scanner) (vm.User, error) {
	var u vm.User
	var ph sql.NullString
	err := s.Scan(&u.ID, &u.Email, &ph, &u.CreatedAt, &u.UpdatedAt)
	u.PasswordHash = strPtr(ph)
	return u, err
}

func scanSession(s scanner) (vm.Session, error) {
	var v vm.Session
	err := s.Scan(&v.ID, &v.UserID, &v.ExpiresAt, &v.CreatedAt)
	return v, err
}

func scanVault(s scanner) (vm.Vault, error) {
	var v vm.Vault
	var mode string
	err := s.Scan(&v.ID, &v.OwnerUserID, &v.Name, &v.LatestRevision, &v.CreatedAt, &v.UpdatedAt, &mode)
	v.SyncMode = vm.SyncMode(mode)
	return v, err
}

func scanDevice(s scanner) (vm.Device, error) {
	var d vm.Device
	var p sql.NullString
	err := s.Scan(&d.ID, &d.UserID, &d.Name, &p, &d.CreatedAt, &d.LastSeenAt)
	d.Platform = strPtr(p)
	return d, err
}

func scanToken(s scanner) (vm.ApiToken, error) {
	var t vm.ApiToken
	var vault, device sql.NullString
	var scopes string
	var used, expires, revoked sql.NullInt64
	if err := s.Scan(&t.ID, &t.UserID, &vault, &device, &t.TokenHash, &t.Name, &scopes, &t.CreatedAt, &used, &expires, &revoked); err != nil {
		return t, err
	}
	t.VaultID, t.DeviceID = strPtr(vault), strPtr(device)
	t.LastUsedAt, t.ExpiresAt, t.RevokedAt = intPtr(used), intPtr(expires), intPtr(revoked)
	var err error
	t.Scopes, err = scopesFromJSON(scopes, "api_tokens.scopes_json")
	return t, err
}

func scanOAuthCode(s scanner) (db.OAuthCode, error) {
	var c db.OAuthCode
	var scopes string
	if err := s.Scan(&c.CodeHash, &c.UserID, &c.VaultID, &c.ClientID, &c.ClientName, &c.RedirectURI, &c.CodeChallenge, &scopes, &c.CreatedAt, &c.ExpiresAt); err != nil {
		return c, err
	}
	var err error
	c.Scopes, err = scopesFromJSON(scopes, "api_tokens.scopes_json")
	return c, err
}

func scanBlob(s scanner) (vm.BlobMetadata, error) {
	var b vm.BlobMetadata
	var m sql.NullString
	err := s.Scan(&b.Hash, &b.Size, &m, &b.CreatedAt)
	b.MimeType = strPtr(m)
	return b, err
}

func scanVaultFile(s scanner) (vm.CurrentVaultFile, error) {
	var f vm.CurrentVaultFile
	var m sql.NullString
	var kind string
	err := s.Scan(&f.FileID, &f.VaultID, &f.Path, &f.BlobHash, &f.Size, &f.Mtime, &m, &kind, &f.UpdatedRevision)
	f.MimeType = strPtr(m)
	f.Kind = vm.VaultFileKind(kind)
	return f, err
}

func scanRevision(s scanner) (vm.VaultRevision, error) {
	var r vm.VaultRevision
	err := s.Scan(&r.VaultID, &r.Revision, &r.ManifestHash, &r.DeviceID, &r.CreatedAt)
	return r, err
}

func scanVersion(s scanner) (vm.FileVersion, error) {
	var v vm.FileVersion
	var hash sql.NullString
	var size, mtime sql.NullInt64
	var ct string
	err := s.Scan(&v.ID, &v.VaultID, &v.FileID, &v.Revision, &v.Path, &hash, &size, &mtime, &ct, &v.CreatedAt)
	v.BlobHash, v.Size, v.Mtime = strPtr(hash), intPtr(size), intPtr(mtime)
	v.ChangeType = vm.FileChangeType(ct)
	return v, err
}

func metaJSON(raw, key string) (any, error) {
	var v any
	if err := json.Unmarshal([]byte(raw), &v); err != nil {
		return nil, fmt.Errorf("Invalid JSON stored in note_metadata.%s", key)
	}
	return v, nil
}

func scanNoteMetadata(s scanner) (vm.NoteMetadata, error) {
	var n vm.NoteMetadata
	var title sql.NullString
	var fm, hd, tg, bl string
	if err := s.Scan(&n.FileID, &n.VaultID, &n.IndexedBlobHash, &title, &fm, &hd, &tg, &bl, &n.IndexedAt); err != nil {
		return n, err
	}
	n.Title = strPtr(title)
	bad := func(key string) error { return fmt.Errorf("Invalid JSON stored in note_metadata.%s", key) }
	v, err := metaJSON(fm, "frontmatter_json")
	if err != nil {
		return n, err
	}
	obj, ok := v.(map[string]any)
	if !ok {
		return n, bad("frontmatter_json")
	}
	n.Frontmatter = obj
	arrays := []struct {
		raw, key string
		dst      *[]any
	}{{hd, "headings_json", &n.Headings}, {bl, "blocks_json", &n.Blocks}}
	for _, a := range arrays {
		v, err := metaJSON(a.raw, a.key)
		if err != nil {
			return n, err
		}
		arr, ok := v.([]any)
		if !ok {
			return n, bad(a.key)
		}
		*a.dst = arr
	}
	v, err = metaJSON(tg, "tags_json")
	if err != nil {
		return n, err
	}
	arr, ok := v.([]any)
	if !ok {
		return n, bad("tags_json")
	}
	n.Tags = make([]string, 0, len(arr))
	for _, item := range arr {
		str, ok := item.(string)
		if !ok {
			return n, bad("tags_json")
		}
		n.Tags = append(n.Tags, str)
	}
	return n, nil
}

func scanNoteLink(s scanner) (vm.NoteLink, error) {
	var l vm.NoteLink
	var sub, disp, target sql.NullString
	var embed int64
	err := s.Scan(&l.ID, &l.VaultID, &l.SourceFileID, &l.RawText, &l.LinkPath, &sub, &disp, &embed, &target, &l.CreatedAt)
	l.Subpath, l.DisplayText, l.TargetFileID = strPtr(sub), strPtr(disp), strPtr(target)
	l.IsEmbed = embed == 1
	return l, err
}

func scanGraphCache(s scanner) (db.GraphCacheEntry, error) {
	var g db.GraphCacheEntry
	err := s.Scan(&g.VaultID, &g.Revision, &g.IndexedRevision, &g.ETag, &g.PayloadJSON, &g.UpdatedAt)
	return g, err
}

func scanObsidian(s scanner) (vm.ObsidianSyncSettings, error) {
	var o vm.ObsidianSyncSettings
	var remote, lastErr sql.NullString
	var enabled, synced int64
	var lastSynced sql.NullInt64
	var mode, phase string
	err := s.Scan(&o.VaultID, &enabled, &remote, &mode, &phase, &lastErr, &synced, &lastSynced)
	o.Enabled, o.HasSynced = enabled == 1, synced == 1
	o.RemoteVaultID, o.LastErrorCode, o.LastSyncedAt = strPtr(remote), strPtr(lastErr), intPtr(lastSynced)
	o.Mode, o.Phase = vm.ObsidianSyncMode(mode), vm.ObsidianSyncPhase(phase)
	return o, err
}
