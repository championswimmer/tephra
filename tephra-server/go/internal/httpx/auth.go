package httpx

import (
	"context"
	"net/http"
	"net/url"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/auth"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// PrincipalKind distinguishes cookie/bearer sessions from API tokens.
type PrincipalKind string

const (
	PrincipalSession PrincipalKind = "session"
	PrincipalToken   PrincipalKind = "token"
)

// Principal is the authenticated caller (TS AuthPrincipal). Session is set for
// PrincipalSession, Token for PrincipalToken.
type Principal struct {
	Kind    PrincipalKind
	User    vm.User
	Session *vm.Session
	Token   *vm.ApiToken
}

// WithPrincipal stores p in the request context (used by the auth middleware
// and by tests that call handlers directly).
func WithPrincipal(r *http.Request, p *Principal) *http.Request {
	return r.WithContext(context.WithValue(r.Context(), keyPrincipal, p))
}

// PrincipalFrom returns the authenticated principal or nil (public routes).
func PrincipalFrom(r *http.Request) *Principal {
	p, _ := r.Context().Value(keyPrincipal).(*Principal)
	return p
}

// TokenIsActive reports whether the token is neither revoked nor expired.
func TokenIsActive(t *vm.ApiToken, now int64) bool {
	return t.RevokedAt == nil && (t.ExpiresAt == nil || *t.ExpiresAt > now)
}

// CanAccessVault: sessions own their vaults; tokens are bound to one vault and
// need the scope.
func CanAccessVault(p *Principal, v *vm.Vault, scope vm.ApiTokenScope) bool {
	if p.Kind == PrincipalSession {
		return p.User.ID == v.OwnerUserID
	}
	if p.User.ID != v.OwnerUserID || p.Token.VaultID == nil || *p.Token.VaultID != v.ID {
		return false
	}
	for _, s := range p.Token.Scopes {
		if s == scope {
			return true
		}
	}
	return false
}

var errAuthRequired = func() *ApiFailure {
	return Fail(http.StatusUnauthorized, protocol.CodeAuthRequired, "Authentication is required.")
}

// Bearer returns the raw bearer value and whether a "Bearer " header exists.
func Bearer(r *http.Request) (string, bool) {
	v := r.Header.Get("Authorization")
	if strings.HasPrefix(v, "Bearer ") {
		return v[7:], true
	}
	return "", false
}

func cookieHeader(r *http.Request) string { return strings.Join(r.Header.Values("Cookie"), "; ") }

// Authenticate resolves the principal from a bearer API token, a bearer
// session token or the session cookie, exactly like http/auth.ts.
func Authenticate(r *http.Request, d Dependencies) (*Principal, error) {
	ctx := r.Context()
	if raw, ok := Bearer(r); ok {
		hash := auth.HashOpaqueToken(raw)
		token, err := d.Database.ApiTokens().FindByTokenHash(ctx, hash)
		if err != nil {
			return nil, err
		}
		if token != nil {
			if !TokenIsActive(token, d.Clock.Now()) {
				return nil, Fail(http.StatusUnauthorized, protocol.CodeTokenRevoked, "Token is revoked or expired.")
			}
			user, err := d.Database.Users().FindByID(ctx, token.UserID)
			if err != nil {
				return nil, err
			}
			if user == nil {
				return nil, errAuthRequired()
			}
			return &Principal{Kind: PrincipalToken, Token: token, User: *user}, nil
		}
		session, err := d.Database.Sessions().FindByID(ctx, hash)
		if err != nil {
			return nil, err
		}
		if session != nil {
			return sessionPrincipal(ctx, d, session)
		}
		return nil, errAuthRequired()
	}
	rawSession := auth.ParseCookies(cookieHeader(r))[d.CookieName()]
	if rawSession == "" {
		return nil, errAuthRequired()
	}
	session, err := d.Database.Sessions().FindByID(ctx, auth.HashOpaqueToken(rawSession))
	if err != nil {
		return nil, err
	}
	if session == nil {
		return nil, errAuthRequired()
	}
	return sessionPrincipal(ctx, d, session)
}

func sessionPrincipal(ctx context.Context, d Dependencies, s *vm.Session) (*Principal, error) {
	if s.ExpiresAt <= d.Clock.Now() {
		return nil, errAuthRequired()
	}
	user, err := d.Database.Users().FindByID(ctx, s.UserID)
	if err != nil {
		return nil, err
	}
	if user == nil {
		return nil, errAuthRequired()
	}
	return &Principal{Kind: PrincipalSession, Session: s, User: *user}, nil
}

// RequireSession returns the principal when it is a browser/bearer session, else 403.
func RequireSession(r *http.Request) (*Principal, error) {
	p := PrincipalFrom(r)
	if p == nil {
		return nil, errAuthRequired()
	}
	if p.Kind != PrincipalSession {
		return nil, Fail(http.StatusForbidden, protocol.CodeVaultAccessDenied, "A browser session is required.")
	}
	return p, nil
}

// FindVaultByIDOrName resolves the `:vaultId` segment: an id always wins over a name.
func FindVaultByIDOrName(ctx context.Context, vaults interface {
	FindByID(ctx context.Context, id string) (*vm.Vault, error)
	FindByName(ctx context.Context, name string) (*vm.Vault, error)
}, idOrName string) (*vm.Vault, error) {
	v, err := vaults.FindByID(ctx, idOrName)
	if err != nil || v != nil {
		return v, err
	}
	return vaults.FindByName(ctx, idOrName)
}

type ctxVaultKey struct{}

// VaultIDParam returns the decoded `{vaultId}` path segment of the request.
func VaultIDParam(r *http.Request) string {
	if v := r.PathValue("vaultId"); v != "" {
		return v
	}
	if v, ok := r.Context().Value(ctxVaultKey{}).(string); ok {
		return v
	}
	id, _, _ := splitVaultPath(r.URL.EscapedPath())
	return id
}

// OwnedVault loads the vault addressed by `{vaultId}` and checks that the
// principal may use it with the given scope (404 VAULT_NOT_FOUND / 403
// VAULT_ACCESS_DENIED).
func OwnedVault(r *http.Request, d Dependencies, scope vm.ApiTokenScope) (*vm.Vault, error) {
	p := PrincipalFrom(r)
	if p == nil {
		return nil, errAuthRequired()
	}
	id := VaultIDParam(r)
	if id == "" {
		return nil, Validation("Too small: expected string to have >=1 characters")
	}
	vault, err := FindVaultByIDOrName(r.Context(), d.Database.Vaults(), id)
	if err != nil {
		return nil, err
	}
	if vault == nil {
		return nil, Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "Vault was not found.")
	}
	if !CanAccessVault(p, vault, scope) {
		return nil, Fail(http.StatusForbidden, protocol.CodeVaultAccessDenied, "Access to this vault is denied.")
	}
	return vault, nil
}

