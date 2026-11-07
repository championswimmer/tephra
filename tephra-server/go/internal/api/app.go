// Package api assembles the HTTP application. Route files register
// themselves via Register (typically from an init func) or are listed in
// routeRegistrars below; NewApp wires the middleware chain in the same order
// as apps/api/src/app.ts.
package api

import (
	"net/http"
	"sync"

	"github.com/championswimmer/tephra/tephra-server/go/internal/auth"
	"github.com/championswimmer/tephra/tephra-server/go/internal/core"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
)

// Dependencies mirrors ApiDependencies (see httpx.Dependencies).
type Dependencies = httpx.Dependencies

// Registrar adds routes to the shared ServeMux. Patterns use Go 1.22 syntax
// ("GET /api/v1/vaults/{vaultId}/files"); wrap handlers with httpx.Handle.
type Registrar func(mux *http.ServeMux, deps Dependencies)

var (
	registryMu sync.Mutex
	// routeRegistrars is the registration hook list. Core routes first; other
	// route families append themselves with Register (e.g. in an init func in
	// their own file) or are added here, in app.ts order.
	routeRegistrars = []Registrar{
		RegisterHealthRoutes,
		RegisterPublicAuthRoutes,
		RegisterSessionAuthRoutes,
		RegisterVaultListRoutes,
		RegisterVaultRoutes,
		RegisterTokenRoutes,
		// ---- other route families: add a line here or call Register in init() ----
		// RegisterObsidianCapabilityRoutes, RegisterObsidianSyncRoutes,
		// RegisterOAuthRoutes, RegisterSyncRoutes, RegisterWebEditRoutes,
		// RegisterChangesRoutes, RegisterFileRoutes, RegisterGraphRoutes, RegisterMcpRoutes
	}
)

// Register appends a route registrar. Safe to call from init functions.
func Register(r Registrar) {
	registryMu.Lock()
	defer registryMu.Unlock()
	routeRegistrars = append(routeRegistrars, r)
}

// NewApp builds the HTTP handler. Chain (outermost first), as in app.ts:
// request logging -> API-error handling -> /api/v1 auth (+CSRF) -> per-vault
// scope check -> routes. Unknown routes answer 404 "404 Not Found" (Hono).
// Extra registrars are applied after the registered ones.
func NewApp(deps Dependencies, extra ...Registrar) http.Handler {
	mux := http.NewServeMux()
	registryMu.Lock()
	regs := append(append([]Registrar(nil), routeRegistrars...), extra...)
	registryMu.Unlock()
	for _, reg := range regs {
		reg(mux, deps)
	}
	dispatch := httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		if _, pattern := mux.Handler(r); pattern == "" {
			w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
			w.WriteHeader(http.StatusNotFound)
			_, _ = w.Write([]byte("404 Not Found"))
			return nil
		}
		mux.ServeHTTP(w, r)
		return nil
	})
	chain := httpx.AuthMiddleware(deps, httpx.VaultScopeMiddleware(deps, dispatch))
	return httpx.RequestLogging(deps.IDs.Generate, deps.LogWriter, chain)
}

type scryptHasher struct{ auth.ScryptPasswordHasher }

func (h scryptHasher) Verify(password, hash string) (bool, error) {
	return h.ScryptPasswordHasher.Verify(password, hash), nil
}

// NewScryptHasher adapts internal/auth's scrypt hasher to core.PasswordHasher.
func NewScryptHasher() core.PasswordHasher { return scryptHasher{} }
