package api_test

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/auth"
	_ "github.com/championswimmer/tephra/tephra-server/go/internal/obsidian" // registers the obsidian-sync routes
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// route x principal matrix: every protected route must reject anonymous
// callers, cookie sessions without CSRF, foreign users and under-scoped
// tokens, exactly as the TS middleware chain does.
type matrixRoute struct {
	method, path string
	body         string
	// sessionOnly routes refuse API tokens (403).
	sessionOnly bool
	// tokenOnly routes refuse sessions (403).
	tokenOnly bool
	// needs is the scope a token must hold ("" = session-only / none).
	needs vm.ApiTokenScope
}

func TestRouteAuthMatrix(t *testing.T) {
	s := realFixture(t)
	ctx := context.Background()
	v := s.VaultID
	vp := "/api/v1/vaults/" + v
	// A second user with its own session, and read-only / foreign tokens.
	other := vm.User{ID: "u-other", Email: "other@example.com", CreatedAt: 1, UpdatedAt: 1}
	if err := s.DB.Users().Insert(ctx, other); err != nil {
		t.Fatal(err)
	}
	otherSession := "tps_other"
	if err := s.DB.Sessions().Insert(ctx, vm.Session{ID: auth.HashOpaqueToken(otherSession), UserID: other.ID, CreatedAt: 1, ExpiresAt: testutil.FixedNow + 1e9}); err != nil {
		t.Fatal(err)
	}
	mk := func(raw string, scopes ...vm.ApiTokenScope) {
		vid := v
		if err := s.DB.ApiTokens().Insert(ctx, vm.ApiToken{ID: "t-" + raw, UserID: matrixOwnerID(t, s), VaultID: &vid,
			TokenHash: auth.HashOpaqueToken(raw), Name: raw, Scopes: scopes, CreatedAt: 1}); err != nil {
			t.Fatal(err)
		}
	}
	mk("tpt_readonly", vm.ScopeVaultReadMetadata)
	mk("tpt_uploadonly", vm.ScopeVaultUpload)
	mk("tpt_writeonly", vm.ScopeVaultWrite)

	routes := []matrixRoute{
		{method: "GET", path: "/api/v1/auth/me", needs: ""},
		{method: "POST", path: "/api/v1/auth/logout", sessionOnly: true},
		{method: "GET", path: "/api/v1/vaults", sessionOnly: true},
		{method: "POST", path: "/api/v1/vaults", body: `{"name":"x"}`, sessionOnly: true},
		{method: "GET", path: vp, needs: vm.ScopeVaultReadMetadata},
		{method: "DELETE", path: vp, body: `{"confirmation":"Test Vault"}`, sessionOnly: true},
		{method: "GET", path: vp + "/tokens", sessionOnly: true},
		{method: "POST", path: vp + "/tokens", body: `{"name":"n"}`, sessionOnly: true},
		{method: "DELETE", path: vp + "/tokens/nope", sessionOnly: true},
		{method: "GET", path: vp + "/files", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/tree", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/search?q=a", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/resolve?path=a.md", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/files/f1", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/files/f1/content", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/files/f1/raw", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/attachments/f1", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/files/f1/rendered", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/files/f1/links", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/files/f1/backlinks", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/links", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/graph", needs: vm.ScopeVaultReadMetadata},
		{method: "GET", path: vp + "/changes?sinceRevision=0", needs: vm.ScopeVaultReadMetadata},
		{method: "POST", path: vp + "/sync/plan", body: string(emptyPlanBody()), needs: vm.ScopeVaultUpload},
		{method: "POST", path: vp + "/sync/commit", body: string(emptyPlanBody()), needs: vm.ScopeVaultUpload, tokenOnly: true},
		{method: "PUT", path: vp + "/blobs/" + sha("x"), body: "x", needs: vm.ScopeVaultUpload},
		{method: "PUT", path: vp + "/files/f1/content", body: "x", needs: vm.ScopeVaultWrite},
		{method: "GET", path: vp + "/obsidian-sync", sessionOnly: true},
		{method: "GET", path: vp + "/obsidian-sync/remotes", sessionOnly: true},
		{method: "POST", path: vp + "/obsidian-sync/login", body: `{}`, sessionOnly: true},
		{method: "POST", path: vp + "/obsidian-sync/setup", body: `{}`, sessionOnly: true},
		{method: "PUT", path: vp + "/obsidian-sync", body: `{}`, sessionOnly: true},
		{method: "GET", path: "/api/v1/obsidian-sync", sessionOnly: true},
		{method: "GET", path: "/api/v1/obsidian-sync/account", sessionOnly: true},
		{method: "POST", path: "/api/v1/obsidian-sync/account/login", body: `{}`, sessionOnly: true},
		{method: "GET", path: "/api/v1/oauth/client?client_id=a&redirect_uri=http://127.0.0.1/", sessionOnly: true},
		{method: "POST", path: "/api/v1/oauth/authorize", body: `{}`, sessionOnly: true},
		// Unknown /api/v1 routes are authenticated before they 404.
		{method: "GET", path: "/api/v1/does-not-exist"},
	}

	do := func(r matrixRoute, h testutil.Headers) testutil.Response {
		hh := testutil.Headers{}
		for k, val := range h {
			hh[k] = val
		}
		if r.body != "" && hh["content-type"] == "" {
			hh["content-type"] = "application/json"
		}
		var b []byte
		if r.body != "" {
			b = []byte(r.body)
		}
		if r.method == "PUT" && strings.Contains(r.path, "/blobs/") {
			hh["x-tephra-blob-size"] = "1"
		}
		if r.method == "PUT" && strings.Contains(r.path, "/content") {
			hh["x-tephra-content-size"] = "1"
			hh["if-match"] = sha("y")
		}
		return testutil.Do(s.App, r.method, r.path, hh, b)
	}
	status := func(name string, r matrixRoute, h testutil.Headers, want ...int) {
		t.Helper()
		got := do(r, h)
		for _, w := range want {
			if got.Status == w {
				return
			}
		}
		t.Errorf("%s %s %s: status %d, want %v (%s)", name, r.method, r.path, got.Status, want, got.Text())
	}
	cookieNoCSRF := testutil.Headers{"cookie": s.BrowserHeaders["cookie"]}
	for _, r := range routes {
		// Anonymous: always 401.
		status("anonymous", r, testutil.Headers{}, 401)
		status("bad bearer", r, testutil.Bearer("tpt_nope"), 401)
		status("bad cookie", r, testutil.Headers{"cookie": "tephra_session=nope"}, 401)
		if r.method != "GET" {
			// Cookie session without a CSRF header must be refused before the handler.
			status("cookie no csrf", r, cookieNoCSRF, 403)
			status("cookie wrong csrf", r, testutil.Headers{"cookie": s.BrowserHeaders["cookie"], "x-tephra-csrf": "wrong"}, 403)
		}
		if strings.Contains(r.path, "/vaults/"+v) {
			// Foreign user's session never reaches the owner's vault.
			status("foreign session", r, testutil.Headers{"authorization": "Bearer " + otherSession}, 403)
			if r.method == "GET" || r.method == "HEAD" {
				status("foreign cookie", r, testutil.Headers{"cookie": "tephra_session=" + otherSession}, 403)
			}
		}
		if r.sessionOnly {
			status("token on session route", r, testutil.Bearer(s.Token), 403)
			status("readonly token on session route", r, testutil.Bearer("tpt_readonly"), 403)
		}
		if r.needs != "" {
			for _, c := range []struct {
				raw    string
				scope  vm.ApiTokenScope
				denied bool
			}{
				{"tpt_readonly", vm.ScopeVaultReadMetadata, false}, {"tpt_uploadonly", vm.ScopeVaultUpload, false}, {"tpt_writeonly", vm.ScopeVaultWrite, false},
			} {
				got := do(r, testutil.Bearer(c.raw))
				if c.scope != r.needs && got.Status != 403 {
					t.Errorf("token %s on %s %s: status %d, want 403 (%s)", c.raw, r.method, r.path, got.Status, got.Text())
				}
				if c.scope == r.needs && got.Status == 403 && !strings.Contains(got.Text(), "Tephra sync") {
					t.Errorf("token %s with the right scope on %s %s refused: %s", c.raw, r.method, r.path, got.Text())
				}
			}
		}
		if r.tokenOnly {
			status("session on token-only route", r, s.BrowserHeaders, 403)
		}
	}
	// Public routes stay public, and nothing else is.
	for _, p := range []string{"/healthz", "/readyz", "/api/v1/auth/bootstrap/status"} {
		if got := testutil.Do(s.App, "GET", p, nil, nil); got.Status != 200 {
			t.Errorf("GET %s: %d", p, got.Status)
		}
	}
	// MCP refuses cookies and anonymous callers (no CSRF surface).
	for name, h := range map[string]testutil.Headers{"anon": {}, "cookie": s.BrowserHeaders, "bad bearer": testutil.Bearer("nope")} {
		got := testutil.DoJSON(s.App, "POST", "/mcp", withJSON(h), `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
		if got.Status != 401 || got.Header.Get("WWW-Authenticate") == "" {
			t.Errorf("mcp %s: %d %v", name, got.Status, got.Header)
		}
	}
}

func matrixOwnerID(t *testing.T, s *testutil.Session) string {
	t.Helper()
	u, err := s.DB.Users().FindByEmail(context.Background(), "owner@example.com")
	if err != nil || u == nil {
		t.Fatalf("owner: %v %v", u, err)
	}
	return u.ID
}

// Path tricks must not downgrade an authenticated /api/v1 route to a public one.
func TestAPIPathNormalisationCannotBypassAuth(t *testing.T) {
	s := realFixture(t)
	for _, p := range []string{
		"/api/v1/vaults", "/api/v1//vaults", "/api/v1/auth/../vaults", "/api/v1/auth/login/../../vaults",
		"/API/V1/vaults", "/api/v1/vaults/", "/api%2Fv1/vaults", "/api/v1/%76aults", "/api/v1/vaults/%2e%2e/vaults",
		"/api/v1/auth/bootstrap/status/../../vaults", "/api/v1/vaults;x", "/api/v1/vaults%00",
	} {
		got := testutil.Do(s.App, "GET", p, nil, nil)
		if got.Status == 200 && strings.Contains(got.Text(), `"vaults"`) {
			t.Errorf("GET %s leaked: %s", p, got.Text())
		}
		if strings.Contains(got.Text(), "Test Vault") {
			t.Errorf("GET %s leaked: %s", p, got.Text())
		}
	}
}

// Two uploads of the same new blob racing each other must both succeed (one
// stores, the other sees it) instead of failing on the blobs primary key.
func TestConcurrentIdenticalBlobUploadsBothSucceed(t *testing.T) {
	s := realFixture(t)
	content := strings.Repeat("racing blob ", 1000)
	for round := 0; round < 5; round++ {
		c := content + string(rune('a'+round))
		var wg sync.WaitGroup
		results := make([]testutil.Response, 8)
		for i := range results {
			wg.Add(1)
			go func() {
				defer wg.Done()
				results[i] = putBlob(t, s, s.Token, s.VaultID, c, "text/markdown")
			}()
		}
		wg.Wait()
		stored := 0
		for i, r := range results {
			if r.Status != 200 {
				t.Fatalf("round %d upload %d: %d %s", round, i, r.Status, r.Text())
			}
			if strings.Contains(r.Text(), `"stored":true`) {
				stored++
			}
		}
		if stored != 1 {
			t.Fatalf("round %d: %d uploads reported stored:true, want exactly 1", round, stored)
		}
	}
}

type panickingIndexer struct{ called chan struct{} }

func (p panickingIndexer) IndexVault(context.Context, string, int64) error {
	defer close(p.called)
	panic("indexer exploded")
}

// The index runs in a background goroutine after a commit; a panic there must
// not crash the whole server process.
func TestPanickingIndexerDoesNotCrashTheServer(t *testing.T) {
	idx := panickingIndexer{called: make(chan struct{})}
	s := testutil.Setup(t, newApp, testutil.WithIndexService(idx))
	commitSeeds(t, s, []seed{{fileID: "f1", path: "A.md", content: "# A"}}, commitOpts{})
	select {
	case <-idx.called:
	case <-time.After(5 * time.Second):
		t.Fatal("indexer was never invoked")
	}
	time.Sleep(50 * time.Millisecond) // a leaked panic would abort the test binary here
}
