package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestStatic(t *testing.T) {
	root := t.TempDir()
	w := func(name, body string) {
		p := filepath.Join(root, name)
		_ = os.MkdirAll(filepath.Dir(p), 0o755)
		if err := os.WriteFile(p, []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	w("index.html", "INDEX")
	w("logo-main.svg", "<svg/>")
	w("assets/a.js", "js")
	secret := filepath.Join(filepath.Dir(root), "secret.txt")
	_ = os.WriteFile(secret, []byte("SECRET"), 0o644)
	mux := http.NewServeMux()
	staticFiles{root: root}.register(mux)
	get := func(target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest("GET", target, nil))
		return rec
	}
	for target, want := range map[string]string{
		"/": "INDEX", "/index.html": "INDEX", "/assets/a.js": "js", "/favicon.ico": "<svg/>",
		"/nope/route": "INDEX", "/assets": "INDEX", "/%2e%2e/secret.txt": "INDEX",
		"/api/unknown": "INDEX",
	} {
		if rec := get(target); rec.Code != 200 || rec.Body.String() != want {
			t.Errorf("%s: %d %q want %q", target, rec.Code, rec.Body.String(), want)
		}
	}
	// net/http cleans dot segments with a redirect before our handler runs.
	for _, target := range []string{"/../secret.txt", "/assets/../../secret.txt"} {
		if rec := get(target); rec.Body.String() == "SECRET" || rec.Code != 307 {
			t.Errorf("%s: %d %q", target, rec.Code, rec.Body.String())
		}
	}
	if ct := get("/assets/a.js").Header().Get("Content-Type"); ct != "text/javascript; charset=utf-8" {
		t.Error(ct)
	}
	if ct := get("/favicon.ico").Header().Get("Content-Type"); ct != "image/svg+xml; charset=utf-8" {
		t.Error(ct)
	}
	if cc := get("/").Header().Get("Cache-Control"); cc != "" {
		t.Error(cc)
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest("POST", "/x", nil))
	if rec.Code == 200 {
		t.Error("POST must not hit static")
	}
}
