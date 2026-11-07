package api

import (
	"net/http"

	"github.com/championswimmer/tephra/tephra-server/go/internal/auth"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// tokenDTO is an API token without its hash.
type tokenDTO struct {
	ID         string             `json:"id"`
	UserID     string             `json:"userId"`
	VaultID    *string            `json:"vaultId"`
	DeviceID   *string            `json:"deviceId"`
	Name       string             `json:"name"`
	Scopes     []vm.ApiTokenScope `json:"scopes"`
	CreatedAt  int64              `json:"createdAt"`
	LastUsedAt *int64             `json:"lastUsedAt"`
	ExpiresAt  *int64             `json:"expiresAt"`
	RevokedAt  *int64             `json:"revokedAt"`
}

type tokenInput struct {
	name       string
	deviceID   string
	deviceName string
	platform   *string
	scopes     []vm.ApiTokenScope
	expiresAt  *int64
}

func parseTokenInput(body any) (tokenInput, error) {
	var s httpx.Schema
	in := tokenInput{scopes: []vm.ApiTokenScope{vm.ScopeVaultReadMetadata, vm.ScopeVaultUpload}}
	m := s.StrictObject(body, "name", "deviceId", "deviceName", "platform", "scopes", "expiresAt")
	if m == nil {
		return in, s.Err()
	}
	in.name, _ = s.String(m, "name", true, true, 1, 200)
	in.deviceID, _ = s.String(m, "deviceId", false, false, 1, 200)
	in.deviceName, _ = s.String(m, "deviceName", false, true, 1, 200)
	if p, ok := s.String(m, "platform", false, false, 0, 100); ok {
		in.platform = &p
	}
	if raw, ok := m["scopes"]; ok {
		arr, isArr := raw.([]any)
		switch {
		case !isArr:
			s.Add("scopes", "Invalid input: expected array")
		case len(arr) < 1 || len(arr) > 3:
			s.Add("scopes", "Invalid array length.")
		default:
			scopes := make([]vm.ApiTokenScope, 0, len(arr))
			for _, item := range arr {
				switch item {
				case "vault:read-metadata", "vault:upload", "vault:write":
					scopes = append(scopes, vm.ApiTokenScope(item.(string)))
				default:
					s.Add("scopes", "Invalid option: expected one of \"vault:read-metadata\"|\"vault:upload\"|\"vault:write\"")
				}
			}
			in.scopes = scopes
		}
	}
	if raw, ok := m["expiresAt"]; ok && raw != nil {
		if n, ok := s.SafePositiveInt("expiresAt", raw); ok {
			in.expiresAt = &n
		}
	}
	return in, s.Err()
}

func hasScope(scopes []vm.ApiTokenScope, want vm.ApiTokenScope) bool {
	for _, s := range scopes {
		if s == want {
			return true
		}
	}
	return false
}

func strPtr(s string) *string { return &s }

// RegisterTokenRoutes registers the per-vault API token endpoints.
func RegisterTokenRoutes(mux *http.ServeMux, d Dependencies) {
	const base = "/api/v1/vaults/{vaultId}/tokens"

	mux.Handle("GET "+base, httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		if _, err := httpx.RequireSession(r); err != nil {
			return err
		}
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return err
		}
		tokens, err := d.Database.ApiTokens().ListByVault(r.Context(), vault.ID)
		if err != nil {
			return err
		}
		out := make([]tokenDTO, 0, len(tokens))
		for _, t := range tokens {
			out = append(out, tokenDTO{ID: t.ID, UserID: t.UserID, VaultID: t.VaultID, DeviceID: t.DeviceID,
				Name: t.Name, Scopes: t.Scopes, CreatedAt: t.CreatedAt, LastUsedAt: t.LastUsedAt,
				ExpiresAt: t.ExpiresAt, RevokedAt: t.RevokedAt})
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"tokens": out})
		return nil
	}))

	mux.Handle("POST "+base, httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		p, err := httpx.RequireSession(r)
		if err != nil {
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
		in, err := parseTokenInput(raw)
		if err != nil {
			return err
		}
		if hasScope(in.scopes, vm.ScopeVaultUpload) {
			if err := httpx.RequireTephraSync(*vault); err != nil {
				return err
			}
		}
		ctx := r.Context()
		devices := d.Database.Devices()
		now := d.Clock.Now()
		var deviceID *string
		switch {
		case in.deviceID != "":
			deviceID = strPtr(in.deviceID)
			existing, err := devices.FindByID(ctx, in.deviceID)
			if err != nil {
				return err
			}
			if existing != nil {
				if existing.UserID != p.User.ID {
					return httpx.Fail(http.StatusForbidden, protocol.CodeVaultAccessDenied, "Device belongs to another user.")
				}
				updated := *existing
				if in.deviceName != "" {
					updated.Name = in.deviceName
				}
				if in.platform != nil {
					updated.Platform = in.platform
				}
				updated.LastSeenAt = now
				if err := devices.Update(ctx, updated); err != nil {
					return err
				}
			} else {
				name := in.deviceName
				if name == "" {
					name = in.deviceID
				}
				if err := devices.Insert(ctx, vm.Device{ID: in.deviceID, UserID: p.User.ID, Name: name,
					Platform: in.platform, CreatedAt: now, LastSeenAt: now}); err != nil {
					return err
				}
			}
		case in.deviceName != "":
			deviceID = strPtr(d.IDs.Generate())
			if err := devices.Insert(ctx, vm.Device{ID: *deviceID, UserID: p.User.ID, Name: in.deviceName,
				Platform: in.platform, CreatedAt: now, LastSeenAt: now}); err != nil {
				return err
			}
		}
		rawToken, err := auth.CreateOpaqueToken("tpt")
		if err != nil {
			return err
		}
		token := vm.ApiToken{ID: d.IDs.Generate(), UserID: p.User.ID, VaultID: strPtr(vault.ID), DeviceID: deviceID,
			TokenHash: auth.HashOpaqueToken(rawToken), Name: in.name, Scopes: in.scopes, CreatedAt: now,
			ExpiresAt: in.expiresAt}
		if err := d.Database.ApiTokens().Insert(ctx, token); err != nil {
			return err
		}
		type createdToken struct {
			ID        string             `json:"id"`
			Name      string             `json:"name"`
			Scopes    []vm.ApiTokenScope `json:"scopes"`
			ExpiresAt *int64             `json:"expiresAt"`
		}
		httpx.WriteJSON(w, http.StatusCreated, struct {
			Token createdToken `json:"token"`
			Value string       `json:"value"`
		}{createdToken{token.ID, token.Name, token.Scopes, token.ExpiresAt}, rawToken})
		return nil
	}))

	mux.Handle("DELETE "+base+"/{tokenId}", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		if _, err := httpx.RequireSession(r); err != nil {
			return err
		}
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return err
		}
		token, err := d.Database.ApiTokens().FindByID(r.Context(), r.PathValue("tokenId"))
		if err != nil {
			return err
		}
		if token == nil || token.VaultID == nil || *token.VaultID != vault.ID {
			return httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "Token was not found.")
		}
		now := d.Clock.Now()
		updated := *token
		updated.RevokedAt = &now
		if err := d.Database.ApiTokens().Update(r.Context(), updated); err != nil {
			return err
		}
		httpx.WriteNoContent(w)
		return nil
	}))
}