// publicPaths are reachable without authentication.
var publicPaths = map[string]bool{
	"/api/v1/auth/bootstrap":        true,
	"/api/v1/auth/login":            true,
	"/api/v1/auth/bootstrap/status": true,
}

func isAPIPath(p string) bool { return p == "/api/v1" || strings.HasPrefix(p, "/api/v1/") }

// AuthMiddleware authenticates every /api/v1/* request except the public auth
// endpoints and enforces CSRF for cookie sessions.
func AuthMiddleware(d Dependencies, next http.Handler) http.Handler {
	return Handle(func(w http.ResponseWriter, r *http.Request) error {
		path := r.URL.Path
		if !isAPIPath(path) || publicPaths[path] {
			next.ServeHTTP(w, r)
			return nil
		}
		p, err := Authenticate(r, d)
		if err != nil {
			return err
		}
		r = WithPrincipal(r, p)
		_, hasBearer := Bearer(r)
		if p.Kind == PrincipalSession && !hasBearer {
			switch r.Method {
			case http.MethodGet, http.MethodHead, http.MethodOptions:
			default:
				csrfCookie := auth.ParseCookies(cookieHeader(r))["tephra_csrf"]
				csrfHeader, ok := headerValue(r, "X-Tephra-Csrf")
				if !ok {
					csrfHeader, _ = headerValue(r, "X-Csrf-Token")
				}
				if csrfCookie == "" || csrfHeader == "" || !auth.ConstantTimeSecretEqual(csrfCookie, csrfHeader) {
					return Fail(http.StatusForbidden, protocol.CodeVaultAccessDenied, "CSRF validation failed.")
				}
			}
		}
		next.ServeHTTP(w, r)
		return nil
	})
}

func headerValue(r *http.Request, name string) (string, bool) {
	vs := r.Header.Values(name)
	if len(vs) == 0 {
		return "", false
	}
	return strings.Join(vs, ", "), true
}

// splitVaultPath parses /api/v1/vaults/{id}[/rest] from an escaped path.
// ok is false when the path is not under a vault.
func splitVaultPath(escaped string) (id, rest string, ok bool) {
	const prefix = "/api/v1/vaults/"
	if !strings.HasPrefix(escaped, prefix) {
		return "", "", false
	}
	tail := escaped[len(prefix):]
	seg, rest, _ := strings.Cut(tail, "/")
	if seg == "" {
		return "", "", false
	}
	dec, err := url.PathUnescape(seg)
	if err != nil {
		dec = seg
	}
	return dec, rest, true
}

// VaultScopeMiddleware performs the per-vault access check for everything
// under /api/v1/vaults/{vaultId}. Operations are matched relative to the vault
// so a vault named "sync" or "blobs" cannot change the scope or sync policy.
func VaultScopeMiddleware(d Dependencies, next http.Handler) http.Handler {
	return Handle(func(w http.ResponseWriter, r *http.Request) error {
		id, rest, ok := splitVaultPath(r.URL.EscapedPath())
		if !ok {
			next.ServeHTTP(w, r)
			return nil
		}
		isDirectSync := (r.Method == http.MethodPost && (rest == "sync/plan" || rest == "sync/commit")) ||
			(r.Method == http.MethodPut && isBlobPath(rest))
		scope := vm.ScopeVaultReadMetadata
		if isDirectSync {
			scope = vm.ScopeVaultUpload
		} else if r.Method == http.MethodPut && isContentPath(rest) {
			scope = vm.ScopeVaultWrite
		}
		r = r.WithContext(context.WithValue(r.Context(), ctxVaultKey{}, id))
		vault, err := OwnedVault(r, d, scope)
		if err != nil {
			return err
		}
		if isDirectSync {
			if err := RequireTephraSync(*vault); err != nil {
				return err
			}
		}
		next.ServeHTTP(w, r)
		return nil
	})
}

// ^blobs/[^/]+$
func isBlobPath(rest string) bool {
	h, ok := strings.CutPrefix(rest, "blobs/")
	return ok && h != "" && !strings.Contains(h, "/")
}

// ^files/[^/]+/content$
func isContentPath(rest string) bool {
	m, ok := strings.CutPrefix(rest, "files/")
	if !ok {
		return false
	}
	f, ok := strings.CutSuffix(m, "/content")
	return ok && f != "" && !strings.Contains(f, "/")
}
