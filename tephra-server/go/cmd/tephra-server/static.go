package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"
)

// Content types as sent by Hono's serveStatic (text types carry charset).
var staticTypes = map[string]string{
	".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
	".map": "application/json; charset=utf-8", ".txt": "text/plain; charset=utf-8",
	".md": "text/markdown; charset=utf-8", ".xml": "application/xml; charset=utf-8",
	".svg": "image/svg+xml; charset=utf-8", ".webmanifest": "application/manifest+json; charset=utf-8",
	".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
	".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
	".woff": "font/woff", ".woff2": "font/woff2", ".ttf": "font/ttf", ".otf": "font/otf",
	".wasm": "application/wasm", ".pdf": "application/pdf",
}

// staticFiles serves the built web app like the Hono chain in main.ts:
// /favicon.ico -> logo-main.svg, existing files (index.html for directories),
// otherwise the SPA fallback index.html. Files are streamed (never read into
// memory) and, like Node, carry no cache headers.
type staticFiles struct{ root string }

func (s staticFiles) serveFile(w http.ResponseWriter, r *http.Request, p string) bool {
	f, err := os.Open(p)
	if err != nil {
		return false
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil || st.IsDir() {
		return false
	}
	ct, ok := staticTypes[strings.ToLower(filepath.Ext(p))]
	if !ok {
		ct = "application/octet-stream"
	}
	w.Header().Set("Content-Type", ct)
	// Zero modtime: no Last-Modified / conditional handling, as in Node.
	http.ServeContent(w, r, "", zeroTime, f)
	return true
}

// resolve maps a request path to a file under root. Cleaning the rooted path
// removes any ".." segments so the result cannot escape root.
func (s staticFiles) resolve(urlPath string) (string, bool) {
	if strings.ContainsAny(urlPath, "\x00\\") {
		return "", false
	}
	clean := path.Clean("/" + urlPath)
	p := filepath.Join(s.root, filepath.FromSlash(clean))
	if st, err := os.Stat(p); err == nil && st.IsDir() {
		p = filepath.Join(p, "index.html")
	}
	return p, true
}

func (s staticFiles) handle(w http.ResponseWriter, r *http.Request) {
	if p, ok := s.resolve(r.URL.Path); ok && s.serveFile(w, r, p) {
		return
	}
	if !s.serveFile(w, r, filepath.Join(s.root, "index.html")) {
		w.Header().Set("Content-Type", "text/plain; charset=UTF-8")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte("404 Not Found"))
	}
}

// register adds the GET catch-alls (HEAD is routed to GET by net/http).
// Specific API patterns win over "GET /", so only unmatched GETs land here.
func (s staticFiles) register(mux *http.ServeMux) {
	mux.HandleFunc("GET /favicon.ico", func(w http.ResponseWriter, r *http.Request) {
		if !s.serveFile(w, r, filepath.Join(s.root, "logo-main.svg")) {
			s.handle(w, r)
		}
	})
	mux.HandleFunc("GET /", s.handle)
}

var zeroTime time.Time
