// Package oauth ports apps/api/src/oauth/server.ts: the OAuth 2.1
// authorization-code + PKCE flow for MCP clients (plan 022), with RFC 9728 /
// RFC 8414 discovery metadata and stateless RFC 7591 dynamic registration.
//
// The package depends only on httpx (not on internal/api), so internal/api can
// import it and register it from register_mcp_oauth.go without a cycle.
package oauth

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/auth"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// ConnectPath is the web app's consent page (MCP_CONNECT_PATH).
const ConnectPath = "/connect"

const (
	codeTTLMs      = 60_000
	clientIDPrefix = "tmc_"
)

var (
	readScopes  = []vm.ApiTokenScope{vm.ScopeVaultReadMetadata}
	writeScopes = []vm.ApiTokenScope{vm.ScopeVaultReadMetadata, vm.ScopeVaultWrite}

	codeChallengeRE = regexp.MustCompile(`^[A-Za-z0-9_-]{43,128}$`)
	verifierRE      = regexp.MustCompile(`^[A-Za-z0-9._~-]{43,128}$`)
)

func isLoopbackHost(h string) bool { return h == "127.0.0.1" || h == "localhost" || h == "[::1]" }

func isNativeScheme(s string) bool { return s == "cursor" || s == "vscode" || s == "vscode-insiders" }

// PublicOrigin is publicOrigin(): the configured PublicURL origin, else the
// request origin honouring the first X-Forwarded-Proto (http/https only) and
// X-Forwarded-Host values.
func PublicOrigin(r *http.Request, d httpx.Dependencies) (string, error) {
	if d.PublicURL != "" {
		u := parseURLLoose(d.PublicURL)
		if u == nil {
			return "", httpx.Fail(http.StatusInternalServerError, protocol.CodeInternalError, "An internal error occurred.")
		}
		return u.scheme + "://" + u.host, nil
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	host := r.Host
	if r.URL != nil && r.URL.Host != "" {
		host = r.URL.Host
	}
	if r.URL != nil && r.URL.Scheme != "" {
		scheme = r.URL.Scheme
	}
	if dp := defaultPort(scheme); dp != "" {
		host = strings.TrimSuffix(host, ":"+dp)
	}
	first := func(name string) string {
		v := r.Header.Get(name)
		v, _, _ = strings.Cut(v, ",")
		return jstext.Trim(v)
	}
	proto := first("X-Forwarded-Proto")
	if proto == "http" || proto == "https" {
		scheme = proto
	}
	if fh := first("X-Forwarded-Host"); fh != "" {
		host = fh
	}
	return scheme + "://" + host, nil
}

// parseURLLoose parses the operator-configured public URL (credentials and
// fragments are not rejected there, only the origin is used).
func parseURLLoose(raw string) *parsedURL {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil
	}
	scheme := strings.ToLower(u.Scheme)
	h := u.Hostname()
	if strings.Contains(h, ":") {
		h = "[" + h + "]"
	}
	hostname, ok := normaliseHost(scheme, h)
	if !ok {
		return nil
	}
	host := hostname
	if port := u.Port(); port != "" && port != defaultPort(scheme) {
		host += ":" + port
	}
	return &parsedURL{scheme: scheme, hostname: hostname, host: host, hasAuthority: true}
}

// MCPChallenge is the WWW-Authenticate value for 401s from /mcp.
func MCPChallenge(r *http.Request, d httpx.Dependencies) (string, error) {
	origin, err := PublicOrigin(r, d)
	if err != nil {
		return "", err
	}
	return `Bearer realm="tephra", resource_metadata="` + origin + `/.well-known/oauth-protected-resource"`, nil
}

// ClientInfo is the client identity embedded in a client id. RedirectURIs is
// nil when the id was not issued by /oauth/register.
type ClientInfo struct {
	Name         string
	RedirectURIs []string
}

