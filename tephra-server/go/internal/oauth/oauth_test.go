package oauth_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/api"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/oauth"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func newApp(d httpx.Dependencies) http.Handler { return api.NewApp(d) }

type obj = map[string]any

var (
	verifier  = strings.Repeat("v", 50)
	challenge = func() string { h := sha256.Sum256([]byte(verifier)); return base64.RawURLEncoding.EncodeToString(h[:]) }()
)

const redirect = "http://127.0.0.1:53682/callback"

func jsonBytes(v any) []byte { b, _ := json.Marshal(v); return b }

func register(s *testutil.Session, uris ...string) testutil.Response {
	if len(uris) == 0 {
		uris = []string{redirect}
	}
	return testutil.Do(s.App, "POST", "/oauth/register", testutil.Headers{"content-type": "application/json"},
		jsonBytes(obj{"client_name": "Claude Code", "redirect_uris": uris}))
}

func decode(t *testing.T, r testutil.Response) obj {
	t.Helper()
	var v obj
	testutil.JSON(t, r, &v)
	return v
}

func clientID(t *testing.T, s *testutil.Session) string {
	t.Helper()
	return decode(t, register(s))["client_id"].(string)
}

func approve(s *testutil.Session, clientID string, extra obj) testutil.Response {
	body := obj{
		"clientId": clientID, "redirectUri": redirect, "codeChallenge": challenge, "state": "xyz",
		"decision": "approve", "vaultId": s.VaultID, "access": "write",
	}
	for k, v := range extra {
		if v == nil {
			delete(body, k)
		} else {
			body[k] = v
		}
	}
	return testutil.Do(s.App, "POST", "/api/v1/oauth/authorize", s.BrowserHeaders, jsonBytes(body))
}

func exchange(s *testutil.Session, clientID, code string, extra map[string]string) testutil.Response {
	form := url.Values{
		"grant_type": {"authorization_code"}, "code": {code}, "code_verifier": {verifier},
		"redirect_uri": {redirect}, "client_id": {clientID},
	}
	for k, v := range extra {
		form.Set(k, v)
	}
	return testutil.Do(s.App, "POST", "/oauth/token", testutil.Headers{"content-type": "application/x-www-form-urlencoded"}, []byte(form.Encode()))
}

