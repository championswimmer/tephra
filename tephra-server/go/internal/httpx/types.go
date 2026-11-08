// Package httpx holds the HTTP plumbing shared by every route file: the
// dependency bundle, error envelope, JSON in/out, request logging and the
// auth/vault-scope middleware. It ports tephra-server/apps/api/src/http/*.
package httpx

import (
	"context"
	"io"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/core"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/indexer"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// DefaultBlobLimit is the default maximum blob size (100 MiB).
const DefaultBlobLimit int64 = 100 * 1024 * 1024

// DefaultSessionCookieName is the session cookie name when none is configured.
const DefaultSessionCookieName = "tephra_session"

// Optional capabilities of the TS IndexService (each method is optional).
// Dependencies.IndexService may implement any subset. They are aliases of the
// indexer package types so indexer.NewRuntimeIndexService satisfies them.
type (
	VaultIndexer        = indexer.VaultIndexer
	RenderMarkdownInput = indexer.RenderMarkdownInput
	MarkdownRenderer    = indexer.MarkdownRenderer
	SearchInput         = indexer.SearchInput
	NoteSearcher        = indexer.NoteSearcher
)

// ObsidianSyncService mirrors apps/api/src/obsidian/types.ts.
type ObsidianSyncService interface {
	AccountStatus(ctx context.Context, userID string) (ObsidianAccount, error)
	AccountLogin(ctx context.Context, userID string, in ObsidianLogin) (ObsidianAccount, error)
	Status(ctx context.Context, vault vm.Vault) (vm.ObsidianSyncSettings, error)
	Login(ctx context.Context, vault vm.Vault, in ObsidianLogin) error
	Remotes(ctx context.Context, vault vm.Vault) ([]ObsidianRemote, error)
	Setup(ctx context.Context, vault vm.Vault, in ObsidianSetup) error
	Enable(ctx context.Context, vault vm.Vault, enabled bool) error
	UpdateSettings(ctx context.Context, vault vm.Vault, in ObsidianSettingsUpdate) error
	Remove(ctx context.Context, vault vm.Vault) error
	WriteNote(ctx context.Context, vault vm.Vault, plan NotePlan, text string) (NoteCommitResult, error)
}

type ObsidianLogin struct {
	Email    string `json:"email"`
	Password string `json:"password"`
	MFA      string `json:"mfa,omitempty"`
}

type ObsidianSetup struct {
	RemoteVaultID      string `json:"remoteVaultId"`
	EncryptionPassword string `json:"encryptionPassword,omitempty"`
	Mode               string `json:"mode"` // "bidirectional" | "pull-only"
}

// ObsidianSettingsUpdate is a strict partial settings update. Omitted fields are
// unchanged; the route rejects a body that supplies neither.
type ObsidianSettingsUpdate struct {
	Enabled   *bool                     `json:"enabled,omitempty"`
	Frequency *vm.ObsidianSyncFrequency `json:"frequency,omitempty"`
}

type ObsidianRemote struct {
	ID     string `json:"id"`
	Name   string `json:"name"`
	Region string `json:"region,omitempty"`
}

type ObsidianAccount struct {
	Authenticated bool    `json:"authenticated"`
	Email         *string `json:"email"`
	LastErrorCode *string `json:"lastErrorCode"`
}

// NotePlan is the TS `{kind:'create',path} | {kind:'update',fileId,baseHash}`.
type NotePlan struct {
	Kind     string // "create" | "update"
	Path     string
	FileID   string
	BaseHash string
}

// NoteCommitResult is the TS mcp/commit.ts NoteCommitResult union. Status is
// "committed" | "up-to-date" (File, Revision set) or "conflict" | "exists"
// (Current set).
type NoteCommitResult struct {
	Status   string
	Revision int64
	File     *vm.CurrentVaultFile
	Current  *vm.CurrentVaultFile
}

// InitialObsidianSettings is initialObsidianSettings from obsidian/types.ts.
func InitialObsidianSettings(vaultID string) vm.ObsidianSyncSettings {
	return vm.ObsidianSyncSettings{
		VaultID: vaultID, Enabled: false, Frequency: vm.FrequencyContinuous,
		Mode: vm.ObsidianModeBidirectional, Phase: vm.PhasePendingLogin,
	}
}

// Dependencies mirrors ApiDependencies. All fields except the optional ones
// documented below are required.
type Dependencies struct {
	ObsidianSync ObsidianSyncService // optional (nil = disabled)
	Database     db.Database
	BlobStore    blobstore.Store
	Clock        core.Clock
	IDs          core.IdGenerator
	// PasswordHasher: see api.NewScryptHasher to adapt internal/auth.
	PasswordHasher core.PasswordHasher
	// BootstrapToken: empty means bootstrap is impossible (TS: falsy).
	BootstrapToken string
	// IndexService may implement VaultIndexer, MarkdownRenderer, NoteSearcher.
	IndexService any
	// SecureCookies false omits the Secure attribute (TS secureCookies:false).
	// Production wiring passes NODE_ENV == "production".
	SecureCookies bool
	// SessionCookieName defaults to "tephra_session".
	SessionCookieName string
	// MaxBlobBytes <= 0 means DefaultBlobLimit.
	MaxBlobBytes int64
	// PublicURL is the externally visible origin; empty derives it from the request.
	PublicURL string
	// LogWriter receives the one-JSON-line-per-request access log (default os.Stdout).
	LogWriter io.Writer
}

// BlobLimit returns the effective maximum blob size.
func (d Dependencies) BlobLimit() int64 {
	if d.MaxBlobBytes > 0 {
		return d.MaxBlobBytes
	}
	return DefaultBlobLimit
}

// CookieName returns the effective session cookie name.
func (d Dependencies) CookieName() string {
	if d.SessionCookieName != "" {
		return d.SessionCookieName
	}
	return DefaultSessionCookieName
}

// Indexer returns the optional VaultIndexer capability or nil.
func (d Dependencies) Indexer() VaultIndexer { v, _ := d.IndexService.(VaultIndexer); return v }

// Renderer returns the optional MarkdownRenderer capability or nil.
func (d Dependencies) Renderer() MarkdownRenderer {
	v, _ := d.IndexService.(MarkdownRenderer)
	return v
}

// Searcher returns the optional NoteSearcher capability or nil.
func (d Dependencies) Searcher() NoteSearcher { v, _ := d.IndexService.(NoteSearcher); return v }
