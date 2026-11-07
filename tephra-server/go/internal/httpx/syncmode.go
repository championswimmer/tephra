package httpx

import (
	"net/http"

	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// RequireTephraSync rejects direct device sync on Obsidian-sync vaults (409).
func RequireTephraSync(v vm.Vault) error {
	if v.SyncMode == vm.SyncModeObsidian {
		return Fail(http.StatusConflict, protocol.CodeVaultSyncModeMismatch,
			"Official Obsidian Sync is enabled for this vault. Direct device sync (plan, upload, and commit) is disabled. Use Obsidian Sync on your devices.")
	}
	return nil
}

// RequireObsidianService returns the configured service or 503 OBSIDIAN_UNAVAILABLE.
func RequireObsidianService(d Dependencies) (ObsidianSyncService, error) {
	if d.ObsidianSync == nil {
		return nil, Fail(http.StatusServiceUnavailable, protocol.CodeObsidianUnavailable, "Obsidian Sync is disabled on this server.")
	}
	return d.ObsidianSync, nil
}