func codeFor(t *testing.T, s *testutil.Session, clientID string, extra obj) string {
	t.Helper()
	r := approve(s, clientID, extra)
	if r.Status != 200 {
		t.Fatalf("approve status %d: %s", r.Status, r.Text())
	}
	u, err := url.Parse(decode(t, r)["redirectUrl"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if u.Scheme+"://"+u.Host+u.Path != redirect {
		t.Fatalf("redirect %s", u)
	}
	if u.Query().Get("state") != "xyz" {
		t.Fatalf("state in %s", u)
	}
	return u.Query().Get("code")
}

func mcpCall(s *testutil.Session, token string, body string) testutil.Response {
	return testutil.DoJSON(s.App, "POST", "/mcp", testutil.Headers{"content-type": "application/json", "authorization": "Bearer " + token}, body)
}

func TestDiscoveryMetadataAndChallenge(t *testing.T) {
	s := testutil.Setup(t, newApp)
	h := testutil.Headers{"content-type": "application/json"}
	ch := testutil.DoJSON(s.App, "POST", "http://tephra.test/mcp", h, "{}")
	if ch.Status != 401 || !strings.Contains(ch.Header.Get("WWW-Authenticate"), `resource_metadata="http://tephra.test/.well-known/oauth-protected-resource"`) {
		t.Fatalf("challenge: %d %v", ch.Status, ch.Header)
	}
	res := testutil.Do(s.App, "GET", "http://tephra.test/.well-known/oauth-protected-resource", nil, nil)
	if res.Text() != `{"resource":"http://tephra.test/mcp","authorization_servers":["http://tephra.test"],"bearer_methods_supported":["header"],"scopes_supported":["vault:read-metadata","vault:write"],"resource_name":"Tephra MCP"}` {
		t.Fatalf("resource: %s", res.Text())
	}
	if res.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatalf("cors: %v", res.Header)
	}
	alt := testutil.Do(s.App, "GET", "http://tephra.test/.well-known/oauth-protected-resource/mcp", nil, nil)
	if alt.Text() != res.Text() {
		t.Fatalf("alt: %s", alt.Text())
	}
	srv := testutil.Do(s.App, "GET", "http://tephra.test/.well-known/oauth-authorization-server", nil, nil)
	if srv.Text() != `{"issuer":"http://tephra.test","authorization_endpoint":"http://tephra.test/oauth/authorize","token_endpoint":"http://tephra.test/oauth/token","registration_endpoint":"http://tephra.test/oauth/register","response_types_supported":["code"],"grant_types_supported":["authorization_code"],"code_challenge_methods_supported":["S256"],"token_endpoint_auth_methods_supported":["none"],"scopes_supported":["vault:read-metadata","vault:write"]}` {
		t.Fatalf("server: %s", srv.Text())
	}
}

func TestIssuerFromPublicURLAndForwardedHeaders(t *testing.T) {
	s := testutil.Setup(t, newApp)
	fwd := testutil.Do(s.App, "GET", "http://internal:8080/.well-known/oauth-protected-resource", testutil.Headers{
		"x-forwarded-proto": "https, http", "x-forwarded-host": "tephra.example.com, other",
	}, nil)
	if !strings.HasPrefix(fwd.Text(), `{"resource":"https://tephra.example.com/mcp"`) {
		t.Fatalf("forwarded: %s", fwd.Text())
	}
	bad := testutil.Do(s.App, "GET", "http://internal:8080/.well-known/oauth-protected-resource", testutil.Headers{"x-forwarded-proto": "ftp"}, nil)
	if !strings.HasPrefix(bad.Text(), `{"resource":"http://internal:8080/mcp"`) {
		t.Fatalf("bad proto: %s", bad.Text())
	}
	d := s.Deps
	d.PublicURL = "https://Pub.Example.com:443/some/path"
	app := api.NewApp(d)
	pub := testutil.Do(app, "GET", "http://x/.well-known/oauth-authorization-server", testutil.Headers{"x-forwarded-host": "evil.test"}, nil)
	if !strings.HasPrefix(pub.Text(), `{"issuer":"https://pub.example.com"`) {
		t.Fatalf("public url: %s", pub.Text())
	}
}

func TestCORSPreflight(t *testing.T) {
	s := testutil.Setup(t, newApp)
	for _, p := range []string{"/oauth/token", "/oauth/register", "/.well-known/oauth-authorization-server"} {
		r := testutil.Do(s.App, "OPTIONS", p, nil, nil)
		if r.Status != 204 || r.Header.Get("Access-Control-Allow-Origin") != "*" ||
			r.Header.Get("Access-Control-Allow-Methods") != "GET,POST,OPTIONS" ||
			r.Header.Get("Access-Control-Allow-Headers") != "Content-Type,Authorization,MCP-Protocol-Version" {
			t.Fatalf("%s: %d %v", p, r.Status, r.Header)
		}
	}
}

func TestRegistersClientsOnlyWithLoopbackOrIDERedirects(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ok := register(s, "http://localhost:3118/cb", "cursor://anysphere.cursor-retrieval/oauth/callback")
	if ok.Status != 201 {
		t.Fatalf("ok: %d %s", ok.Status, ok.Text())
	}
	body := decode(t, ok)
	if !strings.HasPrefix(body["client_id"].(string), "tmc_") {
		t.Fatalf("client id %v", body["client_id"])
	}
	if !regexp.MustCompile(`^\{"client_id":"tmc_[A-Za-z0-9_-]+","client_name":"Claude Code","redirect_uris":\["http://localhost:3118/cb","cursor://anysphere.cursor-retrieval/oauth/callback"\],"grant_types":\["authorization_code"\],"response_types":\["code"\],"token_endpoint_auth_method":"none","client_id_issued_at":1700000000\}$`).MatchString(ok.Text()) {
		t.Fatalf("body: %s", ok.Text())
	}
	for _, bad := range []string{"https://evil.example/cb", "http://evil.example/cb", "javascript:alert(1)", "http://127.0.0.1/cb#frag",
		"http://user@127.0.0.1/cb", "http://127.0.0.1:99999/cb", "http://127.0.0.1.evil.example/cb"} {
		r := register(s, bad)
		if r.Status != 400 || decode(t, r)["error"] != "invalid_redirect_uri" {
			t.Errorf("%s: %d %s", bad, r.Status, r.Text())
		}
	}
	for _, good := range []string{"http://[::1]:8080/cb", "http://LOCALHOST/cb", "http://0x7f.1/cb", "vscode://x/y", "vscode-insiders://x"} {
		if r := register(s, good); r.Status != 201 {
			t.Errorf("%s: %d %s", good, r.Status, r.Text())
		}
	}
	h := testutil.Headers{"content-type": "application/json"}
	r := testutil.DoJSON(s.App, "POST", "/oauth/register", h, "nope")
	if r.Status != 400 || r.Text() != `{"error":"invalid_client_metadata","error_description":"Body must be JSON."}` || r.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("not json: %d %s %v", r.Status, r.Text(), r.Header)
	}
	r = testutil.DoJSON(s.App, "POST", "/oauth/register", h, `{"client_name":"x"}`)
	if r.Status != 400 || r.Text() != `{"error":"invalid_redirect_uri","error_description":"redirect_uris is required."}` {
		t.Fatalf("no uris: %d %s", r.Status, r.Text())
	}
	r = testutil.DoJSON(s.App, "POST", "/oauth/register", h, `{"redirect_uris":["http://127.0.0.1/cb"]}`)
	if !strings.Contains(r.Text(), `"client_name":"MCP client"`) {
		t.Fatalf("default name: %s", r.Text())
	}
}

