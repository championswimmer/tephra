package httpx

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestEmptyResponsesGetHonoDefaultContentType(t *testing.T) {
	h := RequestLogging(func() string { return "id" }, &discard{}, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/204":
			w.WriteHeader(http.StatusNoContent)
		case "/json":
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte("{}"))
		}
	}))
	for path, want := range map[string]string{"/204": "text/plain; charset=UTF-8", "/json": "application/json"} {
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, httptest.NewRequest("GET", path, nil))
		if got := rec.Header().Get("Content-Type"); got != want {
			t.Errorf("%s: %q want %q", path, got, want)
		}
	}
}

type discard struct{}

func (*discard) Write(b []byte) (int, error) { return len(b), nil }
