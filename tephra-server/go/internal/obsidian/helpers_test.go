package obsidian

import (
	"context"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/api"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

var bg = context.Background()

// eventually polls cond every 10ms for up to 5s (vitest expect.poll).
func eventually(t *testing.T, msg string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for: %s", msg)
}

func wantCode(t *testing.T, err error, code protocol.ApiErrorCode) {
	t.Helper()
	f := asFailure(err)
	if f == nil || f.Code != code {
		t.Fatalf("want failure %s, got %v", code, err)
	}
}

// nodeBinary finds a real node for the subprocess-launcher tests.
func nodeBinary(t *testing.T) string {
	t.Helper()
	if p := os.Getenv("TEPHRA_TEST_NODE"); p != "" {
		return p
	}
	if p, err := exec.LookPath("node"); err == nil {
		return p
	}
	if home, err := os.UserHomeDir(); err == nil {
		if m, _ := filepath.Glob(filepath.Join(home, ".nvm/versions/node/*/bin/node")); len(m) > 0 {
			return m[len(m)-1]
		}
	}
	t.Skip("node is not available (set TEPHRA_TEST_NODE)")
	return ""
}

// ---------------------------------------------------------------- fake client

// fakeClient is the OfficialClient double (FakeClient in the TS tests). It
// never touches the network.
type fakeClient struct {
	mu              sync.Mutex
	active          int
	events          []string
	pendingDownload bool
	failure         error
	ensureErrs      []error
	counts          map[string]int
	t               *testing.T
}

func newFakeClient(t *testing.T) *fakeClient {
	return &fakeClient{pendingDownload: true, counts: map[string]int{}, t: t}
}

func (f *fakeClient) count(name string) int { f.mu.Lock(); defer f.mu.Unlock(); return f.counts[name] }
func (f *fakeClient) Active() int           { f.mu.Lock(); defer f.mu.Unlock(); return f.active }
func (f *fakeClient) Events() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.events...)
}
func (f *fakeClient) setFailure(err error) { f.mu.Lock(); f.failure = err; f.mu.Unlock() }
func (f *fakeClient) bump(name string)     { f.mu.Lock(); f.counts[name]++; f.mu.Unlock() }
func (f *fakeClient) event(e string)       { f.mu.Lock(); f.events = append(f.events, e); f.mu.Unlock() }

func (f *fakeClient) HasAuth(_ context.Context, p VaultPaths) (bool, error) {
	info, err := os.Stat(filepath.Join(ClientStateRoot(p), "auth_token"))
	return err == nil && info.Mode().IsRegular(), nil
}

func (f *fakeClient) CopyAuth(_ context.Context, source, destination VaultPaths) error {
	if err := os.MkdirAll(ClientStateRoot(destination), 0o700); err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(ClientStateRoot(source), "auth_token"))
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(ClientStateRoot(destination), "auth_token"), data, 0o600)
}

func (f *fakeClient) Ensure(context.Context) error {
	f.bump("ensure")
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.ensureErrs) > 0 {
		err := f.ensureErrs[0]
		f.ensureErrs = f.ensureErrs[1:]
		return err
	}
	return nil
}

func (f *fakeClient) Remotes(context.Context, VaultPaths) ([]httpx.ObsidianRemote, error) {
	f.bump("remotes")
	return []httpx.ObsidianRemote{{ID: "remote-1", Name: "Remote vault", Region: "eu"}}, nil
}

func (f *fakeClient) Login(_ context.Context, p VaultPaths, in httpx.ObsidianLogin) error {
	f.bump("login")
	if err := os.MkdirAll(ClientStateRoot(p), 0o700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(ClientStateRoot(p), "auth_token"), []byte("saved-token:"+in.Email), 0o600)
}

func (f *fakeClient) Setup(_ context.Context, p VaultPaths, _ httpx.ObsidianSetup) error {
	f.bump("setup")
	f.event("setup")
	dir := filepath.Join(ClientStateRoot(p), "sync", "remote-1")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(dir, "config.json"), []byte("{}"), 0o600); err != nil {
		return err
	}
	f.mu.Lock()
	f.pendingDownload = true
	f.mu.Unlock()
	return nil
}

func (f *fakeClient) Configure(context.Context, VaultPaths, string) error {
	f.bump("configure")
	return nil
}

func (f *fakeClient) Sync(ctx context.Context, p VaultPaths, continuous bool) error {
	f.bump("sync")
	f.mu.Lock()
	failure := f.failure
	f.mu.Unlock()
	if failure != nil {
		return failure
	}
	if !continuous {
		f.event("sync")
		f.mu.Lock()
		pending := f.pendingDownload
		f.pendingDownload = false
		f.mu.Unlock()
		if pending {
			return os.WriteFile(filepath.Join(p.Vault, "Note.md"), []byte("# Original\r\n日本語\r\n"), 0o644)
		}
		return nil
	}
	f.mu.Lock()
	f.events = append(f.events, "continuous")
	f.active++
	f.mu.Unlock()
	<-ctx.Done()
	f.mu.Lock()
	f.active--
	f.events = append(f.events, "stopped")
	f.mu.Unlock()
	return nil
}

func (f *fakeClient) Unlink(context.Context, VaultPaths) error {
	f.bump("unlink")
	if f.Active() != 0 {
		f.t.Error("unlink while a child was still active")
	}
	f.event("unlink")
	return nil
}

func (f *fakeClient) Logout(context.Context, VaultPaths) error {
	f.bump("logout")
	if f.Active() != 0 {
		f.t.Error("logout while a child was still active")
	}
	f.event("logout")
	return nil
}

func (f *fakeClient) Close() {}

// ---------------------------------------------------------------- fixtures