func TestAuthorizeRedirectsToConsentPageAndRejectsBadRedirects(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	q := url.Values{
		"response_type": {"code"}, "client_id": {cid}, "redirect_uri": {redirect},
		"code_challenge": {challenge}, "code_challenge_method": {"S256"}, "state": {"xyz"},
	}
	get := func() testutil.Response { return testutil.Do(s.App, "GET", "/oauth/authorize?"+q.Encode(), nil, nil) }
	ok := get()
	if ok.Status != 302 || !regexp.MustCompile(`^/connect\?.*state=xyz`).MatchString(ok.Header.Get("Location")) || ok.Header.Get("Cache-Control") != "no-store" {
		t.Fatalf("ok: %d %v", ok.Status, ok.Header)
	}
	loc, _ := url.Parse(ok.Header.Get("Location"))
	if loc.Query().Get("client_id") != cid || loc.Query().Get("redirect_uri") != redirect || loc.Query().Get("code_challenge") != challenge {
		t.Fatalf("location %s", loc)
	}
	q.Set("redirect_uri", "http://127.0.0.1:1/other")
	if r := get(); r.Status != 400 || r.Text() != "Redirect URI is not allowed." {
		t.Fatalf("other path: %d %s", r.Status, r.Text())
	}
	q.Set("redirect_uri", "https://evil.example/cb")
	if get().Status != 400 {
		t.Fatal("evil redirect")
	}
	q.Set("redirect_uri", redirect)
	q.Set("code_challenge_method", "plain")
	if r := get(); r.Status != 400 || r.Text() != "Invalid authorization request." {
		t.Fatalf("plain: %d %s", r.Status, r.Text())
	}
}

func TestAllowsDifferentLoopbackPortForRegisteredClient(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	if r := approve(s, cid, obj{"redirectUri": "http://127.0.0.1:9999/callback"}); r.Status != 200 {
		t.Fatalf("approve: %d %s", r.Status, r.Text())
	}
	if r := approve(s, cid, obj{"redirectUri": "http://localhost:9999/callback"}); r.Status != 400 {
		t.Fatalf("other host: %d", r.Status)
	}
}

func TestIssuesScopedTokenUsableOnMcp(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	code := codeFor(t, s, cid, nil)
	r := exchange(s, cid, code, nil)
	if r.Status != 200 || r.Header.Get("Cache-Control") != "no-store" || r.Header.Get("Pragma") != "no-cache" {
		t.Fatalf("exchange: %d %v %s", r.Status, r.Header, r.Text())
	}
	if !regexp.MustCompile(`^\{"access_token":"tpt_[A-Za-z0-9_-]+","token_type":"Bearer","scope":"vault:read-metadata vault:write"\}$`).MatchString(r.Text()) {
		t.Fatalf("token body: %s", r.Text())
	}
	tok := decode(t, r)["access_token"].(string)
	list := mcpCall(s, tok, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_vaults","arguments":{}}}`)
	var body struct {
		Result struct {
			StructuredContent struct{ Vaults []obj } `json:"structuredContent"`
		}
	}
	testutil.JSON(t, list, &body)
	if len(body.Result.StructuredContent.Vaults) != 1 || body.Result.StructuredContent.Vaults[0]["id"] != s.VaultID {
		t.Fatalf("list_vaults: %s", list.Text())
	}
	// Shows up in the vault's token list as a revocable MCP token.
	tokens := testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID+"/tokens", s.BrowserHeaders, nil)
	if !strings.Contains(tokens.Text(), `"name":"MCP: Claude Code"`) {
		t.Fatalf("tokens: %s", tokens.Text())
	}
}

