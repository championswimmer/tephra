package api_test

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/api"
	"github.com/championswimmer/tephra/tephra-server/go/internal/auth"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func newApp(d httpx.Dependencies) http.Handler { return api.NewApp(d) }

var js = testutil.Headers{"content-type": "application/json"}

func decode[T any](t *testing.T, r testutil.Response) T {
	t.Helper()
	var v T
	testutil.JSON(t, r, &v)
	return v
}

type errBody struct {
	Error struct{ Code, Message string } `json:"error"`
}

func wantErr(t *testing.T, r testutil.Response, status int, code, msg string) {
	t.Helper()
	if r.Status != status {
		t.Fatalf("status = %d want %d (%s)", r.Status, status, r.Text())
	}
	e := decode[errBody](t, r)
	if e.Error.Code != code || (msg != "" && e.Error.Message != msg) {
		t.Fatalf("error = %+v want %s %q", e.Error, code, msg)
	}
}

func TestBootstrapsOnceAuthenticatesAndKeepsTokensVaultScoped(t *testing.T) {
	s := testutil.Setup(t, newApp)
	other := testutil.DoJSON(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, `{"name":"Other"}`)
	v := decode[struct{ Vault vm.Vault }](t, other).Vault
	denied := testutil.Do(s.App, "GET", "/api/v1/vaults/"+v.ID+"/files", testutil.Bearer(s.Token), nil)
	wantErr(t, denied, 403, "VAULT_ACCESS_DENIED", "Access to this vault is denied.")
}

func TestRejectsDuplicateVaultNamesValidatesNamesAndResolvesByName(t *testing.T) {
	s := testutil.Setup(t, newApp)
	dup := testutil.DoJSON(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, `{"name":"Test Vault"}`)
	wantErr(t, dup, 409, "VAULT_NAME_TAKEN", "A vault with this name already exists.")
	if r := testutil.DoJSON(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, `{"name":"test vault"}`); r.Status != 201 {
		t.Fatalf("case variant: %d", r.Status)
	}
	for _, bad := range []string{`{"name":"a/b"}`, `{"name":"a\\b"}`, `{"name":"."}`, `{"name":".."}`, `{"name":"a\u0001b"}`,
		`{"name":"   "}`, `{"name":""}`, `{"name":"x","extra":1}`, `{"name":5}`, `{"name":"x","syncMode":"nope"}`, `[]`, `null`} {
		r := testutil.DoJSON(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, bad)
		wantErr(t, r, 400, "INVALID_MANIFEST", "")
	}
	if r := testutil.DoJSON(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, `{"name":"  padded  "}`); r.Status != 201 ||
		decode[struct{ Vault vm.Vault }](t, r).Vault.Name != "padded" {
		t.Fatalf("trim: %s", r.Text())
	}

	byName := testutil.Do(s.App, "GET", "/api/v1/vaults/"+url.PathEscape(s.VaultName), s.BrowserHeaders, nil)
	if byName.Status != 200 {
		t.Fatalf("by name: %d %s", byName.Status, byName.Text())
	}
	var got map[string]map[string]any
	_ = json.Unmarshal(byName.Body, &got)
	if got["vault"]["id"] != s.VaultID || got["vault"]["name"] != "Test Vault" || got["vault"]["syncMode"] != "tephra" {
		t.Fatalf("vault = %v", got)
	}
	if r := testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID, s.BrowserHeaders, nil); r.Status != 200 {
		t.Fatalf("by id: %d", r.Status)
	}
	if r := testutil.Do(s.App, "GET", "/api/v1/vaults/"+url.PathEscape(s.VaultName)+"/files", s.BrowserHeaders, nil); r.Status != 200 {
		t.Fatalf("files by name: %d", r.Status)
	}
	wantErr(t, testutil.Do(s.App, "GET", "/api/v1/vaults/nope", s.BrowserHeaders, nil), 404, "VAULT_NOT_FOUND", "Vault was not found.")
}

