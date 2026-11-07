package httpx

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

type ctxKey int

const (
	keyRequestID ctxKey = iota
	keyPrincipal
	keyLogContext
)

var requestIDPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

// LogContext carries the extra allowlisted fields handlers attach to the
// request log line (vault_id, revision, ...). Insertion order is preserved.
type LogContext struct {
	mu   sync.Mutex
	keys []string
	vals map[string]any
}

// Set adds or replaces a field. Never put secrets or vault content here.
func (c *LogContext) Set(key string, value any) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.vals == nil {
		c.vals = map[string]any{}
	}
	if _, ok := c.vals[key]; !ok {
		c.keys = append(c.keys, key)
	}
	c.vals[key] = value
}

// LogFields returns the request's LogContext (a detached one if r did not pass
// through the logging middleware, so handlers can always call .Set safely).
func LogFields(r *http.Request) *LogContext {
	if c, ok := r.Context().Value(keyLogContext).(*LogContext); ok {
		return c
	}
	return &LogContext{}
}

// RequestID returns the request id assigned by the logging middleware.
func RequestID(r *http.Request) string {
	if id, ok := r.Context().Value(keyRequestID).(string); ok {
		return id
	}
	return ""
}

// statusWriter records the status and whether the response has started.
type statusWriter struct {
	http.ResponseWriter
	status  int
	started bool
}

// defaultType mirrors Hono, which labels every response without an explicit
// Content-Type (empty 204/304/redirect/405 bodies included) text/plain.
func (s *statusWriter) defaultType() {
	if h := s.ResponseWriter.Header(); h.Get("Content-Type") == "" {
		h.Set("Content-Type", "text/plain; charset=UTF-8")
	}
}

func (s *statusWriter) WriteHeader(code int) {
	if !s.started {
		s.defaultType()
		s.started = true
		s.status = code
	}
	s.ResponseWriter.WriteHeader(code)
}

func (s *statusWriter) Write(b []byte) (int, error) {
	if !s.started {
		s.defaultType()
		s.started = true
		s.status = http.StatusOK
	}
	return s.ResponseWriter.Write(b)
}

func (s *statusWriter) Flush() {
	if f, ok := s.ResponseWriter.(http.Flusher); ok {
		if !s.started {
			s.defaultType()
			s.started = true
			s.status = http.StatusOK
		}
		f.Flush()
	}
}

// Started reports whether headers were sent.
func (s *statusWriter) Started() bool { return s.started }

// Unwrap supports http.ResponseController.
func (s *statusWriter) Unwrap() http.ResponseWriter { return s.ResponseWriter }

func resolveRequestID(incoming string, generate func() string) string {
	c := strings.TrimSpace(incoming)
	if c != "" && len(c) <= 128 && requestIDPattern.MatchString(c) {
		return c
	}
	return generate()
}

// RequestLogging assigns the request id (header X-Request-Id), then emits one
// structured JSON log line per request. Only method, path, status, duration
// and handler-attached allowlisted fields are logged: bearer tokens, cookies,
// passwords and bodies never are.
func RequestLogging(generate func() string, out io.Writer, next http.Handler) http.Handler {
	if out == nil {
		out = os.Stdout
	}
	var outMu sync.Mutex
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		id := resolveRequestID(r.Header.Get("X-Request-Id"), generate)
		lc := &LogContext{}
		ctx := context.WithValue(r.Context(), keyRequestID, id)
		ctx = context.WithValue(ctx, keyLogContext, lc)
		r = r.WithContext(ctx)
		w.Header().Set("X-Request-Id", id)
		sw := &statusWriter{ResponseWriter: w, status: http.StatusOK}
		start := time.Now()
		defer func() {
			status := sw.status
			if p := recover(); p != nil {
				if p == http.ErrAbortHandler {
					panic(p)
				}
				if !sw.started {
					WriteError(sw, r, Fail(500, "INTERNAL_ERROR", "An internal error occurred."))
				}
				status = sw.status
			}
			d := float64(time.Since(start).Nanoseconds()) / 1e6
			d = float64(int64(d*1000+0.5)) / 1000
			var b bytes.Buffer
			b.WriteString(`{"request_id":`)
			writeJSONValue(&b, id)
			b.WriteString(`,"method":`)
			writeJSONValue(&b, r.Method)
			b.WriteString(`,"path":`)
			writeJSONValue(&b, r.URL.Path)
			b.WriteString(`,"status":`)
			writeJSONValue(&b, status)
			b.WriteString(`,"duration_ms":`)
			writeJSONValue(&b, d)
			lc.mu.Lock()
			for _, k := range lc.keys {
				if k == "request_id" || k == "method" || k == "path" || k == "status" || k == "duration_ms" {
					continue
				}
				b.WriteByte(',')
				writeJSONValue(&b, k)
				b.WriteByte(':')
				writeJSONValue(&b, lc.vals[k])
			}
			lc.mu.Unlock()
			b.WriteString("}\n")
			outMu.Lock()
			_, _ = out.Write(b.Bytes())
			outMu.Unlock()
		}()
		next.ServeHTTP(sw, r)
	})
}

func writeJSONValue(b *bytes.Buffer, v any) {
	if raw, err := MarshalJSON(v); err == nil {
		b.Write(raw)
	} else {
		b.WriteString("null")
	}
}