// jsonQuote is JSON.stringify for a string.
func jsonQuote(s string) string {
	var sb strings.Builder
	sb.WriteByte('"')
	for _, r := range s {
		switch {
		case r == '"':
			sb.WriteString(`\"`)
		case r == '\\':
			sb.WriteString(`\\`)
		case r == '\b':
			sb.WriteString(`\b`)
		case r == '\f':
			sb.WriteString(`\f`)
		case r == '\n':
			sb.WriteString(`\n`)
		case r == '\r':
			sb.WriteString(`\r`)
		case r == '\t':
			sb.WriteString(`\t`)
		case r < 0x20:
			sb.WriteString(`\u00`)
			sb.WriteByte("0123456789abcdef"[r>>4])
			sb.WriteByte("0123456789abcdef"[r&15])
		default:
			sb.WriteRune(r)
		}
	}
	sb.WriteByte('"')
	return sb.String()
}

func encodeClientID(name string, redirectURIs []string) string {
	var sb strings.Builder
	sb.WriteString(`{"n":` + jsonQuote(name) + `,"r":[`)
	for i, u := range redirectURIs {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(jsonQuote(u))
	}
	sb.WriteString("]}")
	return clientIDPrefix + base64.RawURLEncoding.EncodeToString([]byte(sb.String()))
}

// lenientBase64URL mimics Buffer.from(s, 'base64url'): unknown characters are
// skipped, '+' and '/' are accepted, padding ends the data.
func lenientBase64URL(s string) []byte {
	clean := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case c == '=':
			i = len(s)
		case c == '+':
			clean = append(clean, '-')
		case c == '/':
			clean = append(clean, '_')
		case c >= 'A' && c <= 'Z', c >= 'a' && c <= 'z', c >= '0' && c <= '9', c == '-', c == '_':
			clean = append(clean, c)
		}
	}
	if len(clean)%4 == 1 {
		clean = clean[:len(clean)-1]
	}
	out, _ := base64.RawURLEncoding.DecodeString(string(clean))
	return out
}

// DecodeClientID is decodeClientId().
func DecodeClientID(clientID string) ClientInfo {
	if rest, ok := strings.CutPrefix(clientID, clientIDPrefix); ok {
		var parsed struct {
			N *string   `json:"n"`
			R *[]string `json:"r"`
		}
		dec := json.NewDecoder(bytes.NewReader(lenientBase64URL(rest)))
		if err := dec.Decode(&parsed); err == nil && parsed.N != nil && parsed.R != nil &&
			utf16Len(*parsed.N) <= 200 && len(*parsed.R) <= 10 {
			valid := true
			for _, u := range *parsed.R {
				if utf16Len(u) > 2048 {
					valid = false
				}
			}
			if valid {
				return ClientInfo{Name: *parsed.N, RedirectURIs: *parsed.R}
			}
		}
	}
	return ClientInfo{Name: sliceUTF16(clientID, 80)}
}

func parseRedirect(raw string) *parsedURL {
	u := parseURL(raw)
	if u == nil {
		return nil
	}
	if u.scheme == "http" {
		if isLoopbackHost(u.hostname) {
			return u
		}
		return nil
	}
	if isNativeScheme(u.scheme) {
		return u
	}
	return nil
}

// RedirectAllowed: redirects must be loopback (any port, RFC 8252 7.3) or a
// known IDE scheme, and match the registration if any.
func RedirectAllowed(redirectURI string, client ClientInfo) bool {
	u := parseRedirect(redirectURI)
	if u == nil {
		return false
	}
	if client.RedirectURIs == nil {
		return true
	}
	for _, registered := range client.RedirectURIs {
		if registered == redirectURI {
			return true
		}
		reg := parseRedirect(registered)
		if reg != nil && u.scheme == "http" && reg.scheme == "http" &&
			reg.hostname == u.hostname && reg.path == u.path && reg.rawQuery == u.rawQuery {
			return true
		}
	}
	return false
}

func oauthError(w http.ResponseWriter, errCode, description string) {
	w.Header().Set("Cache-Control", "no-store")
	httpx.WriteJSON(w, http.StatusBadRequest, struct {
		Error            string `json:"error"`
		ErrorDescription string `json:"error_description"`
	}{errCode, description})
}

func pkceChallenge(verifier string) string {
	sum := sha256.Sum256([]byte(verifier))
	return base64.RawURLEncoding.EncodeToString(sum[:])
}