func TestDeletesVaultsOnlyAfterExactNameConfirmation(t *testing.T) {
	s := testutil.Setup(t, newApp)
	p := "/api/v1/vaults/" + s.VaultID
	wantErr(t, testutil.DoJSON(s.App, "DELETE", p, s.BrowserHeaders, `{"confirmation":"test vault"}`), 400, "VAULT_NAME_MISMATCH", "Vault name confirmation does not match.")
	if v, _ := s.DB.Vaults().FindByID(context.Background(), s.VaultID); v == nil || v.Name != "Test Vault" {
		t.Fatal("vault should still exist")
	}
	// Missing / non-JSON body is rejected before anything is deleted.
	wantErr(t, testutil.Do(s.App, "DELETE", p, s.BrowserHeaders, nil), 400, "INVALID_MANIFEST", "Request body must be valid JSON.")
	// A token principal cannot delete (session required) even with a valid body.
	wantErr(t, testutil.DoJSON(s.App, "DELETE", p, testutil.Headers{"authorization": "Bearer " + s.Token, "content-type": "application/json"}, `{"confirmation":"Test Vault"}`), 403, "VAULT_ACCESS_DENIED", "A browser session is required.")
	if r := testutil.DoJSON(s.App, "DELETE", p, s.BrowserHeaders, `{"confirmation":"Test Vault"}`); r.Status != 204 || len(r.Body) != 0 {
		t.Fatalf("delete: %d %q", r.Status, r.Text())
	}
	if v, _ := s.DB.Vaults().FindByID(context.Background(), s.VaultID); v != nil {
		t.Fatal("vault should be gone")
	}
	if toks, _ := s.DB.ApiTokens().ListByVault(context.Background(), s.VaultID); len(toks) != 0 {
		t.Fatal("tokens should cascade")
	}
}

func TestCreatesTokensByVaultNameAndScopeEnforcement(t *testing.T) {
	s := testutil.Setup(t, newApp)
	created := testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+url.PathEscape(s.VaultName)+"/tokens", s.BrowserHeaders, `{"name":"Plugin by name"}`)
	if created.Status != 201 {
		t.Fatalf("create: %d %s", created.Status, created.Text())
	}
	body := decode[struct {
		Token struct {
			ID, Name  string
			Scopes    []string
			ExpiresAt *int64
		}
		Value string
	}](t, created)
	if !strings.HasPrefix(body.Value, "tpt_") || body.Token.Name != "Plugin by name" ||
		strings.Join(body.Token.Scopes, ",") != "vault:read-metadata,vault:upload" || body.Token.ExpiresAt != nil {
		t.Fatalf("body = %+v", body)
	}
	if !strings.Contains(created.Text(), `"expiresAt":null`) {
		t.Fatalf("expiresAt must be null: %s", created.Text())
	}
	// Direct-sync path (upload scope) is allowed by name, read-metadata endpoint too.
	b := testutil.Bearer(body.Value)
	if r := testutil.Do(s.App, "POST", "/api/v1/vaults/"+url.PathEscape(s.VaultName)+"/sync/plan", withJSON(b), emptyPlanBody()); r.Status != 200 {
		t.Fatalf("sync plan by name: %d %s", r.Status, r.Text())
	}
	// A read-only token cannot hit upload paths; an upload-only one cannot read.
	ro := decode[struct{ Value string }](t, testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/tokens", s.BrowserHeaders, `{"name":"ro","scopes":["vault:read-metadata"]}`)).Value
	wantErr(t, testutil.Do(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/sync/plan", testutil.Bearer(ro), nil), 403, "VAULT_ACCESS_DENIED", "")
	wantErr(t, testutil.Do(s.App, "PUT", "/api/v1/vaults/"+s.VaultID+"/blobs/abc", testutil.Bearer(ro), nil), 403, "VAULT_ACCESS_DENIED", "")
	if r := testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID+"/files", testutil.Bearer(ro), nil); r.Status != 200 {
		t.Fatalf("ro read: %d", r.Status)
	}
	// vault:write is required for the web content write endpoint only.
	wantErr(t, testutil.Do(s.App, "PUT", "/api/v1/vaults/"+s.VaultID+"/files/f1/content", b, nil), 403, "VAULT_ACCESS_DENIED", "")
	wr := decode[struct{ Value string }](t, testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/tokens", s.BrowserHeaders, `{"name":"w","scopes":["vault:write"]}`)).Value
	// The scope check passes; the (unknown) file is then reported as missing.
	wantErr(t, testutil.Do(s.App, "PUT", "/api/v1/vaults/"+s.VaultID+"/files/f1/content", testutil.Bearer(wr), nil), 404, "VAULT_NOT_FOUND", "File was not found.")
	// Vaults named like operations don't change scope selection ("sync" / "blobs" in the vault segment).
	// Token validation and revoke.
	for _, bad := range []string{`{"name":"x","scopes":[]}`, `{"name":"x","scopes":["vault:admin"]}`, `{"name":"x","scopes":["vault:upload","vault:write","vault:read-metadata","vault:upload"]}`,
		`{"name":"x","expiresAt":1.5}`, `{"name":"x","expiresAt":0}`, `{"name":"x","expiresAt":"1"}`, `{"name":"x","bogus":1}`, `{"name":" "}`, `{"name":"x","deviceId":""}`, `{"name":"x","platform":null}`} {
		wantErr(t, testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/tokens", s.BrowserHeaders, bad), 400, "INVALID_MANIFEST", "")
	}
	exp := testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/tokens", s.BrowserHeaders, `{"name":"exp","expiresAt":1700000000001}`)
	expTok := decode[struct{ Value string }](t, exp).Value
	if r := testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID+"/files", testutil.Bearer(expTok), nil); r.Status != 200 {
		t.Fatalf("not yet expired: %d", r.Status)
	}
	s.Clock.Advance(2)
	wantErr(t, testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID+"/files", testutil.Bearer(expTok), nil), 401, "TOKEN_REVOKED", "Token is revoked or expired.")

	list := testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID+"/tokens", s.BrowserHeaders, nil)
	if strings.Contains(list.Text(), "tokenHash") || !strings.Contains(list.Text(), `"revokedAt":null`) {
		t.Fatalf("list: %s", list.Text())
	}
	id := ""
	for _, tk := range decode[struct{ Tokens []struct{ ID, Name string } }](t, list).Tokens {
		if tk.Name == "Plugin" {
			id = tk.ID
		}
	}
	if r := testutil.Do(s.App, "DELETE", "/api/v1/vaults/"+s.VaultID+"/tokens/"+id, s.BrowserHeaders, nil); r.Status != 204 {
		t.Fatalf("revoke: %d", r.Status)
	}
	wantErr(t, testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID+"/files", testutil.Bearer(s.Token), nil), 401, "TOKEN_REVOKED", "")
	wantErr(t, testutil.Do(s.App, "DELETE", "/api/v1/vaults/"+s.VaultID+"/tokens/nope", s.BrowserHeaders, nil), 404, "VAULT_NOT_FOUND", "Token was not found.")
	// A token cannot manage tokens.
	wantErr(t, testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID+"/tokens", b, nil), 403, "VAULT_ACCESS_DENIED", "A browser session is required.")
}

