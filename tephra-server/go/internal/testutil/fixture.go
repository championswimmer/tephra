package testutil

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/core"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
)

// FixedNow is the default fake-clock time (matches the TS fixture).
const FixedNow int64 = 1_700_000_000_000

// BootstrapSecret is the bootstrap token configured by NewFixture.
const BootstrapSecret = "bootstrap-secret"

// MemoryBlobStore is an in-memory blobstore.Store that, like the real stores,
// verifies size and SHA-256 on Put.
type MemoryBlobStore struct {
	mu     sync.Mutex
	values map[string][]byte
}

// NewMemoryBlobStore returns an empty store.
func NewMemoryBlobStore() *MemoryBlobStore { return &MemoryBlobStore{values: map[string][]byte{}} }

var hashRE = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (m *MemoryBlobStore) Has(_ context.Context, hash string) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	_, ok := m.values[hash]
	return ok, nil
}

func (m *MemoryBlobStore) Put(_ context.Context, in blobstore.PutInput) error {
	if !hashRE.MatchString(in.Hash) {
		return blobstore.ErrInvalidHash
	}
	if in.Size < 0 {
		return blobstore.ErrInvalidSize
	}
	data, err := io.ReadAll(in.Body)
	if err != nil {
		return err
	}
	if int64(len(data)) != in.Size {
		return blobstore.ErrSizeMismatch
	}
	sum := sha256.Sum256(data)
	if hex.EncodeToString(sum[:]) != in.Hash {
		return blobstore.ErrHashMismatch
	}
	m.mu.Lock()
	defer m.mu.Unlock()
	if old, ok := m.values[in.Hash]; ok {
		if len(old) != len(data) {
			return blobstore.ErrExistingMismatch
		}
		return nil
	}
	m.values[in.Hash] = data
	return nil
}

func (m *MemoryBlobStore) Get(_ context.Context, hash string) (*blobstore.ReadResult, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.values[hash]
	if !ok {
		return nil, blobstore.ErrNotFound
	}
	return &blobstore.ReadResult{Body: io.NopCloser(bytes.NewReader(v)), Size: int64(len(v))}, nil
}

func (m *MemoryBlobStore) Delete(_ context.Context, hash string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	delete(m.values, hash)
	return nil
}

// Count returns the number of stored blobs; Bytes returns one blob's content.
func (m *MemoryBlobStore) Count() int { m.mu.Lock(); defer m.mu.Unlock(); return len(m.values) }
func (m *MemoryBlobStore) Bytes(hash string) ([]byte, bool) {
	m.mu.Lock()
	defer m.mu.Unlock()
	v, ok := m.values[hash]
	return v, ok
}

// PlainHasher is the TS test hasher: hash = "hash:"+password (fast, no scrypt).
type PlainHasher struct{}

func (PlainHasher) Hash(p string) (string, error)    { return "hash:" + p, nil }
func (PlainHasher) Verify(p, h string) (bool, error) { return h == "hash:"+p, nil }

// CounterIDs generates "id-1", "id-2", ... (concurrency safe).
type CounterIDs struct{ n atomic.Int64 }

func (c *CounterIDs) Generate() string { return fmt.Sprintf("id-%d", c.n.Add(1)) }

// SyncBuffer is a concurrency-safe bytes.Buffer used to capture request logs.
type SyncBuffer struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (s *SyncBuffer) Write(p []byte) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.b.Write(p)
}
func (s *SyncBuffer) String() string { s.mu.Lock(); defer s.mu.Unlock(); return s.b.String() }
func (s *SyncBuffer) Reset()         { s.mu.Lock(); defer s.mu.Unlock(); s.b.Reset() }

// Fixture bundles the test dependencies.
type Fixture struct {
	Deps  httpx.Dependencies
	DB    db.Database     // same value as Deps.Database
	Mem   *MemoryDatabase // non-nil only for the in-memory database
	Blobs *MemoryBlobStore
	Clock *core.FakeClock
	Logs  *SyncBuffer
}

// Option customises NewFixture.
type Option func(*Fixture)

// WithDatabase replaces the in-memory database (e.g. with SQLite).
func WithDatabase(d db.Database) Option {
	return func(f *Fixture) { f.Deps.Database = d; f.DB = d; f.Mem = nil }
}

// WithIndexService sets Dependencies.IndexService.
func WithIndexService(s any) Option { return func(f *Fixture) { f.Deps.IndexService = s } }

// WithMaxBlobBytes sets Dependencies.MaxBlobBytes.
func WithMaxBlobBytes(n int64) Option { return func(f *Fixture) { f.Deps.MaxBlobBytes = n } }

// WithClock sets the clock (default: FakeClock at FixedNow).
func WithClock(c core.Clock) Option { return func(f *Fixture) { f.Deps.Clock = c } }

// WithHasher replaces the password hasher (default PlainHasher).
func WithHasher(h core.PasswordHasher) Option { return func(f *Fixture) { f.Deps.PasswordHasher = h } }

// WithDeps lets a test tweak the dependency struct directly.
func WithDeps(fn func(*httpx.Dependencies)) Option { return func(f *Fixture) { fn(&f.Deps) } }

