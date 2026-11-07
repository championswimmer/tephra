// Package vaultmodel holds the persisted vault entities and the revision diff.
// It mirrors tephra-server/packages/vault-model. JSON tags are the camelCase
// names used by the TS objects.
//
// Conventions: a TS `T | null` field is a pointer WITHOUT omitempty (marshals
// as null); a TS optional `field?: T` is a pointer (or empty enum string) WITH
// omitempty (absent when unset). Nil slices marshal as JSON null, so callers
// must initialise slices they serialise.
package vaultmodel

type User struct {
	ID           string  `json:"id"`
	Email        string  `json:"email"`
	PasswordHash *string `json:"passwordHash"`
	CreatedAt    int64   `json:"createdAt"`
	UpdatedAt    int64   `json:"updatedAt"`
}

// SyncMode is how a vault is synchronised.
type SyncMode string

const (
	SyncModeTephra   SyncMode = "tephra"
	SyncModeObsidian SyncMode = "obsidian"
)

type Vault struct {
	// SyncMode is empty for legacy objects, which mean Tephra Sync. Immutable
	// after creation. Use EffectiveSyncMode to read it.
	SyncMode       SyncMode `json:"syncMode,omitempty"`
	ID             string   `json:"id"`
	OwnerUserID    string   `json:"ownerUserId"`
	Name           string   `json:"name"`
	LatestRevision int64    `json:"latestRevision"`
	CreatedAt      int64    `json:"createdAt"`
	UpdatedAt      int64    `json:"updatedAt"`
}

// EffectiveSyncMode returns SyncMode, defaulting legacy (empty) to tephra.
func (v Vault) EffectiveSyncMode() SyncMode {
	if v.SyncMode == "" {
		return SyncModeTephra
	}
	return v.SyncMode
}

type Device struct {
	ID         string  `json:"id"`
	UserID     string  `json:"userId"`
	Name       string  `json:"name"`
	Platform   *string `json:"platform,omitempty"`
	CreatedAt  int64   `json:"createdAt"`
	LastSeenAt int64   `json:"lastSeenAt"`
}

type Session struct {
	ID        string `json:"id"`
	UserID    string `json:"userId"`
	ExpiresAt int64  `json:"expiresAt"`
	CreatedAt int64  `json:"createdAt"`
}

type ApiTokenScope string

const (
	ScopeVaultReadMetadata ApiTokenScope = "vault:read-metadata"
	ScopeVaultUpload       ApiTokenScope = "vault:upload"
	ScopeVaultWrite        ApiTokenScope = "vault:write"
)

type ApiToken struct {
	ID         string          `json:"id"`
	UserID     string          `json:"userId"`
	VaultID    *string         `json:"vaultId"`
	DeviceID   *string         `json:"deviceId"`
	TokenHash  string          `json:"tokenHash"`
	Name       string          `json:"name"`
	Scopes     []ApiTokenScope `json:"scopes"`
	CreatedAt  int64           `json:"createdAt"`
	LastUsedAt *int64          `json:"lastUsedAt"`
	ExpiresAt  *int64          `json:"expiresAt"`
	RevokedAt  *int64          `json:"revokedAt"`
}

type BlobMetadata struct {
	Hash      string  `json:"hash"`
	Size      int64   `json:"size"`
	MimeType  *string `json:"mimeType"`
	CreatedAt int64   `json:"createdAt"`
}

type VaultFileKind string

const (
	KindMarkdown   VaultFileKind = "markdown"
	KindAttachment VaultFileKind = "attachment"
)

type CurrentVaultFile struct {
	FileID          string        `json:"fileId"`
	VaultID         string        `json:"vaultId"`
	Path            string        `json:"path"`
	BlobHash        string        `json:"blobHash"`
	Size            int64         `json:"size"`
	Mtime           int64         `json:"mtime"`
	MimeType        *string       `json:"mimeType,omitempty"`
	Kind            VaultFileKind `json:"kind"`
	UpdatedRevision int64         `json:"updatedRevision"`
}

