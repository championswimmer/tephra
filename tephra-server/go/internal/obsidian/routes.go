package obsidian

import (
	"net/http"
	"regexp"

	"github.com/championswimmer/tephra/tephra-server/go/internal/api"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// The routes register themselves when this package is linked in (the server
// main imports it to build the service). internal/api never imports this
// package, so there is no cycle.
func init() { api.Register(RegisterObsidianRoutes) }

var mfaRE6 = regexp.MustCompile(`^[0-9]{6}$`)

func parseLogin(body any) (httpx.ObsidianLogin, error) {
	var s httpx.Schema
	var in httpx.ObsidianLogin
	if m := s.StrictObject(body, "email", "password", "mfa"); m != nil {
		in.Email = s.Email(m, "email", 320)
		in.Password, _ = s.String(m, "password", true, false, 1, 4096)
		if mfa, ok := s.String(m, "mfa", false, false, 0, -1); ok {
			if !mfaRE6.MatchString(mfa) {
				s.Add("mfa", "Invalid string: must match pattern /^\\d{6}$/")
			}
			in.MFA = mfa
		}
	}
	return in, s.Err()
}

func parseSetup(body any) (httpx.ObsidianSetup, error) {
	var s httpx.Schema
	in := httpx.ObsidianSetup{Mode: string(vm.ObsidianModeBidirectional)}
	if m := s.StrictObject(body, "remoteVaultId", "encryptionPassword", "mode"); m != nil {
		in.RemoteVaultID, _ = s.String(m, "remoteVaultId", true, false, 1, 256)
		in.EncryptionPassword, _ = s.String(m, "encryptionPassword", false, false, 0, 4096)
		if raw, ok := m["mode"]; ok {
			switch raw {
			case "bidirectional", "pull-only":
				in.Mode = raw.(string)
			default:
				s.Add("mode", "Invalid option: expected one of \"bidirectional\"|\"pull-only\"")
			}
		}
	}
	return in, s.Err()
}

// parseUpdate accepts a strict partial settings update. At least one of
// enabled/frequency must be present; omitted fields stay unchanged.
func parseUpdate(body any) (httpx.ObsidianSettingsUpdate, error) {
	var s httpx.Schema
	var in httpx.ObsidianSettingsUpdate
	if m := s.StrictObject(body, "enabled", "frequency"); m != nil {
		if raw, ok := m["enabled"]; ok {
			switch v := raw.(type) {
			case bool:
				in.Enabled = &v
			case nil:
				s.Add("enabled", "Invalid input: expected boolean, received null")
			default:
				s.Add("enabled", "Invalid input: expected boolean")
			}
		}
		if raw, ok := m["frequency"]; ok {
			switch v := raw.(type) {
			case string:
				f := vm.ObsidianSyncFrequency(v)
				if !f.Valid() {
					s.Add("frequency", "Invalid option: expected one of \"continuous\"|\"6h\"|\"1h\"|\"30m\"|\"10m\"")
				} else {
					in.Frequency = &f
				}
			case nil:
				s.Add("frequency", "Invalid input: expected string, received null")
			default:
				s.Add("frequency", "Invalid input: expected string")
			}
		}
		if len(m) == 0 {
			s.Add("", "Invalid input: supply enabled or frequency")
		}
	}
	return in, s.Err()
}

func readBody[T any](r *http.Request, parse func(any) (T, error)) (T, error) {
	raw, err := httpx.JSONBody(r)
	if err != nil {
		var zero T
		return zero, err
	}
	return parse(raw)
}

// RegisterObsidianRoutes registers the capability, account and per-vault
// owner routes (routes/obsidian-sync.ts). Evaluation order follows the TS
// handlers so error precedence matches: session, owner, service availability
// (503), then body validation; PUT validates the body before the service.
func RegisterObsidianRoutes(mux *http.ServeMux, d api.Dependencies) {
	mux.Handle("GET /api/v1/obsidian-sync", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		if _, err := httpx.RequireSession(r); err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"available": d.ObsidianSync != nil})
		return nil
	}))
	mux.Handle("GET /api/v1/obsidian-sync/account", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		p, err := httpx.RequireSession(r)
		if err != nil {
			return err
		}
		svc, err := httpx.RequireObsidianService(d)
		if err != nil {
			return err
		}
		account, err := svc.AccountStatus(r.Context(), p.User.ID)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"account": account})
		return nil
	}))
	mux.Handle("POST /api/v1/obsidian-sync/account/login", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		p, err := httpx.RequireSession(r)
		if err != nil {
			return err
		}
		svc, err := httpx.RequireObsidianService(d)
		if err != nil {
			return err
		}
		in, err := readBody(r, parseLogin)
		if err != nil {
			return err
		}
		account, err := svc.AccountLogin(r.Context(), p.User.ID, in)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"account": account})
		return nil
	}))

	owner := func(r *http.Request) (vm.Vault, error) {
		if _, err := httpx.RequireSession(r); err != nil {
			return vm.Vault{}, err
		}
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return vm.Vault{}, err
		}
		if vault.SyncMode != vm.SyncModeObsidian {
			return vm.Vault{}, httpx.Fail(http.StatusConflict, protocol.CodeVaultSyncModeMismatch,
				"This vault uses the Tephra sync plugin and its sync method is fixed. Create a new Obsidian Sync vault on the vaults page.")
		}
		return *vault, nil
	}
	settings := func(w http.ResponseWriter, r *http.Request, svc httpx.ObsidianSyncService, vault vm.Vault, status int) error {
		st, err := svc.Status(r.Context(), vault)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, status, map[string]any{"settings": st})
		return nil
	}
	const base = "/api/v1/vaults/{vaultId}/obsidian-sync"
	mux.Handle("GET "+base, httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := owner(r)
		if err != nil {
			return err
		}
		svc, err := httpx.RequireObsidianService(d)
		if err != nil {
			return err
		}
		return settings(w, r, svc, vault, http.StatusOK)
	}))
	mux.Handle("POST "+base+"/login", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := owner(r)
		if err != nil {
			return err
		}
		svc, err := httpx.RequireObsidianService(d)
		if err != nil {
			return err
		}
		in, err := readBody(r, parseLogin)
		if err != nil {
			return err
		}
		if err := svc.Login(r.Context(), vault, in); err != nil {
			return err
		}
		return settings(w, r, svc, vault, http.StatusOK)
	}))
	mux.Handle("GET "+base+"/remotes", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := owner(r)
		if err != nil {
			return err
		}
		svc, err := httpx.RequireObsidianService(d)
		if err != nil {
			return err
		}
		remotes, err := svc.Remotes(r.Context(), vault)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"vaults": remotes})
		return nil
	}))
	mux.Handle("POST "+base+"/setup", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := owner(r)
		if err != nil {
			return err
		}
		svc, err := httpx.RequireObsidianService(d)
		if err != nil {
			return err
		}
		in, err := readBody(r, parseSetup)
		if err != nil {
			return err
		}
		if err := svc.Setup(r.Context(), vault, in); err != nil {
			return err
		}
		return settings(w, r, svc, vault, http.StatusAccepted)
	}))
	mux.Handle("PUT "+base, httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := owner(r)
		if err != nil {
			return err
		}
		in, err := readBody(r, parseUpdate)
		if err != nil {
			return err
		}
		svc, err := httpx.RequireObsidianService(d)
		if err != nil {
			return err
		}
		if err := svc.UpdateSettings(r.Context(), vault, in); err != nil {
			return err
		}
		return settings(w, r, svc, vault, http.StatusOK)
	}))
}
