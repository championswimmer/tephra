package httpx_test

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func TestMarshalJSON(t *testing.T) {
	type inner struct {
		A []string `json:"a"`
		B *string  `json:"b"`
		C *string  `json:"c,omitempty"`
		D map[string]any
	}
	got, err := httpx.MarshalJSON(map[string]any{
		"tokens": []vm.ApiToken(nil), "s": "<a href=\"x\">&</a>", "n": inner{}, "list": []inner{{}},
		"scopes": vm.ApiToken{}.Scopes, "bytes": []byte(nil), "num": 1.5, "bool": true,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{"bool":true,"bytes":[],"list":[{"a":[],"b":null,"D":null}],"n":{"a":[],"b":null,"D":null},"num":1.5,"s":"<a href=\"x\">&</a>","scopes":[],"tokens":[]}`
	if string(got) != want {
		t.Fatalf("got  %s\nwant %s", got, want)
	}
	// Embedded structs are flattened like encoding/json; trailing newline is absent.
	type base struct {
		ID string `json:"id"`
	}
	type derived struct {
		base
		X int `json:"x,omitempty"`
	}
	got, _ = httpx.MarshalJSON(derived{base: base{ID: "1"}})
	if string(got) != `{"id":"1"}` {
		t.Fatalf("embedded: %s", got)
	}
}

func TestErrorEnvelopeAndValidationCodes(t *testing.T) {
	cases := []struct {
		err    error
		status int
		code   string
	}{
		{httpx.Fail(409, protocol.CodeCommitFailed, "m"), 409, "COMMIT_FAILED"},
		{httpx.Validation("Duplicate manifest path."), 400, "DUPLICATE_PATH"},
		{httpx.Validation("Duplicate manifest file ID."), 400, "DUPLICATE_FILE_ID"},
		{httpx.Validation("Path must be a canonical vault-relative path."), 400, "INVALID_PATH"},
		{httpx.Validation("anything"), 400, "INVALID_MANIFEST"},
		{errors.New("db exploded"), 500, "INTERNAL_ERROR"},
	}
	for _, c := range cases {
		h := httpx.Handle(func(w http.ResponseWriter, r *http.Request) error { return c.err })
		r := testutil.Do(h, "GET", "/", nil, nil)
		if r.Status != c.status || !strings.Contains(r.Text(), `"code":"`+c.code+`"`) {
			t.Fatalf("%v: %d %s", c.err, r.Status, r.Text())
		}
		if httpx.StatusFromError(c.err) != c.status {
			t.Fatalf("StatusFromError(%v)", c.err)
		}
		if strings.Contains(r.Text(), "exploded") {
			t.Fatal("internal error text leaked")
		}
	}
	// A panic becomes a 500 envelope too.
	h := httpx.Handle(func(w http.ResponseWriter, r *http.Request) error { panic(errors.New("kaboom")) })
	if r := testutil.Do(h, "GET", "/", nil, nil); r.Status != 500 {
		t.Fatalf("panic: %d", r.Status)
	}
}

func TestIsEmail(t *testing.T) {
	good := []string{"a@b.co", "owner@example.com", "a.b+c@sub.example.org", "x_y-z@e-x.io"}
	bad := []string{"", "a", "a@b", ".a@b.co", "a..b@b.co", "a@b..co", "a@-b.co", "a b@b.co", "a@b.c", "a@b.co\n", "ü@b.co"}
	for _, s := range good {
		if !httpx.IsEmail(s) {
			t.Errorf("%q should be valid", s)
		}
	}
	for _, s := range bad {
		if httpx.IsEmail(s) {
			t.Errorf("%q should be invalid", s)
		}
	}
}

func TestTokenIsActiveAndCanAccessVault(t *testing.T) {
	now := int64(100)
	exp := func(v int64) *int64 { return &v }
	if !httpx.TokenIsActive(&vm.ApiToken{}, now) || !httpx.TokenIsActive(&vm.ApiToken{ExpiresAt: exp(101)}, now) {
		t.Fatal("active")
	}
	if httpx.TokenIsActive(&vm.ApiToken{ExpiresAt: exp(100)}, now) || httpx.TokenIsActive(&vm.ApiToken{RevokedAt: exp(1)}, now) {
		t.Fatal("inactive")
	}
	vault := &vm.Vault{ID: "v", OwnerUserID: "u"}
	vid, other := "v", "w"
	tok := func(vaultID *string, scopes ...vm.ApiTokenScope) *httpx.Principal {
		return &httpx.Principal{Kind: httpx.PrincipalToken, User: vm.User{ID: "u"}, Token: &vm.ApiToken{VaultID: &vid, Scopes: scopes}}
	}
	if !httpx.CanAccessVault(&httpx.Principal{Kind: httpx.PrincipalSession, User: vm.User{ID: "u"}}, vault, vm.ScopeVaultWrite) {
		t.Fatal("session owner has every scope")
	}
	if httpx.CanAccessVault(&httpx.Principal{Kind: httpx.PrincipalSession, User: vm.User{ID: "x"}}, vault, vm.ScopeVaultReadMetadata) {
		t.Fatal("foreign session")
	}
	if !httpx.CanAccessVault(tok(&vid, vm.ScopeVaultUpload), vault, vm.ScopeVaultUpload) {
		t.Fatal("token with scope")
	}
	if httpx.CanAccessVault(tok(&vid, vm.ScopeVaultUpload), vault, vm.ScopeVaultReadMetadata) {
		t.Fatal("scope missing")
	}
	p := tok(&vid, vm.ScopeVaultUpload)
	p.Token.VaultID = &other
	if httpx.CanAccessVault(p, vault, vm.ScopeVaultUpload) {
		t.Fatal("other vault")
	}
	p.Token.VaultID = nil
	if httpx.CanAccessVault(p, vault, vm.ScopeVaultUpload) {
		t.Fatal("unbound token")
	}
}

func TestStoreBlobIfAbsent(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := context.Background()
	data := []byte("hello")
	const hash = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
	stored, err := httpx.StoreBlobIfAbsent(ctx, f.Deps, hash, bytes.NewReader(data), 5, "text/markdown")
	if err != nil || !stored {
		t.Fatalf("first: %v %v", stored, err)
	}
	if m, _ := f.DB.Blobs().FindByHash(ctx, hash); m == nil || m.Size != 5 || m.MimeType == nil || *m.MimeType != "text/markdown" || m.CreatedAt != testutil.FixedNow {
		t.Fatalf("metadata %+v", m)
	}
	stored, err = httpx.StoreBlobIfAbsent(ctx, f.Deps, hash, bytes.NewReader(data), 5, "")
	if err != nil || stored {
		t.Fatalf("second: %v %v", stored, err)
	}
	// Size mismatch with recorded metadata, or missing bytes, is a 409 COMMIT_FAILED.
	_, err = httpx.StoreBlobIfAbsent(ctx, f.Deps, hash, bytes.NewReader(data), 6, "")
	var fail *httpx.ApiFailure
	if !errors.As(err, &fail) || fail.Status != 409 || fail.Code != protocol.CodeCommitFailed {
		t.Fatalf("size mismatch: %v", err)
	}
	_ = f.Blobs.Delete(ctx, hash)
	if _, err = httpx.StoreBlobIfAbsent(ctx, f.Deps, hash, bytes.NewReader(data), 5, ""); !errors.As(err, &fail) {
		t.Fatalf("missing bytes: %v", err)
	}
	// A wrong hash is rejected by the store and no metadata is recorded.
	bad := strings.Repeat("0", 64)
	if _, err = httpx.StoreBlobIfAbsent(ctx, f.Deps, bad, bytes.NewReader(data), 5, ""); err == nil {
		t.Fatal("hash mismatch must fail")
	}
	if m, _ := f.DB.Blobs().FindByHash(ctx, bad); m != nil {
		t.Fatal("no metadata for rejected blob")
	}
}

func TestSearchVaultFallbackAndIndexService(t *testing.T) {
	f := testutil.NewFixture(t)
	ctx := context.Background()
	_ = f.DB.Users().Insert(ctx, vm.User{ID: "u", Email: "a@b.co"})
	_ = f.DB.Vaults().Insert(ctx, vm.Vault{ID: "v", OwnerUserID: "u", Name: "V", SyncMode: vm.SyncModeTephra})
	_ = f.DB.Blobs().Insert(ctx, vm.BlobMetadata{Hash: "h", Size: 1, CreatedAt: 1})
	for i, p := range []string{"Notes/Alpha.md", "Notes/beta.md", "alphabet.md"} {
		_ = f.DB.VaultFiles().Upsert(ctx, vm.CurrentVaultFile{FileID: string(rune('a' + i)), VaultID: "v", Path: p, BlobHash: "h", Kind: vm.KindMarkdown})
	}
	got, err := httpx.SearchVault(ctx, f.Deps, "v", "ALPHA", 10)
	if err != nil || len(got) != 2 {
		t.Fatalf("got %v %v", got, err)
	}
	if got, _ := httpx.SearchVault(ctx, f.Deps, "v", "alpha", 1); len(got) != 1 {
		t.Fatal("limit")
	}
	if got, _ := httpx.SearchVault(ctx, f.Deps, "v", "zzz", 5); got == nil || len(got) != 0 {
		t.Fatal("empty result must be non-nil")
	}
	f.Deps.IndexService = fakeSearcher{}
	if got, _ := httpx.SearchVault(ctx, f.Deps, "v", "q", 5); len(got) != 1 || got[0] != "from-index" {
		t.Fatalf("index service: %v", got)
	}
}

type fakeSearcher struct{}

func (fakeSearcher) Search(context.Context, httpx.SearchInput) ([]any, error) {
	return []any{"from-index"}, nil
}

func TestJSONBodyLimits(t *testing.T) {
	h := httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		v, err := httpx.JSONBody(r)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, 200, map[string]any{"v": v})
		return nil
	})
	if r := testutil.Do(h, "POST", "/", nil, []byte(`{"a":[1,2]}`)); r.Text() != `{"v":{"a":[1,2]}}` {
		t.Fatal(r.Text())
	}
	for _, body := range []string{``, `{`, `{} {}`, `nul`} {
		r := testutil.Do(h, "POST", "/", nil, []byte(body))
		if r.Status != 400 || !strings.Contains(r.Text(), "Request body must be valid JSON.") {
			t.Fatalf("%q: %d %s", body, r.Status, r.Text())
		}
	}
	r := testutil.Do(h, "POST", "/", testutil.Headers{"Content-Length": "2097153"}, []byte(`{}`))
	if r.Status != 413 {
		t.Fatalf("declared: %d", r.Status)
	}
}
