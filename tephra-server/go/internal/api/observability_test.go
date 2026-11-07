package api_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"regexp"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/api"
	"github.com/championswimmer/tephra/tephra-server/go/internal/core"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
)

var uuidRE = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

const echoID = "123e4567-e89b-12d3-a456-426614174000"

func obsFixture(t *testing.T, extra ...testutil.Option) (*testutil.Fixture, http.Handler) {
	clock := core.SystemClock{}
	opts := append([]testutil.Option{testutil.WithClock(clock), testutil.WithDeps(func(d *httpx.Dependencies) {
		d.IDs = core.NewUuidV7Generator(clock)
	})}, extra...)
	f := testutil.NewFixture(t, opts...)
	return f, api.NewApp(f.Deps)
}

func logLines(t *testing.T, f *testutil.Fixture) []map[string]any {
	t.Helper()
	var out []map[string]any
	for _, line := range strings.Split(f.Logs.String(), "\n") {
		if line == "" {
			continue
		}
		var m map[string]any
		if err := json.Unmarshal([]byte(line), &m); err != nil {
			t.Fatalf("bad log line %q: %v", line, err)
		}
		out = append(out, m)
	}
	return out
}

func TestRequestIDSetWhenAbsent(t *testing.T) {
	_, app := obsFixture(t)
	r := testutil.Do(app, "GET", "/healthz", nil, nil)
	if id := r.Header.Get("X-Request-Id"); !uuidRE.MatchString(id) {
		t.Fatalf("id = %q", id)
	}
}

func TestEchoesWellFormedRequestID(t *testing.T) {
	_, app := obsFixture(t)
	r := testutil.Do(app, "GET", "/healthz", testutil.Headers{"x-request-id": echoID}, nil)
	if r.Header.Get("X-Request-Id") != echoID {
		t.Fatalf("id = %q", r.Header.Get("X-Request-Id"))
	}
}

func TestReplacesMalformedRequestID(t *testing.T) {
	_, app := obsFixture(t)
	for _, bad := range []string{"not-a-uuid", strings.Repeat("a", 129), echoID + "x"} {
		r := testutil.Do(app, "GET", "/healthz", testutil.Headers{"x-request-id": bad}, nil)
		id := r.Header.Get("X-Request-Id")
		if id == bad || !uuidRE.MatchString(id) {
			t.Fatalf("id = %q for %q", id, bad)
		}
	}
}

func TestRequestIDOnErrorResponses(t *testing.T) {
	_, app := obsFixture(t)
	r := testutil.Do(app, "GET", "/api/v1/auth/me", nil, nil)
	if r.Status != 401 || !uuidRE.MatchString(r.Header.Get("X-Request-Id")) {
		t.Fatalf("401: %d %q", r.Status, r.Header.Get("X-Request-Id"))
	}
	m := testutil.Do(app, "GET", "/does-not-exist", testutil.Headers{"x-request-id": echoID}, nil)
	if m.Status != 404 || m.Header.Get("X-Request-Id") != echoID {
		t.Fatalf("404: %d %q", m.Status, m.Header.Get("X-Request-Id"))
	}
}

func TestOneStructuredLogLinePerRequestWithoutSecrets(t *testing.T) {
	f, app := obsFixture(t)
	r := testutil.Do(app, "GET", "/healthz", testutil.Headers{"authorization": "Bearer secret-token", "cookie": "tephra_session=secret-session"}, nil)
	lines := logLines(t, f)
	if len(lines) != 1 {
		t.Fatalf("lines = %d", len(lines))
	}
	e := lines[0]
	if e["request_id"] != r.Header.Get("X-Request-Id") || e["method"] != "GET" || e["path"] != "/healthz" || e["status"] != float64(200) {
		t.Fatalf("entry = %v", e)
	}
	if _, ok := e["duration_ms"].(float64); !ok {
		t.Fatalf("duration_ms = %v", e["duration_ms"])
	}
	raw := f.Logs.String()
	for _, secret := range []string{"secret-token", "secret-session"} {
		if strings.Contains(raw, secret) {
			t.Fatalf("log leaked %q", secret)
		}
	}
	for _, forbidden := range []string{"authorization", "cookie", "password", "content", "token_hash", "tokenHash"} {
		if _, ok := e[forbidden]; ok {
			t.Fatalf("forbidden field %q", forbidden)
		}
	}
	// Key order: request_id, method, path, status, duration_ms.
	if !strings.HasPrefix(raw, `{"request_id":"`) || strings.Index(raw, `"method"`) > strings.Index(raw, `"path"`) {
		t.Fatalf("order: %s", raw)
	}
}

func TestLogLineIncludesHandlerFieldsAndErrorStatus(t *testing.T) {
	f, app := obsFixture(t)
	// Seed an owner + token directly so the stub route is reachable with a bearer token.
	ctx := context.Background()
	_ = f.DB.Users().Insert(ctx, userRow("user-1"))
	_ = f.DB.Vaults().Insert(ctx, vaultRow("vault-1", "user-1"))
	raw := "tpt_test-token-value"
	tok := tokenRow(raw, "vault-1", "user-1")
	_ = f.DB.ApiTokens().Insert(ctx, tok)
	r := testutil.Do(app, "POST", "/api/v1/vaults/vault-1/sync/plan", withJSON(testutil.Bearer(raw)), emptyPlanBody())
	if r.Status != 200 {
		t.Fatalf("plan: %d %s", r.Status, r.Text())
	}
	lines := logLines(t, f)
	if len(lines) != 1 || lines[0]["vault_id"] != "vault-1" || lines[0]["revision"] != float64(0) {
		t.Fatalf("lines = %v", lines)
	}
	if strings.Contains(f.Logs.String(), raw) {
		t.Fatal("token leaked")
	}
	f.Logs.Reset()
	testutil.Do(app, "GET", "/api/v1/auth/me", nil, nil)
	if l := logLines(t, f); len(l) != 1 || l[0]["status"] != float64(401) {
		t.Fatalf("error line = %v", l)
	}
}

func TestHealthAndReadiness(t *testing.T) {
	_, app := obsFixture(t)
	if r := testutil.Do(app, "GET", "/healthz", nil, nil); r.Status != 200 || r.Text() != `{"status":"ok"}` || r.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("healthz: %d %s %q", r.Status, r.Text(), r.Header.Get("Content-Type"))
	}
	if r := testutil.Do(app, "GET", "/readyz", nil, nil); r.Status != 200 || r.Text() != `{"status":"ready"}` {
		t.Fatalf("readyz: %d %s", r.Status, r.Text())
	}
	f := testutil.NewFixture(t)
	f.Deps.Database = brokenDB{f.DB}
	r := testutil.Do(api.NewApp(f.Deps), "GET", "/readyz", nil, nil)
	wantErr(t, r, 503, "INTERNAL_ERROR", "Service is not ready.")
}

func TestUnhandledErrorsAreOpaque500(t *testing.T) {
	f := testutil.NewFixture(t)
	f.Deps.Database = brokenDB{f.DB}
	app := api.NewApp(f.Deps)
	r := testutil.Do(app, "GET", "/api/v1/auth/bootstrap/status", nil, nil)
	wantErr(t, r, 500, "INTERNAL_ERROR", "An internal error occurred.")
	if bytes.Contains(r.Body, []byte("boom")) || r.Header.Get("X-Request-Id") == "" {
		t.Fatalf("leaky 500: %s", r.Text())
	}
}

var errBoom = errors.New("boom")