// cors is hono/cors with origin '*', methods GET/POST/OPTIONS and the MCP
// request headers; OPTIONS is answered here with 204.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		if r.Method == http.MethodOptions {
			h.Set("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
			h.Set("Access-Control-Allow-Headers", "Content-Type,Authorization,MCP-Protocol-Version")
			h.Add("Vary", "Access-Control-Request-Headers")
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func queryFirst(pairs []pair, key string) (string, bool) {
	for _, p := range pairs {
		if p.k == key {
			return p.v, true
		}
	}
	return "", false
}

// strField reads an optional string field from a decoded JSON object.
func requireString(s *httpx.Schema, m map[string]any, key string, min, max int) string {
	v, _ := s.String(m, key, true, false, min, max)
	return v
}

type decision struct {
	clientID, redirectURI, codeChallenge string
	state                                *string
	approve                              bool
	vaultID                              *string
	read                                 bool
}

func parseDecision(body any) (decision, error) {
	var s httpx.Schema
	var d decision
	m := s.StrictObject(body, "clientId", "redirectUri", "codeChallenge", "state", "decision", "vaultId", "access")
	if m == nil {
		return d, s.Err()
	}
	d.clientID = requireString(&s, m, "clientId", 1, 4096)
	d.redirectURI = requireString(&s, m, "redirectUri", 1, 2048)
	d.codeChallenge = requireString(&s, m, "codeChallenge", 0, -1)
	if d.codeChallenge != "" && !codeChallengeRE.MatchString(d.codeChallenge) {
		s.Add("codeChallenge", "Invalid string: must match pattern /^[A-Za-z0-9_-]{43,128}$/")
	}
	if v, ok := s.String(m, "state", false, false, 0, 2048); ok {
		d.state = &v
	}
	switch m["decision"] {
	case "approve":
		d.approve = true
	case "deny":
	default:
		s.Add("decision", "Invalid option: expected one of \"approve\"|\"deny\"")
	}
	if v, ok := s.String(m, "vaultId", false, false, 1, 200); ok {
		d.vaultID = &v
	}
	if raw, ok := m["access"]; ok {
		switch raw {
		case "read":
			d.read = true
		case "write":
		default:
			s.Add("access", "Invalid option: expected one of \"read\"|\"write\"")
		}
	}
	return d, s.Err()
}

// tokenForm decodes the /oauth/token body (JSON or form).
func tokenForm(r *http.Request) (map[string]string, bool) {
	form := map[string]string{}
	body, err := io.ReadAll(io.LimitReader(r.Body, httpx.JSONLimit+1))
	if err != nil || len(body) > httpx.JSONLimit {
		return nil, false
	}
	mt, params, _ := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if strings.Contains(r.Header.Get("Content-Type"), "application/json") {
		v, err := httpx.ParseJSON(body)
		if err != nil || v == nil {
			return nil, false
		}
		if obj, ok := v.(map[string]any); ok {
			for k, val := range obj {
				if str, ok := val.(string); ok {
					form[k] = str
				}
			}
		}
		return form, true
	}
	switch mt {
	case "application/x-www-form-urlencoded":
		for _, p := range parseForm(string(body)) {
			form[p.k] = p.v
		}
	case "multipart/form-data":
		mr := multipart.NewReader(bytes.NewReader(body), params["boundary"])
		for {
			part, err := mr.NextPart()
			if err == io.EOF {
				break
			}
			if err != nil {
				return nil, false
			}
			if part.FileName() != "" {
				continue
			}
			val, err := io.ReadAll(part)
			if err != nil {
				return nil, false
			}
			form[part.FormName()] = string(val)
		}
	}
	return form, true
}

// Register installs the OAuth, discovery and consent routes on mux. The
// /api/v1/oauth/* routes rely on the shared /api/v1 auth middleware.
func Register(mux *http.ServeMux, d httpx.Dependencies) {
	wrap := func(fn httpx.HandlerFunc) http.Handler { return httpx.Handle(fn) }
	corsWrap := func(fn httpx.HandlerFunc) http.Handler { return cors(wrap(fn)) }

	resourceMetadata := func(w http.ResponseWriter, r *http.Request) error {
		origin, err := PublicOrigin(r, d)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, struct {
			Resource               string   `json:"resource"`
			AuthorizationServers   []string `json:"authorization_servers"`
			BearerMethodsSupported []string `json:"bearer_methods_supported"`
			ScopesSupported        []string `json:"scopes_supported"`
			ResourceName           string   `json:"resource_name"`
		}{origin + "/mcp", []string{origin}, []string{"header"}, []string{"vault:read-metadata", "vault:write"}, "Tephra MCP"})
		return nil
	}
	mux.Handle("GET /.well-known/oauth-protected-resource", corsWrap(resourceMetadata))
	mux.Handle("GET /.well-known/oauth-protected-resource/mcp", corsWrap(resourceMetadata))
	mux.Handle("GET /.well-known/oauth-authorization-server", corsWrap(func(w http.ResponseWriter, r *http.Request) error {
		origin, err := PublicOrigin(r, d)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, struct {
			Issuer                            string   `json:"issuer"`
			AuthorizationEndpoint             string   `json:"authorization_endpoint"`
			TokenEndpoint                     string   `json:"token_endpoint"`
			RegistrationEndpoint              string   `json:"registration_endpoint"`
			ResponseTypesSupported            []string `json:"response_types_supported"`
			GrantTypesSupported               []string `json:"grant_types_supported"`
			CodeChallengeMethodsSupported     []string `json:"code_challenge_methods_supported"`
			TokenEndpointAuthMethodsSupported []string `json:"token_endpoint_auth_methods_supported"`
			ScopesSupported                   []string `json:"scopes_supported"`
		}{origin, origin + "/oauth/authorize", origin + "/oauth/token", origin + "/oauth/register",
			[]string{"code"}, []string{"authorization_code"}, []string{"S256"}, []string{"none"},
			[]string{"vault:read-metadata", "vault:write"}})
		return nil
	}))
	preflight := cors(http.NotFoundHandler())
	mux.Handle("OPTIONS /.well-known/{path...}", preflight)
	mux.Handle("OPTIONS /oauth/register", preflight)
	mux.Handle("OPTIONS /oauth/token", preflight)

	// RFC 7591 dynamic registration. Stateless: the client id embeds the registration.
	mux.Handle("POST /oauth/register", corsWrap(func(w http.ResponseWriter, r *http.Request) error {
		// Public endpoint: never buffer more than the JSON body limit.
		data, err := io.ReadAll(io.LimitReader(r.Body, httpx.JSONLimit+1))
		if err == nil && len(data) > httpx.JSONLimit {
			err = io.ErrUnexpectedEOF
		}
		var body any
		if err == nil {
			data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
			dec := json.NewDecoder(bytes.NewReader(data))
			if err = dec.Decode(&body); err == nil {
				if _, e := dec.Token(); e != io.EOF {
					err = io.ErrUnexpectedEOF
				}
			}
		}
		if err != nil {
			oauthError(w, "invalid_client_metadata", "Body must be JSON.")
			return nil
		}
		const notRequired = "redirect_uris is required."
		obj, ok := body.(map[string]any)
		if !ok {
			oauthError(w, "invalid_redirect_uri", notRequired)
			return nil
		}
		name := "MCP client"
		if raw, present := obj["client_name"]; present {
			str, isStr := raw.(string)
			str = jstext.Trim(str)
			if !isStr || utf16Len(str) < 1 || utf16Len(str) > 100 {
				oauthError(w, "invalid_redirect_uri", notRequired)
				return nil
			}
			name = str
		}
		arr, isArr := obj["redirect_uris"].([]any)
		if !isArr || len(arr) < 1 || len(arr) > 10 {
			oauthError(w, "invalid_redirect_uri", notRequired)
			return nil
		}
		uris := make([]string, 0, len(arr))
		for _, item := range arr {
			str, isStr := item.(string)
			if !isStr || utf16Len(str) > 2048 {
				oauthError(w, "invalid_redirect_uri", notRequired)
				return nil
			}
			uris = append(uris, str)
		}
		for _, uri := range uris {
			if parseRedirect(uri) == nil {
				oauthError(w, "invalid_redirect_uri", "Only loopback (http://127.0.0.1, http://localhost, http://[::1]) redirect URIs are accepted.")
				return nil
			}
		}
		httpx.WriteJSON(w, http.StatusCreated, struct {
			ClientID                string   `json:"client_id"`
			ClientName              string   `json:"client_name"`
			RedirectURIs            []string `json:"redirect_uris"`
			GrantTypes              []string `json:"grant_types"`
			ResponseTypes           []string `json:"response_types"`
			TokenEndpointAuthMethod string   `json:"token_endpoint_auth_method"`
			ClientIDIssuedAt        int64    `json:"client_id_issued_at"`
		}{encodeClientID(name, uris), name, uris, []string{"authorization_code"}, []string{"code"}, "none", d.Clock.Now() / 1000})
		return nil
	}))

	// Entry point opened in the user's browser by the coding agent. Validates,
	// then hands over to the web app.
	mux.Handle("GET /oauth/authorize", wrap(func(w http.ResponseWriter, r *http.Request) error {
		text := func(msg string) error {
			w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
			w.WriteHeader(http.StatusBadRequest)
			_, _ = w.Write([]byte(msg))
			return nil
		}
		q := parseForm(r.URL.RawQuery)
		get := func(k string) (string, bool) { return queryFirst(q, k) }
		responseType, _ := get("response_type")
		clientID, hasClient := get("client_id")
		redirectURI, hasRedirect := get("redirect_uri")
		challenge, hasChallenge := get("code_challenge")
		method, _ := get("code_challenge_method")
		state, hasState := get("state")
		if responseType != "code" || !hasClient || utf16Len(clientID) < 1 || utf16Len(clientID) > 4096 ||
			!hasRedirect || utf16Len(redirectURI) < 1 || utf16Len(redirectURI) > 2048 ||
			!hasChallenge || !codeChallengeRE.MatchString(challenge) || method != "S256" ||
			(hasState && utf16Len(state) > 2048) {
			return text("Invalid authorization request.")
		}
		client := DecodeClientID(clientID)
		// Never redirect to an unvalidated URI.
		if !RedirectAllowed(redirectURI, client) {
			return text("Redirect URI is not allowed.")
		}
		params := []pair{{"client_id", clientID}, {"redirect_uri", redirectURI}, {"code_challenge", challenge}}
		if hasState {
			params = append(params, pair{"state", state})
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Location", ConnectPath+"?"+serializeForm(params))
		w.WriteHeader(http.StatusFound)
		return nil
	}))

	// Used by the consent page (cookie session + CSRF via the /api/v1 middleware).
	mux.Handle("GET /api/v1/oauth/client", wrap(func(w http.ResponseWriter, r *http.Request) error {
		if _, err := httpx.RequireSession(r); err != nil {
			return err
		}
		q := parseForm(r.URL.RawQuery)
		var s httpx.Schema
		clientID, ok1 := queryFirst(q, "client_id")
		redirectURI, ok2 := queryFirst(q, "redirect_uri")
		if !ok1 {
			s.Add("", "Invalid input: expected string, received undefined")
		} else if n := utf16Len(clientID); n < 1 || n > 4096 {
			s.Add("", "Invalid string length")
		}
		if err := s.Err(); err != nil {
			return err
		}
		if !ok2 {
			s.Add("", "Invalid input: expected string, received undefined")
		} else if n := utf16Len(redirectURI); n < 1 || n > 2048 {
			s.Add("", "Invalid string length")
		}
		if err := s.Err(); err != nil {
			return err
		}
		client := DecodeClientID(clientID)
		if !RedirectAllowed(redirectURI, client) {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Redirect URI is not allowed.")
		}
		u := parseURL(redirectURI)
		redirectHost := u.host
		if redirectHost == "" {
			redirectHost = u.protocol()
		}
		httpx.WriteJSON(w, http.StatusOK, struct {
			Name         string `json:"name"`
			RedirectHost string `json:"redirectHost"`
		}{client.Name, redirectHost})
		return nil
	}))

	mux.Handle("POST /api/v1/oauth/authorize", wrap(func(w http.ResponseWriter, r *http.Request) error {
		principal, err := httpx.RequireSession(r)
		if err != nil {
			return err
		}
		raw, err := httpx.JSONBody(r)
		if err != nil {
			return err
		}
		body, err := parseDecision(raw)
		if err != nil {
			return err
		}
		client := DecodeClientID(body.clientID)
		if !RedirectAllowed(body.redirectURI, client) {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Redirect URI is not allowed.")
		}
		redirect := func(params []pair) error {
			u, _ := withParams(body.redirectURI, params)
			httpx.WriteJSON(w, http.StatusOK, struct {
				RedirectURL string `json:"redirectUrl"`
			}{u})
			return nil
		}
		if !body.approve {
			params := []pair{{"error", "access_denied"}}
			if body.state != nil {
				params = append(params, pair{"state", *body.state})
			}
			return redirect(params)
		}
		if body.vaultID == nil {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Choose a vault.")
		}
		ctx := r.Context()
		vault, err := d.Database.Vaults().FindByID(ctx, *body.vaultID)
		if err != nil {
			return err
		}
		if vault == nil || vault.OwnerUserID != principal.User.ID {
			return httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "Vault was not found.")
		}
		now := d.Clock.Now()
		if _, err := d.Database.OAuthCodes().DeleteExpired(ctx, now); err != nil {
			return err
		}
		code, err := auth.CreateOpaqueToken("tpc")
		if err != nil {
			return err
		}
		scopes := writeScopes
		if body.read {
			scopes = readScopes
		}
		if err := d.Database.OAuthCodes().Insert(ctx, db.OAuthCode{
			CodeHash: auth.HashOpaqueToken(code), UserID: principal.User.ID, VaultID: vault.ID,
			ClientID: body.clientID, ClientName: client.Name, RedirectURI: body.redirectURI,
			CodeChallenge: body.codeChallenge, Scopes: append([]vm.ApiTokenScope(nil), scopes...),
			CreatedAt: now, ExpiresAt: now + codeTTLMs,
		}); err != nil {
			return err
		}
		params := []pair{{"code", code}}
		if body.state != nil {
			params = append(params, pair{"state", *body.state})
		}
		return redirect(params)
	}))

	mux.Handle("POST /oauth/token", corsWrap(func(w http.ResponseWriter, r *http.Request) error {
		form, ok := tokenForm(r)
		if !ok {
			oauthError(w, "invalid_request", "Malformed request body.")
			return nil
		}
		if form["grant_type"] != "authorization_code" {
			oauthError(w, "unsupported_grant_type", "Only authorization_code is supported.")
			return nil
		}
		code, verifier, redirectURI, clientID := form["code"], form["code_verifier"], form["redirect_uri"], form["client_id"]
		if code == "" || verifier == "" || redirectURI == "" || clientID == "" || !verifierRE.MatchString(verifier) {
			oauthError(w, "invalid_request", "code, code_verifier, redirect_uri and client_id are required.")
			return nil
		}
		ctx := r.Context()
		// Consuming first makes every code single-use, even when validation below fails.
		stored, err := d.Database.OAuthCodes().Consume(ctx, auth.HashOpaqueToken(code))
		if err != nil {
			return err
		}
		now := d.Clock.Now()
		if stored == nil || stored.ExpiresAt <= now || stored.ClientID != clientID || stored.RedirectURI != redirectURI ||
			!auth.ConstantTimeSecretEqual(pkceChallenge(verifier), stored.CodeChallenge) {
			oauthError(w, "invalid_grant", "The authorization code is invalid, expired or already used.")
			return nil
		}
		vault, err := d.Database.Vaults().FindByID(ctx, stored.VaultID)
		if err != nil {
			return err
		}
		if vault == nil || vault.OwnerUserID != stored.UserID {
			oauthError(w, "invalid_grant", "The vault is no longer available.")
			return nil
		}
		rawToken, err := auth.CreateOpaqueToken("tpt")
		if err != nil {
			return err
		}
		vaultID := vault.ID
		if err := d.Database.ApiTokens().Insert(ctx, vm.ApiToken{
			ID: d.IDs.Generate(), UserID: stored.UserID, VaultID: &vaultID,
			TokenHash: auth.HashOpaqueToken(rawToken), Name: sliceUTF16("MCP: "+stored.ClientName, 200),
			Scopes: stored.Scopes, CreatedAt: now,
		}); err != nil {
			return err
		}
		scopeStrs := make([]string, len(stored.Scopes))
		for i, sc := range stored.Scopes {
			scopeStrs[i] = string(sc)
		}
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Pragma", "no-cache")
		httpx.WriteJSON(w, http.StatusOK, struct {
			AccessToken string `json:"access_token"`
			TokenType   string `json:"token_type"`
			Scope       string `json:"scope"`
		}{rawToken, "Bearer", strings.Join(scopeStrs, " ")})
		return nil
	}))
}