// NewFixture mirrors (with TEPHRA_TEST_DB=sqlite the database is a temp-file SQLite instead) fixture() from apps/api/tests/helpers.ts: memory
// database and blob store, fake clock at FixedNow, ids "id-N", plain hasher,
// bootstrap token "bootstrap-secret", insecure cookies. Request logs are
// captured in Logs instead of stdout.
func NewFixture(t testing.TB, opts ...Option) *Fixture {
	clock := core.NewFakeClock(FixedNow)
	mem := NewMemoryDatabase()
	blobs := NewMemoryBlobStore()
	logs := &SyncBuffer{}
	f := &Fixture{DB: mem, Mem: mem, Blobs: blobs, Clock: clock, Logs: logs}
	f.Deps = httpx.Dependencies{
		Database: mem, BlobStore: blobs, Clock: clock, IDs: &CounterIDs{}, PasswordHasher: PlainHasher{},
		BootstrapToken: BootstrapSecret, SecureCookies: false, LogWriter: logs,
	}
	if UseSQLite() {
		WithDatabase(openSQLite(t))(f)
	}
	for _, o := range opts {
		o(f)
	}
	return f
}

// Response is a recorded HTTP response.
type Response struct {
	Status int
	Header http.Header
	Body   []byte
}

// Text returns the body as a string.
func (r Response) Text() string { return string(r.Body) }

// Headers is a header map shorthand.
type Headers map[string]string

// Do performs a request against h without a network and returns the response.
func Do(h http.Handler, method, path string, headers Headers, body []byte) Response {
	var rd io.Reader
	if body != nil {
		rd = bytes.NewReader(body)
	}
	req := httptest.NewRequest(method, path, rd)
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	res := rec.Result()
	defer res.Body.Close()
	b, _ := io.ReadAll(res.Body)
	return Response{Status: res.StatusCode, Header: res.Header, Body: b}
}

// DoJSON is Do with a JSON string body.
func DoJSON(h http.Handler, method, path string, headers Headers, body string) Response {
	return Do(h, method, path, headers, []byte(body))
}

var sessionCookieRE = regexp.MustCompile(`tephra_session=([^;,]+)`)

// SessionFromSetCookie extracts the raw session cookie value from Set-Cookie headers.
func SessionFromSetCookie(h http.Header) string {
	m := sessionCookieRE.FindStringSubmatch(strings.Join(h.Values("Set-Cookie"), ", "))
	if m == nil {
		return ""
	}
	return m[1]
}

// Session is a bootstrapped owner with a vault and a plugin API token.
type Session struct {
	*Fixture
	App            http.Handler
	VaultID        string
	VaultName      string
	Token          string // raw tpt_ API token for the vault
	BrowserHeaders Headers
	CSRF           string
}

// Setup mirrors setup() in helpers.ts: bootstrap the owner (asserting the
// second bootstrap is rejected), log in, create "Test Vault" and a token.
// newApp is api.NewApp (passed in to avoid an import cycle).
func Setup(t testing.TB, newApp func(httpx.Dependencies) http.Handler, opts ...Option) *Session {
	t.Helper()
	f := NewFixture(t, opts...)
	app := newApp(f.Deps)
	js := Headers{"content-type": "application/json"}
	if r := DoJSON(app, "POST", "/api/v1/auth/bootstrap", js, `{"token":"bootstrap-secret","email":"owner@example.com","password":"password-123"}`); r.Status != 201 {
		t.Fatalf("bootstrap status %d: %s", r.Status, r.Text())
	}
	if r := DoJSON(app, "POST", "/api/v1/auth/bootstrap", js, `{"token":"bootstrap-secret","email":"other@example.com","password":"password-123"}`); r.Status != 409 {
		t.Fatalf("second bootstrap status %d: %s", r.Status, r.Text())
	}
	login := DoJSON(app, "POST", "/api/v1/auth/login", js, `{"email":"owner@example.com","password":"password-123"}`)
	var lb struct {
		CSRFToken string `json:"csrfToken"`
	}
	JSON(t, login, &lb)
	session := SessionFromSetCookie(login.Header)
	bh := Headers{
		"cookie":        "tephra_session=" + session + "; tephra_csrf=" + lb.CSRFToken,
		"x-tephra-csrf": lb.CSRFToken,
		"content-type":  "application/json",
	}
	vr := DoJSON(app, "POST", "/api/v1/vaults", bh, `{"name":"Test Vault"}`)
	var vb struct {
		Vault struct {
			ID, Name string
		} `json:"vault"`
	}
	JSON(t, vr, &vb)
	tr := DoJSON(app, "POST", "/api/v1/vaults/"+vb.Vault.ID+"/tokens", bh, `{"name":"Plugin"}`)
	var tb struct {
		Value string `json:"value"`
	}
	JSON(t, tr, &tb)
	return &Session{Fixture: f, App: app, VaultID: vb.Vault.ID, VaultName: vb.Vault.Name, Token: tb.Value, BrowserHeaders: bh, CSRF: lb.CSRFToken}
}

// JSON decodes a response body into v, failing the test on error.
func JSON(t testing.TB, r Response, v any) {
	t.Helper()
	if err := jsonUnmarshal(r.Body, v); err != nil {
		t.Fatalf("decode %q: %v", r.Text(), err)
	}
}

// Bearer returns an Authorization header map.
func Bearer(token string) Headers { return Headers{"authorization": "Bearer " + token} }
