package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// vaultDTO is the public vault shape (key order matches the TS object literal).
type vaultDTO struct {
	ID             string      `json:"id"`
	OwnerUserID    string      `json:"ownerUserId"`
	Name           string      `json:"name"`
	SyncMode       vm.SyncMode `json:"syncMode,omitempty"`
	LatestRevision int64       `json:"latestRevision"`
	CreatedAt      int64       `json:"createdAt"`
	UpdatedAt      int64       `json:"updatedAt"`
}

// storedVaultDTO is the same shape in database-row key order (syncMode first),
// which is what Node returns for vaults read back from the database.
type storedVaultDTO struct {
	SyncMode       vm.SyncMode `json:"syncMode,omitempty"`
	ID             string      `json:"id"`
	OwnerUserID    string      `json:"ownerUserId"`
	Name           string      `json:"name"`
	LatestRevision int64       `json:"latestRevision"`
	CreatedAt      int64       `json:"createdAt"`
	UpdatedAt      int64       `json:"updatedAt"`
}

type obsidianStoredVaultDTO struct {
	storedVaultDTO
	ReadOnly     bool              `json:"readOnly"`
	ObsidianSync obsidianStatusDTO `json:"obsidianSync"`
}

func toStoredVaultDTO(v vm.Vault) storedVaultDTO {
	return storedVaultDTO{SyncMode: v.SyncMode, ID: v.ID, OwnerUserID: v.OwnerUserID, Name: v.Name,
		LatestRevision: v.LatestRevision, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}

type obsidianStatusDTO struct {
	Enabled       bool    `json:"enabled"`
	Phase         string  `json:"phase"`
	LastErrorCode *string `json:"lastErrorCode"`
	LastSyncedAt  *int64  `json:"lastSyncedAt"`
}

type obsidianVaultDTO struct {
	vaultDTO
	ReadOnly     bool              `json:"readOnly"`
	ObsidianSync obsidianStatusDTO `json:"obsidianSync"`
}

func toVaultDTO(v vm.Vault) vaultDTO {
	return vaultDTO{ID: v.ID, OwnerUserID: v.OwnerUserID, Name: v.Name, SyncMode: v.SyncMode,
		LatestRevision: v.LatestRevision, CreatedAt: v.CreatedAt, UpdatedAt: v.UpdatedAt}
}

// publicVault builds the response vault. stored selects database-row key order
// (list/get) instead of the create-time order.
func publicVault(ctx context.Context, v vm.Vault, d Dependencies, stored bool) (any, error) {
	if v.SyncMode != vm.SyncModeObsidian {
		if stored {
			return toStoredVaultDTO(v), nil
		}
		return toVaultDTO(v), nil
	}
	found, err := d.Database.ObsidianSync().Find(ctx, v.ID)
	if err != nil {
		return nil, err
	}
	settings := httpx.InitialObsidianSettings(v.ID)
	if found != nil {
		settings = *found
	}
	phase := string(settings.Phase)
	if d.ObsidianSync == nil {
		phase = "unavailable"
	}
	readOnly := d.ObsidianSync == nil || !settings.Enabled || settings.Phase != vm.PhaseRunning ||
		settings.Mode != vm.ObsidianModeBidirectional
	status := obsidianStatusDTO{Enabled: settings.Enabled, Phase: phase,
		LastErrorCode: settings.LastErrorCode, LastSyncedAt: settings.LastSyncedAt}
	if stored {
		return obsidianStoredVaultDTO{storedVaultDTO: toStoredVaultDTO(v), ReadOnly: readOnly, ObsidianSync: status}, nil
	}
	return obsidianVaultDTO{vaultDTO: toVaultDTO(v), ReadOnly: readOnly, ObsidianSync: status}, nil
}

func hasControlChar(s string) bool {
	for _, r := range s {
		if r <= 0x1f || (r >= 0x7f && r <= 0x9f) {
			return true
		}
	}
	return false
}

func parseVaultCreate(body any) (name string, mode vm.SyncMode, err error) {
	var s httpx.Schema
	m := s.StrictObject(body, "name", "syncMode")
	if m == nil {
		return "", "", s.Err()
	}
	name, _ = s.String(m, "name", true, true, 1, 200)
	if strings.ContainsAny(name, "/\\") || name == "." || name == ".." || hasControlChar(name) {
		s.Add("name", "Vault name must not contain slashes or control characters.")
	}
	mode = vm.SyncModeTephra
	if raw, ok := m["syncMode"]; ok {
		switch raw {
		case "tephra":
			mode = vm.SyncModeTephra
		case "obsidian":
			mode = vm.SyncModeObsidian
		default:
			s.Add("syncMode", "Invalid option: expected one of \"tephra\"|\"obsidian\"")
		}
	}
	return name, mode, s.Err()
}

// IsVaultNameConflict reports a UNIQUE/PRIMARY KEY violation on vaults.name.
func IsVaultNameConflict(err error) bool {
	if err == nil {
		return false
	}
	var coded interface{ Code() int }
	if errors.As(err, &coded) {
		if c := coded.Code(); c == 2067 || c == 1555 {
			return true
		}
	}
	msg := err.Error()
	return strings.Contains(msg, "vaults.name") || strings.Contains(msg, "SQLITE_CONSTRAINT_UNIQUE") ||
		strings.Contains(msg, "SQLITE_CONSTRAINT_PRIMARYKEY")
}

// RegisterVaultListRoutes registers GET/POST /api/v1/vaults.
func RegisterVaultListRoutes(mux *http.ServeMux, d Dependencies) {
	mux.Handle("GET /api/v1/vaults", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		p, err := httpx.RequireSession(r)
		if err != nil {
			return err
		}
		vaults, err := d.Database.Vaults().ListByOwner(r.Context(), p.User.ID)
		if err != nil {
			return err
		}
		out := make([]any, 0, len(vaults))
		for _, v := range vaults {
			pv, err := publicVault(r.Context(), v, d, true)
			if err != nil {
				return err
			}
			out = append(out, pv)
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"vaults": out})
		return nil
	}))

	mux.Handle("POST /api/v1/vaults", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		p, err := httpx.RequireSession(r)
		if err != nil {
			return err
		}
		raw, err := httpx.JSONBody(r)
		if err != nil {
			return err
		}
		name, mode, err := parseVaultCreate(raw)
		if err != nil {
			return err
		}
		ctx := r.Context()
		now := d.Clock.Now()
		vault := vm.Vault{ID: d.IDs.Generate(), OwnerUserID: p.User.ID, Name: name, SyncMode: mode,
			LatestRevision: 0, CreatedAt: now, UpdatedAt: now}
		taken := httpx.Fail(http.StatusConflict, protocol.CodeVaultNameTaken, "A vault with this name already exists.")
		existing, err := d.Database.Vaults().FindByName(ctx, vault.Name)
		if err != nil {
			return err
		}
		if existing != nil {
			return taken
		}
		err = func() error {
			var native httpx.ObsidianSyncService
			var account httpx.ObsidianAccount
			if vault.SyncMode == vm.SyncModeObsidian {
				if native, err = httpx.RequireObsidianService(d); err != nil {
					return err
				}
				if account, err = native.AccountStatus(ctx, p.User.ID); err != nil {
					return err
				}
			}
			return d.Database.Transaction(ctx, func(repos db.TransactionRepositories) error {
				if err := repos.Vaults().Insert(ctx, vault); err != nil {
					return err
				}
				if native != nil {
					settings := httpx.InitialObsidianSettings(vault.ID)
					if account.Authenticated {
						settings.Phase = vm.PhasePendingRemote
					}
					return repos.ObsidianSync().Upsert(ctx, settings)
				}
				return nil
			})
		}()
		if err != nil {
			if IsVaultNameConflict(err) {
				return taken
			}
			return err
		}
		pv, err := publicVault(ctx, vault, d, false)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, map[string]any{"vault": pv})
		return nil
	}))
}