// settingsHidingDB lets a test make ObsidianSync().Find report "no row".
type settingsHidingDB struct {
	db.Database
	hidden bool
}

func (d *settingsHidingDB) ObsidianSync() db.ObsidianSyncRepository {
	return hidingRepo{d.Database.ObsidianSync(), d}
}

type hidingRepo struct {
	db.ObsidianSyncRepository
	d *settingsHidingDB
}

func (h hidingRepo) Find(ctx context.Context, id string) (*vm.ObsidianSyncSettings, error) {
	if h.d.hidden {
		return nil, nil
	}
	return h.ObsidianSyncRepository.Find(ctx, id)
}

// gatedDB blocks NoteIndex().GetState until released (to hold an import open).
type gatedDB struct {
	db.Database
	mu       sync.Mutex
	gate     chan struct{}
	scanning bool
}

func (g *gatedDB) arm() { g.mu.Lock(); g.gate = make(chan struct{}); g.mu.Unlock() }
func (g *gatedDB) release() {
	g.mu.Lock()
	if g.gate != nil {
		close(g.gate)
	}
	g.mu.Unlock()
}
func (g *gatedDB) isScanning() bool { g.mu.Lock(); defer g.mu.Unlock(); return g.scanning }
func (g *gatedDB) NoteIndex() db.NoteIndexRepository {
	return gatedIndex{g.Database.NoteIndex(), g}
}

type gatedIndex struct {
	db.NoteIndexRepository
	g *gatedDB
}

func (i gatedIndex) GetState(ctx context.Context, id string) (*vm.VaultIndexState, error) {
	i.g.mu.Lock()
	gate := i.g.gate
	if gate != nil {
		i.g.scanning = true
	}
	i.g.mu.Unlock()
	if gate != nil {
		<-gate
	}
	return i.NoteIndexRepository.GetState(ctx, id)
}

type native struct {
	*testutil.Session
	root   string
	client *fakeClient
	svc    *NativeSyncService
	vault  vm.Vault
	paths  VaultPaths
	opts   Options
}

// newService builds a service on the fixture's root and registers Close so it
// runs before the temp dir is removed.
func (n *native) newService(t *testing.T, mutate func(*Options)) *NativeSyncService {
	opts := Options{Root: n.root, Client: n.client, ScanInterval: 20 * time.Millisecond, RetryInterval: 50 * time.Millisecond}
	if mutate != nil {
		mutate(&opts)
	}
	svc := NewNativeSyncService(n.Deps, opts)
	t.Cleanup(svc.Close)
	return svc
}

func (n *native) rebuild() { n.App = api.NewApp(n.Deps) }

func nativeFixture(t *testing.T, mutate func(*Options), wrap func(db.Database) db.Database) *native {
	t.Helper()
	root := t.TempDir() // registered first, so removed after service Close
	s := testutil.Setup(t, func(d httpx.Dependencies) http.Handler { return api.NewApp(d) })
	if wrap != nil {
		s.Deps.Database = wrap(s.Deps.Database)
		s.DB = s.Deps.Database
	}
	n := &native{Session: s, root: root, client: newFakeClient(t)}
	n.svc = n.newService(t, mutate)
	s.Deps.ObsidianSync = n.svc
	n.rebuild()
	found, err := s.DB.Vaults().FindByID(bg, s.VaultID)
	if err != nil || found == nil {
		t.Fatal("vault missing", err)
	}
	n.vault = *found
	n.vault.SyncMode = vm.SyncModeObsidian
	if s.Mem != nil {
		if err := s.DB.Vaults().Update(bg, n.vault); err != nil {
			t.Fatal(err)
		}
	} else {
		// SQLite makes sync_mode immutable (trigger), so recreate the vault
		// in obsidian mode instead of updating it. Tokens cascade with it;
		// re-insert the plugin tokens so s.Token keeps working.
		tokens, err := s.DB.ApiTokens().ListByVault(bg, n.vault.ID)
		if err != nil {
			t.Fatal(err)
		}
		if err := s.DB.Vaults().Delete(bg, n.vault.ID); err != nil {
			t.Fatal(err)
		}
		if err := s.DB.Vaults().Insert(bg, n.vault); err != nil {
			t.Fatal(err)
		}
		for _, tok := range tokens {
			if err := s.DB.ApiTokens().Insert(bg, tok); err != nil {
				t.Fatal(err)
			}
		}
	}
	if err := s.DB.ObsidianSync().Upsert(bg, httpx.InitialObsidianSettings(n.vault.ID)); err != nil {
		t.Fatal(err)
	}
	n.paths = mustVaultPaths(root, n.vault.ID)
	return n
}

func (n *native) status(t *testing.T) vm.ObsidianSyncSettings {
	t.Helper()
	st, err := n.svc.Status(bg, n.vault)
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func (n *native) connect(t *testing.T, mode string) {
	t.Helper()
	if err := n.svc.Login(bg, n.vault, httpx.ObsidianLogin{Email: "obsidian@example.com", Password: "never-retained", MFA: "123456"}); err != nil {
		t.Fatal(err)
	}
	if err := n.svc.Setup(bg, n.vault, httpx.ObsidianSetup{RemoteVaultID: "remote-1", Mode: mode}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
	eventually(t, "phase running", func() bool { return n.status(t).Phase == vm.PhaseRunning })
}

// ensureUser inserts a user row so vaults owned by it satisfy SQLite's foreign key.
func (n *native) ensureUser(t *testing.T, id string) {
	t.Helper()
	if u, _ := n.DB.Users().FindByID(bg, id); u != nil {
		return
	}
	if err := n.DB.Users().Insert(bg, vm.User{ID: id, Email: id + "@example.com", CreatedAt: 1, UpdatedAt: 1}); err != nil {
		t.Fatal(err)
	}
}