func TestBearerAuthenticatedSessionsNeedNoCSRF(t *testing.T) {
	f := testutil.NewFixture(t)
	app := newApp(f.Deps)
	testutil.DoJSON(app, "POST", "/api/v1/auth/bootstrap", js, `{"token":"bootstrap-secret","email":"owner@example.com","password":"password-123"}`)
	login := testutil.DoJSON(app, "POST", "/api/v1/auth/login", js, `{"email":"Owner@Example.com","password":"password-123"}`)
	if login.Status != 200 {
		t.Fatalf("login: %d %s", login.Status, login.Text())
	}
	lb := decode[struct {
		SessionToken string
		User         struct{ ID, Email string }
	}](t, login)
	if !strings.HasPrefix(lb.SessionToken, "tps_") || lb.User.Email != "owner@example.com" {
		t.Fatalf("login body: %+v", lb)
	}
	h := testutil.Headers{"authorization": "Bearer " + lb.SessionToken, "content-type": "application/json"}
	me := testutil.Do(app, "GET", "/api/v1/auth/me", h, nil)
	if me.Status != 200 || decode[struct{ User struct{ ID, Email string } }](t, me).User != lb.User {
		t.Fatalf("me: %s", me.Text())
	}
	if r := testutil.Do(app, "GET", "/api/v1/vaults", h, nil); r.Status != 200 || r.Text() != `{"vaults":[]}` {
		t.Fatalf("vaults: %s", r.Text())
	}
	cv := testutil.DoJSON(app, "POST", "/api/v1/vaults", h, `{"name":"Obsidian Cloud Vault"}`)
	if cv.Status != 201 {
		t.Fatalf("create vault: %d %s", cv.Status, cv.Text())
	}
	vid := decode[struct{ Vault vm.Vault }](t, cv).Vault.ID
	ct := testutil.DoJSON(app, "POST", "/api/v1/vaults/"+vid+"/tokens", h, `{"name":"Obsidian Plugin (MacBook Pro)","deviceName":"MacBook Pro","platform":"obsidian-plugin"}`)
	if ct.Status != 201 || !strings.Contains(ct.Text(), `"value":"tpt_`) {
		t.Fatalf("create token: %d %s", ct.Status, ct.Text())
	}
	logout := testutil.Do(app, "POST", "/api/v1/auth/logout", h, nil)
	if logout.Status != 200 || logout.Text() != `{"ok":true}` {
		t.Fatalf("logout: %d %s", logout.Status, logout.Text())
	}
	if sc := logout.Header.Get("Set-Cookie"); !strings.Contains(sc, "tephra_session=;") || !strings.Contains(sc, "Max-Age=0") {
		t.Fatalf("clear cookie: %q", sc)
	}
	wantErr(t, testutil.Do(app, "GET", "/api/v1/vaults", h, nil), 401, "AUTH_REQUIRED", "Authentication is required.")
}