// RegisterVaultRoutes registers GET/DELETE /api/v1/vaults/{vaultId}.
func RegisterVaultRoutes(mux *http.ServeMux, d Dependencies) {
	mux.Handle("GET /api/v1/vaults/{vaultId}", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return err
		}
		pv, err := publicVault(r.Context(), *vault, d, true)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"vault": pv})
		return nil
	}))

	mux.Handle("DELETE /api/v1/vaults/{vaultId}", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		if _, err := httpx.RequireSession(r); err != nil {
			return err
		}
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return err
		}
		raw, err := httpx.JSONBody(r)
		if err != nil {
			return err
		}
		var s httpx.Schema
		var confirmation string
		if m := s.StrictObject(raw, "confirmation"); m != nil {
			confirmation, _ = s.String(m, "confirmation", true, false, 0, 200)
		}
		if err := s.Err(); err != nil {
			return err
		}
		if confirmation != vault.Name {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeVaultNameMismatch, "Vault name confirmation does not match.")
		}
		if vault.SyncMode == vm.SyncModeObsidian {
			svc, err := httpx.RequireObsidianService(d)
			if err != nil {
				return err
			}
			if err := svc.Remove(r.Context(), *vault); err != nil {
				return err
			}
		}
		if err := d.Database.Vaults().Delete(r.Context(), vault.ID); err != nil {
			return err
		}
		httpx.WriteNoContent(w)
		return nil
	}))
}