func TestJSONTokenRequest(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	code := codeFor(t, s, cid, nil)
	r := testutil.Do(s.App, "POST", "/oauth/token", testutil.Headers{"content-type": "application/json"}, jsonBytes(obj{
		"grant_type": "authorization_code", "code": code, "code_verifier": verifier, "redirect_uri": redirect, "client_id": cid,
	}))
	if r.Status != 200 {
		t.Fatalf("json exchange: %d %s", r.Status, r.Text())
	}
	r = testutil.Do(s.App, "POST", "/oauth/token", testutil.Headers{"content-type": "application/json"}, []byte("null"))
	if r.Status != 400 || r.Text() != `{"error":"invalid_request","error_description":"Malformed request body."}` {
		t.Fatalf("null json: %d %s", r.Status, r.Text())
	}
	r = testutil.Do(s.App, "POST", "/oauth/token", testutil.Headers{"content-type": "text/plain"}, []byte("x"))
	if r.Status != 400 || !strings.Contains(r.Text(), "unsupported_grant_type") {
		t.Fatalf("plain: %d %s", r.Status, r.Text())
	}
	r = exchange(s, cid, "x", map[string]string{"code_verifier": "short"})
	if r.Status != 400 || r.Text() != `{"error":"invalid_request","error_description":"code, code_verifier, redirect_uri and client_id are required."}` {
		t.Fatalf("short verifier: %d %s", r.Status, r.Text())
	}
}

func TestGrantsReadOnlyAccessWhenRequested(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	code := codeFor(t, s, cid, obj{"access": "read"})
	token := decode(t, exchange(s, cid, code, nil))
	if token["scope"] != "vault:read-metadata" {
		t.Fatalf("scope %v", token["scope"])
	}
	w := mcpCall(s, token["access_token"].(string), `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"create_note","arguments":{"path":"x.md","content":"hi"}}}`)
	if !strings.Contains(w.Text(), `"isError":true`) {
		t.Fatalf("write allowed: %s", w.Text())
	}
}

func TestCodesAreSingleUseAndBound(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)

	code1 := codeFor(t, s, cid, nil)
	if exchange(s, cid, code1, nil).Status != 200 {
		t.Fatal("first exchange")
	}
	if exchange(s, cid, code1, nil).Status != 400 {
		t.Fatal("replay")
	}

	code2 := codeFor(t, s, cid, nil)
	wrong := exchange(s, cid, code2, map[string]string{"code_verifier": strings.Repeat("w", 50)})
	if wrong.Status != 400 || wrong.Text() != `{"error":"invalid_grant","error_description":"The authorization code is invalid, expired or already used."}` {
		t.Fatalf("wrong verifier: %d %s", wrong.Status, wrong.Text())
	}
	if exchange(s, cid, code2, nil).Status != 400 {
		t.Fatal("burned by failed attempt")
	}

	code3 := codeFor(t, s, cid, nil)
	if exchange(s, cid, code3, map[string]string{"redirect_uri": "http://127.0.0.1:1/x"}).Status != 400 {
		t.Fatal("redirect binding")
	}
	code4 := codeFor(t, s, cid, nil)
	if exchange(s, "tmc_other", code4, nil).Status != 400 {
		t.Fatal("client binding")
	}
	if exchange(s, cid, "tpc_unknown", nil).Status != 400 {
		t.Fatal("unknown code")
	}
	r := exchange(s, cid, "x", map[string]string{"grant_type": "refresh_token"})
	if r.Status != 400 || r.Text() != `{"error":"unsupported_grant_type","error_description":"Only authorization_code is supported."}` {
		t.Fatalf("grant type: %d %s", r.Status, r.Text())
	}
}