func TestValidatesCSRFHeaders(t *testing.T) {
	f := testutil.NewFixture(t)
	app := newApp(f.Deps)
	testutil.DoJSON(app, "POST", "/api/v1/auth/bootstrap", js, `{"token":"bootstrap-secret","email":"csrf-test@example.com","password":"password-123"}`)
	login := testutil.DoJSON(app, "POST", "/api/v1/auth/login", js, `{"email":"csrf-test@example.com","password":"password-123"}`)
	csrf := decode[struct{ CSRFToken string }](t, login).CSRFToken
	session := testutil.SessionFromSetCookie(login.Header)
	cookie := "tephra_session=" + session + "; tephra_csrf=" + csrf
	post := func(h testutil.Headers, name string) testutil.Response {
		return testutil.DoJSON(app, "POST", "/api/v1/vaults", h, `{"name":"`+name+`"}`)
	}
	wantErr(t, post(testutil.Headers{"cookie": cookie, "content-type": "application/json"}, "No CSRF"), 403, "VAULT_ACCESS_DENIED", "CSRF validation failed.")
	wantErr(t, post(testutil.Headers{"cookie": cookie, "x-csrf-token": "wrong", "content-type": "application/json"}, "Bad CSRF"), 403, "VAULT_ACCESS_DENIED", "CSRF validation failed.")
	wantErr(t, post(testutil.Headers{"cookie": "tephra_session=" + session, "x-csrf-token": csrf, "content-type": "application/json"}, "No cookie"), 403, "VAULT_ACCESS_DENIED", "CSRF validation failed.")
	if r := post(testutil.Headers{"cookie": cookie, "x-csrf-token": csrf, "content-type": "application/json"}, "Standard CSRF Vault"); r.Status != 201 {
		t.Fatalf("x-csrf-token: %d", r.Status)
	}
	if r := post(testutil.Headers{"cookie": cookie, "x-tephra-csrf": csrf, "content-type": "application/json"}, "Tephra CSRF Vault"); r.Status != 201 {
		t.Fatalf("x-tephra-csrf: %d", r.Status)
	}
	// Safe methods need no CSRF header.
	if r := testutil.Do(app, "GET", "/api/v1/vaults", testutil.Headers{"cookie": cookie}, nil); r.Status != 200 {
		t.Fatalf("GET: %d", r.Status)
	}
}

