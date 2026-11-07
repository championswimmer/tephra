package api

import (
	"net/http"
	"strconv"

	"github.com/championswimmer/tephra/tephra-server/go/internal/auth"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

const sessionAgeMs int64 = 30 * 24 * 60 * 60 * 1000

type userDTO struct {
	ID    string `json:"id"`
	Email string `json:"email"`
}

type credentials struct{ email, password string }

func parseCredentials(body any, bootstrap bool) (credentials, string, error) {
	var s httpx.Schema
	allowed := []string{"email", "password"}
	if bootstrap {
		allowed = append(allowed, "token", "bootstrapToken")
	}
	m := s.StrictObject(body, allowed...)
	if m == nil {
		return credentials{}, "", s.Err()
	}
	c := credentials{email: s.Email(m, "email", 320)}
	c.password, _ = s.String(m, "password", true, false, 10, 1024)
	var token string
	if bootstrap {
		t, hasT := s.String(m, "token", false, false, 1, 1024)
		b, hasB := s.String(m, "bootstrapToken", false, false, 1, 1024)
		switch {
		case hasT:
			token = t
		case hasB:
			token = b
		}
		token = jstext.Trim(token)
		if s.Err() == nil && len(token) == 0 {
			s.Add("token", "Bootstrap token is required.")
		}
	}
	return c, token, s.Err()
}

// RegisterPublicAuthRoutes registers the unauthenticated bootstrap status,
// bootstrap and login endpoints.
func RegisterPublicAuthRoutes(mux *http.ServeMux, d Dependencies) {
	mux.Handle("GET /api/v1/auth/bootstrap/status", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		n, err := d.Database.Users().Count(r.Context())
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]bool{"required": n == 0})
		return nil
	}))

	mux.Handle("POST /api/v1/auth/bootstrap", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		raw, err := httpx.JSONBody(r)
		if err != nil {
			return err
		}
		creds, token, err := parseCredentials(raw, true)
		if err != nil {
			return err
		}
		ctx := r.Context()
		done := httpx.Fail(http.StatusConflict, protocol.CodeCommitFailed, "Bootstrap has already completed.")
		n, err := d.Database.Users().Count(ctx)
		if err != nil {
			return err
		}
		if n != 0 {
			return done
		}
		if d.BootstrapToken == "" || !auth.ConstantTimeSecretEqual(token, d.BootstrapToken) {
			return httpx.Fail(http.StatusUnauthorized, protocol.CodeAuthRequired, "Invalid bootstrap token.")
		}
		created, err := db.InTransaction(ctx, d.Database, func(repos db.TransactionRepositories) (vm.User, error) {
			n, err := repos.Users().Count(ctx)
			if err != nil {
				return vm.User{}, err
			}
			if n != 0 {
				return vm.User{}, done
			}
			now := d.Clock.Now()
			hash, err := d.PasswordHasher.Hash(creds.password)
			if err != nil {
				return vm.User{}, err
			}
			u := vm.User{ID: d.IDs.Generate(), Email: jstext.Lower(creds.email), PasswordHash: &hash, CreatedAt: now, UpdatedAt: now}
			return u, repos.Users().Insert(ctx, u)
		})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusCreated, map[string]userDTO{"user": {ID: created.ID, Email: created.Email}})
		return nil
	}))

	mux.Handle("POST /api/v1/auth/login", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		raw, err := httpx.JSONBody(r)
		if err != nil {
			return err
		}
		creds, _, err := parseCredentials(raw, false)
		if err != nil {
			return err
		}
		ctx := r.Context()
		user, err := d.Database.Users().FindByEmail(ctx, jstext.Lower(creds.email))
		if err != nil {
			return err
		}
		var comparison string
		if user != nil && user.PasswordHash != nil {
			comparison = *user.PasswordHash
		} else if comparison, err = d.PasswordHasher.Hash("invalid-login-placeholder"); err != nil {
			return err
		}
		valid, err := d.PasswordHasher.Verify(creds.password, comparison)
		if err != nil {
			return err
		}
		if user == nil || user.PasswordHash == nil || *user.PasswordHash == "" || !valid {
			return httpx.Fail(http.StatusUnauthorized, protocol.CodeAuthRequired, "Invalid email or password.")
		}
		rawSession, err := auth.CreateOpaqueToken("tps")
		if err != nil {
			return err
		}
		csrf, err := auth.CreateOpaqueToken("tpc")
		if err != nil {
			return err
		}
		now := d.Clock.Now()
		if err := d.Database.Sessions().Insert(ctx, vm.Session{
			ID: auth.HashOpaqueToken(rawSession), UserID: user.ID, CreatedAt: now, ExpiresAt: now + sessionAgeMs,
		}); err != nil {
			return err
		}
		maxAge := int(sessionAgeMs / 1000)
		h := w.Header()
		h.Add("Set-Cookie", auth.SessionCookie(rawSession, auth.SessionCookieOptions{
			Insecure: !d.SecureCookies, Name: d.SessionCookieName, MaxAgeSeconds: &maxAge,
		}))
		csrfCookie := "tephra_csrf=" + csrf + "; Path=/; SameSite=Lax"
		if d.SecureCookies {
			csrfCookie += "; Secure"
		}
		h.Add("Set-Cookie", csrfCookie+"; Max-Age="+strconv.Itoa(maxAge))
		httpx.WriteJSON(w, http.StatusOK, struct {
			User         userDTO `json:"user"`
			SessionToken string  `json:"sessionToken"`
			CSRFToken    string  `json:"csrfToken"`
		}{userDTO{ID: user.ID, Email: user.Email}, rawSession, csrf})
		return nil
	}))
}

// RegisterSessionAuthRoutes registers logout and "me" (behind the auth middleware).
func RegisterSessionAuthRoutes(mux *http.ServeMux, d Dependencies) {
	mux.Handle("POST /api/v1/auth/logout", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		p, err := httpx.RequireSession(r)
		if err != nil {
			return err
		}
		if err := d.Database.Sessions().Delete(r.Context(), p.Session.ID); err != nil {
			return err
		}
		w.Header().Add("Set-Cookie", auth.ClearSessionCookie(auth.SessionCookieOptions{
			Insecure: !d.SecureCookies, Name: d.SessionCookieName,
		}))
		httpx.WriteJSON(w, http.StatusOK, map[string]bool{"ok": true})
		return nil
	}))
	mux.Handle("GET /api/v1/auth/me", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		p := httpx.PrincipalFrom(r)
		if p == nil {
			return httpx.Fail(http.StatusUnauthorized, protocol.CodeAuthRequired, "Authentication is required.")
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]userDTO{"user": {ID: p.User.ID, Email: p.User.Email}})
		return nil
	}))
}