func TestCodesExpireAfter60Seconds(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	code := codeFor(t, s, cid, nil)
	s.Clock.Advance(61_000)
	if exchange(s, cid, code, nil).Status != 400 {
		t.Fatal("expired code accepted")
	}
	// Exactly at the expiry instant the code is already invalid.
	code = codeFor(t, s, cid, nil)
	s.Clock.Advance(60_000)
	if exchange(s, cid, code, nil).Status != 400 {
		t.Fatal("code accepted at expiresAt")
	}
	code = codeFor(t, s, cid, nil)
	s.Clock.Advance(59_999)
	if exchange(s, cid, code, nil).Status != 200 {
		t.Fatal("code rejected before expiry")
	}
}

func TestApprovalRequiresBrowserSessionAndOwnVaults(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	h := testutil.Headers{"content-type": "application/json"}
	if r := testutil.DoJSON(s.App, "POST", "/api/v1/oauth/authorize", h, "{}"); r.Status != 401 {
		t.Fatalf("no auth: %d", r.Status)
	}
	viaToken := testutil.Do(s.App, "POST", "/api/v1/oauth/authorize", testutil.Headers{"content-type": "application/json", "authorization": "Bearer " + s.Token},
		jsonBytes(obj{"clientId": cid, "redirectUri": redirect, "codeChallenge": challenge, "decision": "approve", "vaultId": s.VaultID}))
	if viaToken.Status != 403 {
		t.Fatalf("via token: %d", viaToken.Status)
	}
	if r := approve(s, cid, obj{"vaultId": "nope"}); r.Status != 404 || !strings.Contains(r.Text(), "VAULT_NOT_FOUND") {
		t.Fatalf("vault nope: %d %s", r.Status, r.Text())
	}
	if r := approve(s, cid, obj{"redirectUri": "https://evil.example/cb"}); r.Status != 400 || !strings.Contains(r.Text(), "Redirect URI is not allowed.") {
		t.Fatalf("evil redirect: %d %s", r.Status, r.Text())
	}
	if r := approve(s, cid, obj{"vaultId": nil}); r.Status != 400 || !strings.Contains(r.Text(), "Choose a vault.") {
		t.Fatalf("no vault: %d %s", r.Status, r.Text())
	}
	if r := approve(s, cid, obj{"extra": 1}); r.Status != 400 || !strings.Contains(r.Text(), "INVALID_MANIFEST") {
		t.Fatalf("strict: %d %s", r.Status, r.Text())
	}
	if r := approve(s, cid, obj{"access": "admin"}); r.Status != 400 {
		t.Fatalf("access enum: %d", r.Status)
	}
	noCSRF := testutil.Do(s.App, "POST", "/api/v1/oauth/authorize", testutil.Headers{"cookie": s.BrowserHeaders["cookie"], "content-type": "application/json"},
		jsonBytes(obj{"clientId": cid, "redirectUri": redirect, "codeChallenge": challenge, "decision": "approve", "vaultId": s.VaultID}))
	if noCSRF.Status != 403 {
		t.Fatalf("no csrf: %d", noCSRF.Status)
	}
}