func TestProvisionsTokenWithClientDeviceIDAndEnforcesOwnership(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ctx := context.Background()
	path := "/api/v1/vaults/" + s.VaultID + "/tokens"
	r := testutil.DoJSON(s.App, "POST", path, s.BrowserHeaders, `{"name":"Obsidian (MacBook)","deviceId":"client-device-123","deviceName":"MacBook","platform":"obsidian-plugin"}`)
	if r.Status != 201 {
		t.Fatalf("%d %s", r.Status, r.Text())
	}
	dev, _ := s.DB.Devices().FindByID(ctx, "client-device-123")
	if dev == nil || dev.Name != "MacBook" || dev.Platform == nil || *dev.Platform != "obsidian-plugin" {
		t.Fatalf("device = %+v", dev)
	}
	owner, _ := s.DB.Users().FindByEmail(ctx, "owner@example.com")
	if dev.UserID != owner.ID {
		t.Fatal("device owner")
	}
	r = testutil.DoJSON(s.App, "POST", path, s.BrowserHeaders, `{"name":"Obsidian (MacBook 2)","deviceId":"client-device-123","deviceName":"MacBook Updated","platform":"obsidian-plugin"}`)
	if r.Status != 201 {
		t.Fatalf("%d", r.Status)
	}
	if dev, _ = s.DB.Devices().FindByID(ctx, "client-device-123"); dev.Name != "MacBook Updated" {
		t.Fatalf("updated name = %q", dev.Name)
	}
	// deviceName only creates a new device with a generated id.
	r = testutil.DoJSON(s.App, "POST", path, s.BrowserHeaders, `{"name":"n","deviceName":"Phone"}`)
	if r.Status != 201 {
		t.Fatal(r.Text())
	}
	toks, _ := s.DB.ApiTokens().ListByVault(ctx, s.VaultID)
	var last vm.ApiToken
	for _, tk := range toks {
		if tk.Name == "n" {
			last = tk
		}
	}
	if last.DeviceID == nil {
		t.Fatal("device id expected")
	}
	if d, _ := s.DB.Devices().FindByID(ctx, *last.DeviceID); d == nil || d.Name != "Phone" {
		t.Fatalf("generated device = %+v", d)
	}

	// Another user cannot reuse the device id.
	_ = s.DB.Users().Insert(ctx, vm.User{ID: "other-user", Email: "other-device@example.com", CreatedAt: 1, UpdatedAt: 1})
	raw := "tps_other-raw-session-token"
	_ = s.DB.Sessions().Insert(ctx, vm.Session{ID: auth.HashOpaqueToken(raw), UserID: "other-user", ExpiresAt: 2_000_000_000_000, CreatedAt: 1})
	_ = s.DB.Vaults().Insert(ctx, vm.Vault{ID: "other-vault-1", OwnerUserID: "other-user", Name: "Other Vault", CreatedAt: 1, UpdatedAt: 1})
	cross := testutil.DoJSON(s.App, "POST", "/api/v1/vaults/other-vault-1/tokens",
		testutil.Headers{"authorization": "Bearer " + raw, "content-type": "application/json"},
		`{"name":"Stolen Device Token","deviceId":"client-device-123","deviceName":"Imposter"}`)
	wantErr(t, cross, 403, "VAULT_ACCESS_DENIED", "Device belongs to another user.")
}