type VaultRevision struct {
	VaultID      string `json:"vaultId"`
	Revision     int64  `json:"revision"`
	ManifestHash string `json:"manifestHash"`
	DeviceID     string `json:"deviceId"`
	CreatedAt    int64  `json:"createdAt"`
}

type FileChangeType string

const (
	ChangeCreate FileChangeType = "create"
	ChangeModify FileChangeType = "modify"
	ChangeRename FileChangeType = "rename"
	ChangeDelete FileChangeType = "delete"
)

type FileVersion struct {
	ID         string         `json:"id"`
	VaultID    string         `json:"vaultId"`
	FileID     string         `json:"fileId"`
	Revision   int64          `json:"revision"`
	Path       string         `json:"path"`
	BlobHash   *string        `json:"blobHash"`
	Size       *int64         `json:"size"`
	Mtime      *int64         `json:"mtime"`
	ChangeType FileChangeType `json:"changeType"`
	CreatedAt  int64          `json:"createdAt"`
}

type NoteMetadata struct {
	FileID          string         `json:"fileId"`
	VaultID         string         `json:"vaultId"`
	IndexedBlobHash string         `json:"indexedBlobHash"`
	Title           *string        `json:"title"`
	Frontmatter     map[string]any `json:"frontmatter"`
	Headings        []any          `json:"headings"`
	Tags            []string       `json:"tags"`
	Blocks          []any          `json:"blocks"`
	IndexedAt       int64          `json:"indexedAt"`
}

type NoteLink struct {
	ID           string  `json:"id"`
	VaultID      string  `json:"vaultId"`
	SourceFileID string  `json:"sourceFileId"`
	RawText      string  `json:"rawText"`
	LinkPath     string  `json:"linkPath"`
	Subpath      *string `json:"subpath"`
	DisplayText  *string `json:"displayText"`
	IsEmbed      bool    `json:"isEmbed"`
	TargetFileID *string `json:"targetFileId"`
	CreatedAt    int64   `json:"createdAt"`
}

type VaultIndexState struct {
	VaultID         string  `json:"vaultId"`
	IndexedRevision int64   `json:"indexedRevision"`
	LastError       *string `json:"lastError"`
}

type IncomingVaultFile struct {
	FileID   string        `json:"fileId"`
	Path     string        `json:"path"`
	BlobHash string        `json:"blobHash"`
	Size     int64         `json:"size"`
	Mtime    int64         `json:"mtime"`
	MimeType *string       `json:"mimeType,omitempty"`
	Kind     VaultFileKind `json:"kind"`
}

type ObsidianSyncMode string

const (
	ObsidianModeBidirectional ObsidianSyncMode = "bidirectional"
	ObsidianModePullOnly      ObsidianSyncMode = "pull-only"
)

type ObsidianSyncPhase string

const (
	PhasePendingLogin  ObsidianSyncPhase = "pending-login"
	PhasePendingRemote ObsidianSyncPhase = "pending-remote"
	PhaseInstalling    ObsidianSyncPhase = "installing"
	PhaseInitialSync   ObsidianSyncPhase = "initial-sync"
	PhaseRunning       ObsidianSyncPhase = "running"
	PhaseStopped       ObsidianSyncPhase = "stopped"
	PhaseError         ObsidianSyncPhase = "error"
)

type ObsidianSyncSettings struct {
	VaultID       string            `json:"vaultId"`
	Enabled       bool              `json:"enabled"`
	RemoteVaultID *string           `json:"remoteVaultId"`
	Mode          ObsidianSyncMode  `json:"mode"`
	Phase         ObsidianSyncPhase `json:"phase"`
	LastErrorCode *string           `json:"lastErrorCode"`
	HasSynced     bool              `json:"hasSynced"`
	LastSyncedAt  *int64            `json:"lastSyncedAt"`
}