func TestOtherUsersVaultCannotBeApproved(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	ctx := context.Background()
	// A vault owned by someone else.
	v, _ := s.DB.Vaults().FindByID(ctx, s.VaultID)
	other := *v
	other.ID, other.Name, other.OwnerUserID = "foreign", "Foreign", "someone-else"
	if err := s.DB.Users().Insert(ctx, vm.User{ID: "someone-else", Email: "else@example.com", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.DB.Vaults().Insert(ctx, other); err != nil {
		t.Fatal(err)
	}
	if r := approve(s, cid, obj{"vaultId": "foreign"}); r.Status != 404 {
		t.Fatalf("foreign vault: %d %s", r.Status, r.Text())
	}
}

func TestDeclineReturnsAccessDenied(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	r := approve(s, cid, obj{"decision": "deny", "vaultId": nil})
	u, err := url.Parse(decode(t, r)["redirectUrl"].(string))
	if err != nil {
		t.Fatal(err)
	}
	q := u.Query()
	if q.Get("error") != "access_denied" || q.Get("state") != "xyz" || q.Has("code") {
		t.Fatalf("redirect %s", u)
	}
}

func TestDescribesClientForConsentPage(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	r := testutil.Do(s.App, "GET", "/api/v1/oauth/client?client_id="+url.QueryEscape(cid)+"&redirect_uri="+url.QueryEscape(redirect), s.BrowserHeaders, nil)
	if r.Text() != `{"name":"Claude Code","redirectHost":"127.0.0.1:53682"}` {
		t.Fatalf("client: %s", r.Text())
	}
	r = testutil.Do(s.App, "GET", "/api/v1/oauth/client?client_id=abc&redirect_uri="+url.QueryEscape("vscode:foo"), s.BrowserHeaders, nil)
	if r.Text() != `{"name":"abc","redirectHost":"vscode:"}` {
		t.Fatalf("opaque client: %s", r.Text())
	}
	if r := testutil.Do(s.App, "GET", "/api/v1/oauth/client?redirect_uri=x", s.BrowserHeaders, nil); r.Status != 400 {
		t.Fatalf("missing client_id: %d", r.Status)
	}
	if r := testutil.Do(s.App, "GET", "/api/v1/oauth/client?client_id=a&redirect_uri="+url.QueryEscape("https://evil.example/"), s.BrowserHeaders, nil); r.Status != 400 || !strings.Contains(r.Text(), "Redirect URI is not allowed.") {
		t.Fatalf("evil: %d %s", r.Status, r.Text())
	}
	viaToken := testutil.Do(s.App, "GET", "/api/v1/oauth/client?client_id=a&redirect_uri="+url.QueryEscape(redirect), testutil.Bearer(s.Token), nil)
	if viaToken.Status != 403 {
		t.Fatalf("token: %d", viaToken.Status)
	}
}

func TestClientIDEncodingRoundTrip(t *testing.T) {
	s := testutil.Setup(t, newApp)
	cid := clientID(t, s)
	info := oauth.DecodeClientID(cid)
	if info.Name != "Claude Code" || len(info.RedirectURIs) != 1 || info.RedirectURIs[0] != redirect {
		t.Fatalf("info %+v", info)
	}
	// Same bytes as Buffer.from(JSON.stringify({n, r})).toString('base64url').
	want := "tmc_" + base64.RawURLEncoding.EncodeToString([]byte(`{"n":"Claude Code","r":["`+redirect+`"]}`))
	if cid != want {
		t.Fatalf("client id %s want %s", cid, want)
	}
	opaque := oauth.DecodeClientID(strings.Repeat("é", 100))
	if opaque.RedirectURIs != nil || opaque.Name != strings.Repeat("é", 80) {
		t.Fatalf("opaque %+v", opaque)
	}
	// Malformed registration payload falls back to an opaque public client.
	bad := "tmc_" + base64.RawURLEncoding.EncodeToString([]byte(`{"n":5,"r":[]}`))
	if got := oauth.DecodeClientID(bad); got.RedirectURIs != nil || got.Name != bad {
		t.Fatalf("bad payload %+v", got)
	}
	if !oauth.RedirectAllowed("http://127.0.0.1:1/x", oauth.ClientInfo{Name: "x"}) {
		t.Fatal("unregistered loopback client")
	}
	if oauth.RedirectAllowed("http://127.0.0.1:1/x", oauth.ClientInfo{Name: "x", RedirectURIs: []string{}}) {
		t.Fatal("empty registration")
	}
	if oauth.RedirectAllowed("http://127.0.0.1:1/x?a=1", oauth.ClientInfo{RedirectURIs: []string{"http://127.0.0.1:2/x"}}) {
		t.Fatal("query must match")
	}
}

// /oauth/register is unauthenticated, so an oversized body must be refused
// without being buffered (JSON body limit, 2 MiB).
func TestRegisterRejectsOversizedBodiesWithoutBufferingThem(t *testing.T) {
	s := testutil.Setup(t, newApp)
	big := `{"client_name":"` + strings.Repeat("a", httpx.JSONLimit) + `","redirect_uris":["http://127.0.0.1/cb"]}`
	r := testutil.DoJSON(s.App, "POST", "/oauth/register", testutil.Headers{"content-type": "application/json"}, big)
	if r.Status != 400 || decode(t, r)["error"] != "invalid_client_metadata" {
		t.Fatalf("oversized register: %d %.200s", r.Status, r.Text())
	}
	// A body right under the limit with a valid shape still works.
	small := `{"client_name":"` + strings.Repeat("a", 90) + `","redirect_uris":["http://127.0.0.1/cb"]}`
	if r := testutil.DoJSON(s.App, "POST", "/oauth/register", testutil.Headers{"content-type": "application/json"}, small); r.Status != 201 {
		t.Fatalf("register: %d %s", r.Status, r.Text())
	}
}