func TestLoginBootstrapAndSessionBehaviour(t *testing.T) {
	f := testutil.NewFixture(t, testutil.WithDeps(func(d *httpx.Dependencies) { d.SecureCookies = true }))
	app := newApp(f.Deps)
	st := testutil.Do(app, "GET", "/api/v1/auth/bootstrap/status", nil, nil)
	if st.Text() != `{"required":true}` {
		t.Fatal(st.Text())
	}
	boot := func(body string) testutil.Response {
		return testutil.DoJSON(app, "POST", "/api/v1/auth/bootstrap", js, body)
	}
	wantErr(t, boot(`{"token":"wrong-secret","email":"o@example.com","password":"password-123"}`), 401, "AUTH_REQUIRED", "Invalid bootstrap token.")
	wantErr(t, boot(`{"email":"o@example.com","password":"password-123"}`), 400, "INVALID_MANIFEST", "Request validation failed.")
	wantErr(t, boot(`{"token":"   ","email":"o@example.com","password":"password-123"}`), 400, "INVALID_MANIFEST", "")
	wantErr(t, boot(`{"token":"bootstrap-secret","email":"o@example.com","password":"short"}`), 400, "INVALID_MANIFEST", "")
	wantErr(t, boot(`{"token":"bootstrap-secret","email":"not-an-email","password":"password-123"}`), 400, "INVALID_MANIFEST", "")
	wantErr(t, boot(`{"token":"bootstrap-secret","email":"a..b@example.com","password":"password-123"}`), 400, "INVALID_MANIFEST", "")
	wantErr(t, boot(`{"token":"bootstrap-secret","email":"o@example.com","password":"password-123","x":1}`), 400, "INVALID_MANIFEST", "")
	wantErr(t, boot(`{nope`), 400, "INVALID_MANIFEST", "Request body must be valid JSON.")
	// token alias + trimming
	r := boot(`{"bootstrapToken":"  bootstrap-secret ","email":"Owner@Example.com","password":"password-123"}`)
	if r.Status != 201 || !regexp.MustCompile(`^\{"user":\{"id":"id-\d+","email":"owner@example.com"\}\}$`).MatchString(r.Text()) {
		t.Fatalf("bootstrap: %d %s", r.Status, r.Text())
	}
	wantErr(t, boot(`{"token":"bootstrap-secret","email":"x@example.com","password":"password-123"}`), 409, "COMMIT_FAILED", "Bootstrap has already completed.")
	if testutil.Do(app, "GET", "/api/v1/auth/bootstrap/status", nil, nil).Text() != `{"required":false}` {
		t.Fatal("status after bootstrap")
	}

	login := func(body string) testutil.Response {
		return testutil.DoJSON(app, "POST", "/api/v1/auth/login", js, body)
	}
	wantErr(t, login(`{"email":"owner@example.com","password":"wrong-password"}`), 401, "AUTH_REQUIRED", "Invalid email or password.")
	wantErr(t, login(`{"email":"nobody@example.com","password":"password-123"}`), 401, "AUTH_REQUIRED", "Invalid email or password.")
	ok := login(`{"email":"owner@example.com","password":"password-123"}`)
	cookies := ok.Header.Values("Set-Cookie")
	if len(cookies) != 2 {
		t.Fatalf("cookies: %v", cookies)
	}
	if !regexp.MustCompile(`^tephra_session=tps_[\w-]+; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000$`).MatchString(cookies[0]) {
		t.Fatalf("session cookie: %q", cookies[0])
	}
	if !regexp.MustCompile(`^tephra_csrf=tpc_[\w-]+; Path=/; SameSite=Lax; Secure; Max-Age=2592000$`).MatchString(cookies[1]) {
		t.Fatalf("csrf cookie: %q", cookies[1])
	}
	if ct := ok.Header.Get("Content-Type"); ct != "application/json" {
		t.Fatalf("content-type %q", ct)
	}
	session := testutil.SessionFromSetCookie(ok.Header)
	me := testutil.Do(app, "GET", "/api/v1/auth/me", testutil.Headers{"cookie": "tephra_session=" + session}, nil)
	if me.Status != 200 {
		t.Fatalf("me: %s", me.Text())
	}
	// Session expiry (30 days) is enforced on the cookie and bearer paths.
	f.Clock.Advance(30*24*60*60*1000 - 1)
	if r := testutil.Do(app, "GET", "/api/v1/auth/me", testutil.Headers{"cookie": "tephra_session=" + session}, nil); r.Status != 200 {
		t.Fatalf("not expired yet: %d", r.Status)
	}
	f.Clock.Advance(1)
	wantErr(t, testutil.Do(app, "GET", "/api/v1/auth/me", testutil.Headers{"cookie": "tephra_session=" + session}, nil), 401, "AUTH_REQUIRED", "Authentication is required.")
	wantErr(t, testutil.Do(app, "GET", "/api/v1/auth/me", testutil.Bearer(session), nil), 401, "AUTH_REQUIRED", "")
	wantErr(t, testutil.Do(app, "GET", "/api/v1/auth/me", testutil.Bearer("garbage"), nil), 401, "AUTH_REQUIRED", "")
	wantErr(t, testutil.Do(app, "GET", "/api/v1/auth/me", nil, nil), 401, "AUTH_REQUIRED", "Authentication is required.")
}

func TestBootstrapDisabledWithoutConfiguredToken(t *testing.T) {
	f := testutil.NewFixture(t, testutil.WithDeps(func(d *httpx.Dependencies) { d.BootstrapToken = "" }))
	app := newApp(f.Deps)
	r := testutil.DoJSON(app, "POST", "/api/v1/auth/bootstrap", js, `{"token":"x","email":"o@example.com","password":"password-123"}`)
	wantErr(t, r, 401, "AUTH_REQUIRED", "Invalid bootstrap token.")
}

func TestBodyLimitsAndContentType(t *testing.T) {
	s := testutil.Setup(t, newApp)
	// Content-Type is not checked, mirroring the TS server.
	r := testutil.Do(s.App, "POST", "/api/v1/vaults", testutil.Headers{
		"cookie": s.BrowserHeaders["cookie"], "x-tephra-csrf": s.CSRF}, []byte(`{"name":"No content type"}`))
	if r.Status != 201 {
		t.Fatalf("no content-type: %d %s", r.Status, r.Text())
	}
	big := []byte(`{"name":"` + strings.Repeat("a", 2*1024*1024) + `"}`)
	wantErr(t, testutil.Do(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, big), 413, "INVALID_MANIFEST", "Request body is too large.")
	// Exactly at the limit is accepted by the size check (then fails name validation: 400).
	pad := []byte(`{"name":"` + strings.Repeat("a", 2*1024*1024-11) + `"}`)
	if len(pad) != 2*1024*1024 {
		t.Fatalf("pad %d", len(pad))
	}
	wantErr(t, testutil.Do(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, pad), 400, "INVALID_MANIFEST", "Request validation failed.")
	// BOM tolerated, as Request.text() strips it.
	if r := testutil.Do(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, []byte("\xef\xbb\xbf{\"name\":\"bom\"}")); r.Status != 201 {
		t.Fatalf("bom: %d", r.Status)
	}
}

