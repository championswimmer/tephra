// Package db defines the persistence interfaces. It mirrors
// tephra-server/packages/database/core exactly; implementations (SQLite) live
// in subpackages and all other code must depend only on these interfaces.
//
// Conventions:
//   - Every method takes a context.Context first and returns an error last.
//   - "Not found" is NOT an error: Find*/Get-style methods return (nil, nil)
//     when no row matches (TS `null`). A non-nil error means a real failure.
//   - List-style methods return an empty (possibly nil) slice, never an error,
//     when nothing matches.
//   - Insert/Update/Delete on a missing row follow the TS adapter behaviour
//     (Delete of an unknown id is a no-op); constraint violations surface as
//     errors from the implementation.
//   - Timestamps and revisions are int64 (epoch milliseconds / counters).
package db

import (
	"context"

	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

type UserRepository interface {
	Count(ctx context.Context) (int64, error)
	FindByID(ctx context.Context, id string) (*vm.User, error)
	FindByEmail(ctx context.Context, email string) (*vm.User, error)
	Insert(ctx context.Context, user vm.User) error
	Update(ctx context.Context, user vm.User) error
}

type SessionRepository interface {
	FindByID(ctx context.Context, id string) (*vm.Session, error)
	Insert(ctx context.Context, session vm.Session) error
	Delete(ctx context.Context, id string) error
	// DeleteExpired removes sessions expired at `now` and returns how many.
	DeleteExpired(ctx context.Context, now int64) (int64, error)
}

type VaultRepository interface {
	FindByID(ctx context.Context, id string) (*vm.Vault, error)
	FindByName(ctx context.Context, name string) (*vm.Vault, error)
	ListByOwner(ctx context.Context, ownerUserID string) ([]vm.Vault, error)
	Insert(ctx context.Context, vault vm.Vault) error
	Update(ctx context.Context, vault vm.Vault) error
	Delete(ctx context.Context, id string) error
}

type DeviceRepository interface {
	FindByID(ctx context.Context, id string) (*vm.Device, error)
	ListByUser(ctx context.Context, userID string) ([]vm.Device, error)
	Insert(ctx context.Context, device vm.Device) error
	Update(ctx context.Context, device vm.Device) error
}

type ApiTokenRepository interface {
	FindByID(ctx context.Context, id string) (*vm.ApiToken, error)
	FindByTokenHash(ctx context.Context, tokenHash string) (*vm.ApiToken, error)
	ListByVault(ctx context.Context, vaultID string) ([]vm.ApiToken, error)
	Insert(ctx context.Context, token vm.ApiToken) error
	Update(ctx context.Context, token vm.ApiToken) error
	Delete(ctx context.Context, id string) error
}

// OAuthCode is a pending MCP/OAuth authorization (stored by code hash; single use).
type OAuthCode struct {
	CodeHash      string             `json:"codeHash"`
	UserID        string             `json:"userId"`
	VaultID       string             `json:"vaultId"`
	ClientID      string             `json:"clientId"`
	ClientName    string             `json:"clientName"`
	RedirectURI   string             `json:"redirectUri"`
	CodeChallenge string             `json:"codeChallenge"`
	Scopes        []vm.ApiTokenScope `json:"scopes"`
	CreatedAt     int64              `json:"createdAt"`
	ExpiresAt     int64              `json:"expiresAt"`
}

type OAuthCodeRepository interface {
	Insert(ctx context.Context, code OAuthCode) error
	// Consume atomically removes and returns the code, or (nil, nil) when unknown.
	Consume(ctx context.Context, codeHash string) (*OAuthCode, error)
	DeleteExpired(ctx context.Context, now int64) (int64, error)
}

type BlobRepository interface {
	FindByHash(ctx context.Context, hash string) (*vm.BlobMetadata, error)
	FindByHashes(ctx context.Context, hashes []string) ([]vm.BlobMetadata, error)
	// FindUnreferencedOlderThan lists blobs that are not referenced by any
	// current vault file or any retained file version and were created strictly
	// before cutoff, oldest first. Used by blob garbage collection; callers must
	// pass a cutoff that leaves a grace period (for example 7 days) so blobs from
	// in-flight uploads are never returned.
	FindUnreferencedOlderThan(ctx context.Context, cutoff int64, limit int) ([]vm.BlobMetadata, error)
	Insert(ctx context.Context, blob vm.BlobMetadata) error
	Delete(ctx context.Context, hash string) error
}

type VaultFileRepository interface {
	FindByID(ctx context.Context, vaultID, fileID string) (*vm.CurrentVaultFile, error)
	FindByPath(ctx context.Context, vaultID, path string) (*vm.CurrentVaultFile, error)
	FindByPathFold(ctx context.Context, vaultID, pathFold string) ([]vm.CurrentVaultFile, error)
	ListByVault(ctx context.Context, vaultID string) ([]vm.CurrentVaultFile, error)
	Upsert(ctx context.Context, file vm.CurrentVaultFile) error
	Delete(ctx context.Context, vaultID, fileID string) error
}

type VaultRevisionRepository interface {
	Find(ctx context.Context, vaultID string, revision int64) (*vm.VaultRevision, error)
	FindLatest(ctx context.Context, vaultID string) (*vm.VaultRevision, error)
	// FindByManifestHash returns the NEWEST revision carrying manifestHash, or
	// (nil, nil). The same hash may appear on several revisions (a web edit
	// followed by a revert reproduces an earlier vault state), so callers must
	// not assume uniqueness.
	FindByManifestHash(ctx context.Context, vaultID, manifestHash string) (*vm.VaultRevision, error)
	List(ctx context.Context, vaultID string) ([]vm.VaultRevision, error)
	Insert(ctx context.Context, revision vm.VaultRevision) error
}

type FileVersionRepository interface {
	ListByRevision(ctx context.Context, vaultID string, revision int64) ([]vm.FileVersion, error)
	ListByFile(ctx context.Context, vaultID, fileID string) ([]vm.FileVersion, error)
	FindLatestByPath(ctx context.Context, vaultID, path string) (*vm.FileVersion, error)
	// ListSince returns rows with revision > sinceRevision, ordered by
	// (revision, id). Serves the pull feed (GET /changes); the existing
	// file_versions_revision_idx(vault_id, revision) covers it.
	ListSince(ctx context.Context, vaultID string, sinceRevision int64, limit int) ([]vm.FileVersion, error)
	InsertMany(ctx context.Context, versions []vm.FileVersion) error
}

type NoteIndexRepository interface {
	FindMetadata(ctx context.Context, fileID string) (*vm.NoteMetadata, error)
	ListMetadata(ctx context.Context, vaultID string) ([]vm.NoteMetadata, error)
	UpsertMetadata(ctx context.Context, metadata vm.NoteMetadata) error
	DeleteMetadata(ctx context.Context, fileID string) error
	ListLinksBySource(ctx context.Context, vaultID, sourceFileID string) ([]vm.NoteLink, error)
	ListLinksByTarget(ctx context.Context, vaultID, targetFileID string) ([]vm.NoteLink, error)
	ListLinks(ctx context.Context, vaultID string) ([]vm.NoteLink, error)
	ReplaceLinksForSource(ctx context.Context, vaultID, sourceFileID string, links []vm.NoteLink) error
	GetState(ctx context.Context, vaultID string) (*vm.VaultIndexState, error)
	SetState(ctx context.Context, state vm.VaultIndexState) error
}

type GraphCacheEntry struct {
	VaultID         string `json:"vaultId"`
	Revision        int64  `json:"revision"`
	IndexedRevision int64  `json:"indexedRevision"`
	ETag            string `json:"etag"`
	PayloadJSON     string `json:"payloadJson"`
	UpdatedAt       int64  `json:"updatedAt"`
}

type GraphCacheRepository interface {
	Find(ctx context.Context, vaultID string) (*GraphCacheEntry, error)
	Upsert(ctx context.Context, entry GraphCacheEntry) error
	DeleteByVault(ctx context.Context, vaultID string) error
}

type ObsidianSyncRepository interface {
	Find(ctx context.Context, vaultID string) (*vm.ObsidianSyncSettings, error)
	List(ctx context.Context) ([]vm.ObsidianSyncSettings, error)
	Upsert(ctx context.Context, settings vm.ObsidianSyncSettings) error
}

// Repositories groups every repository (TS: an object of repositories).
type Repositories interface {
	ObsidianSync() ObsidianSyncRepository
	Users() UserRepository
	Sessions() SessionRepository
	Vaults() VaultRepository
	Devices() DeviceRepository
	ApiTokens() ApiTokenRepository
	OAuthCodes() OAuthCodeRepository
	Blobs() BlobRepository
	VaultFiles() VaultFileRepository
	VaultRevisions() VaultRevisionRepository
	FileVersions() FileVersionRepository
	NoteIndex() NoteIndexRepository
	GraphCache() GraphCacheRepository
}

// TransactionRepositories are the repositories bound to one transaction.
type TransactionRepositories interface {
	Repositories
	// LockVault takes adapter-specific serialization or row locking for a vault
	// commit (SQLite: the surrounding transaction is BEGIN IMMEDIATE, so this is
	// effectively a no-op there). Must be called inside Transaction.
	LockVault(ctx context.Context, vaultID string) error
}

// Database is the root handle: non-transactional repositories plus Transaction.
type Database interface {
	Repositories
	// Transaction runs fn atomically. If fn returns an error (or panics) the
	// transaction is rolled back and that error is returned; otherwise it is
	// committed. Repositories passed to fn must be used only within fn. Use
	// InTransaction to return a value.
	Transaction(ctx context.Context, fn func(TransactionRepositories) error) error
}

// InTransaction is the generic form of Database.Transaction (TS
// `transaction<T>` returns the operation's result).
func InTransaction[T any](ctx context.Context, d Database, fn func(TransactionRepositories) (T, error)) (T, error) {
	var result T
	err := d.Transaction(ctx, func(r TransactionRepositories) error {
		v, err := fn(r)
		if err != nil {
			return err
		}
		result = v
		return nil
	})
	if err != nil {
		var zero T
		return zero, err
	}
	return result, nil
}