func TestObsidianVaults(t *testing.T) {
	s := testutil.Setup(t, newApp)
	// Disabled server: 503 OBSIDIAN_UNAVAILABLE and no vault is created.
	wantErr(t, testutil.DoJSON(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, `{"name":"Obs","syncMode":"obsidian"}`), 503, "OBSIDIAN_UNAVAILABLE", "Obsidian Sync is disabled on this server.")
	if v, _ := s.DB.Vaults().FindByName(context.Background(), "Obs"); v != nil {
		t.Fatal("vault must not exist")
	}
	// Legacy settings row-less obsidian vault is shown as unavailable/read-only.
	_ = s.DB.Vaults().Insert(context.Background(), vm.Vault{ID: "ov", OwnerUserID: ownerID(t, s), Name: "OV", SyncMode: vm.SyncModeObsidian, CreatedAt: 1, UpdatedAt: 1})
	r := testutil.Do(s.App, "GET", "/api/v1/vaults/ov", s.BrowserHeaders, nil)
	var got struct {
		Vault struct {
			ReadOnly     bool
			ObsidianSync map[string]any
		}
	}
	testutil.JSON(t, r, &got)
	if !got.Vault.ReadOnly || got.Vault.ObsidianSync["phase"] != "unavailable" || got.Vault.ObsidianSync["enabled"] != false {
		t.Fatalf("vault = %s", r.Text())
	}
	// Direct sync is blocked on obsidian vaults.
	wantErr(t, testutil.Do(s.App, "POST", "/api/v1/vaults/ov/sync/plan", s.BrowserHeaders, nil), 409, "VAULT_SYNC_MODE_MISMATCH", "")
	wantErr(t, testutil.DoJSON(s.App, "POST", "/api/v1/vaults/ov/tokens", s.BrowserHeaders, `{"name":"t"}`), 409, "VAULT_SYNC_MODE_MISMATCH", "")
	if r := testutil.DoJSON(s.App, "POST", "/api/v1/vaults/ov/tokens", s.BrowserHeaders, `{"name":"t","scopes":["vault:read-metadata"]}`); r.Status != 201 {
		t.Fatalf("read-only token on obsidian vault: %d", r.Status)
	}
}

func ownerID(t *testing.T, s *testutil.Session) string {
	u, _ := s.DB.Users().FindByEmail(context.Background(), "owner@example.com")
	return u.ID
}

func TestUnknownRoutesAndMethods(t *testing.T) {
	s := testutil.Setup(t, newApp)
	r := testutil.Do(s.App, "GET", "/does-not-exist", nil, nil)
	if r.Status != 404 || r.Text() != "404 Not Found" {
		t.Fatalf("404: %d %q", r.Status, r.Text())
	}
	// Wrong method on a known path is also 404 (Hono has no 405).
	if r := testutil.Do(s.App, "POST", "/healthz", nil, nil); r.Status != 404 {
		t.Fatalf("405 case: %d", r.Status)
	}
	// Auth runs before routing under /api/v1.
	wantErr(t, testutil.Do(s.App, "GET", "/api/v1/nothing", nil, nil), 401, "AUTH_REQUIRED", "")
	if r := testutil.Do(s.App, "GET", "/api/v1/nothing", s.BrowserHeaders, nil); r.Status != 404 {
		t.Fatalf("authed unknown: %d", r.Status)
	}
	// Unknown vault under a known suffix is 404 VAULT_NOT_FOUND from the scope middleware.
	wantErr(t, testutil.Do(s.App, "GET", "/api/v1/vaults/zzz/anything", s.BrowserHeaders, nil), 404, "VAULT_NOT_FOUND", "")
	// HEAD works on GET routes with no body.
	if r := testutil.Do(s.App, "HEAD", "/healthz", nil, nil); r.Status != 200 {
		t.Fatalf("HEAD: %d %q", r.Status, r.Text())
	}
}
