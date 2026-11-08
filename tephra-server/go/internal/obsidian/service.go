package obsidian

import (
	"context"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// keyedLocks serialises operations per key (KeyedQueue). Waiters are woken in
// FIFO order; a key's entry is dropped when nobody holds or awaits it.
type keyedLocks struct {
	mu sync.Mutex
	m  map[string]*lockEntry
}

type lockEntry struct {
	ch   chan struct{}
	refs int
}

func newKeyedLocks() *keyedLocks { return &keyedLocks{m: map[string]*lockEntry{}} }

func (k *keyedLocks) lock(key string) (unlock func()) {
	k.mu.Lock()
	e := k.m[key]
	if e == nil {
		e = &lockEntry{ch: make(chan struct{}, 1)}
		k.m[key] = e
	}
	e.refs++
	k.mu.Unlock()
	e.ch <- struct{}{}
	return func() {
		<-e.ch
		k.mu.Lock()
		if e.refs--; e.refs == 0 {
			delete(k.m, key)
		}
		k.mu.Unlock()
	}
}

func (k *keyedLocks) run(key string, fn func() error) error {
	defer k.lock(key)()
	return fn()
}

// Options configures NativeSyncService.
type Options struct {
	// Root holds per-vault private state and checkouts (TEPHRA_OBSIDIAN_SYNC_PATH).
	Root   string
	Client OfficialClient
	// MaxVaults bounds enabled vaults; <= 0 means the default 5.
	MaxVaults int
	// ScanInterval is the checkout change-detection tick; <= 0 means 2s.
	ScanInterval time.Duration
	// RetryInterval is the base of the supervisor's exponential backoff; <= 0 means 2s.
	RetryInterval time.Duration
	// FrequencyInterval overrides the periodic one-shot interval for a
	// frequency. It exists for tests; production uses the fixed mapping below.
	FrequencyInterval func(vm.ObsidianSyncFrequency) time.Duration
}

func (o Options) maxVaults() int {
	if o.MaxVaults <= 0 {
		return 5
	}
	return o.MaxVaults
}

func (o Options) scanInterval() time.Duration {
	if o.ScanInterval <= 0 {
		return 2 * time.Second
	}
	return o.ScanInterval
}

func (o Options) retryInterval() time.Duration {
	if o.RetryInterval <= 0 {
		return 2 * time.Second
	}
	return o.RetryInterval
}

// defaultFrequencyInterval is the production periodic schedule. Continuous
// has no periodic interval; it keeps its long-lived Sync(true) loop.
func defaultFrequencyInterval(f vm.ObsidianSyncFrequency) time.Duration {
	switch f {
	case vm.Frequency6Hours:
		return 6 * time.Hour
	case vm.Frequency1Hour:
		return time.Hour
	case vm.Frequency30Minutes:
		return 30 * time.Minute
	case vm.Frequency10Minutes:
		return 10 * time.Minute
	default:
		return 0
	}
}

func (o Options) frequencyInterval(f vm.ObsidianSyncFrequency) time.Duration {
	if o.FrequencyInterval != nil {
		if d := o.FrequencyInterval(f); d > 0 {
			return d
		}
	}
	return defaultFrequencyInterval(f)
}

type worker struct {
	cancel context.CancelFunc
	done   chan struct{}
}

type accountInfo struct {
	email         *string
	lastErrorCode *string
}

// NativeSyncService implements httpx.ObsidianSyncService.
type NativeSyncService struct {
	deps httpx.Dependencies
	opts Options

	rootCtx    context.Context
	rootCancel context.CancelFunc

	controls *keyedLocks
	contents *keyedLocks

	mu             sync.Mutex // guards the fields below
	workers        map[string]*worker
	loginAttempts  map[string][]int64
	accountDetails map[string]accountInfo
	closing        bool
	deleting       map[string]bool
	ops            sync.WaitGroup
}

var _ httpx.ObsidianSyncService = (*NativeSyncService)(nil)

// NewNativeSyncService builds the service. deps must be a copy taken before
// ObsidianSync is assigned; it is only used for persistence, blobs, ids and
// the clock.
func NewNativeSyncService(deps httpx.Dependencies, opts Options) *NativeSyncService {
	ctx, cancel := context.WithCancel(context.Background())
	return &NativeSyncService{
		deps: deps, opts: opts, rootCtx: ctx, rootCancel: cancel,
		controls: newKeyedLocks(), contents: newKeyedLocks(),
		workers: map[string]*worker{}, loginAttempts: map[string][]int64{},
		accountDetails: map[string]accountInfo{}, deleting: map[string]bool{},
	}
}

// enter registers an in-flight operation so Close can drain it.
func (s *NativeSyncService) enter() (leave func(), err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing {
		return nil, NativeFailure(protocol.CodeObsidianUnavailable)
	}
	s.ops.Add(1)
	return s.ops.Done, nil
}

func (s *NativeSyncService) assertOpen(vault *vm.Vault) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || (vault != nil && s.deleting[vault.ID]) {
		return NativeFailure(protocol.CodeObsidianUnavailable)
	}
	return nil
}

func (s *NativeSyncService) isClosing() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closing
}

func (s *NativeSyncService) paths(vault vm.Vault) (VaultPaths, error) {
	return NewVaultPaths(s.opts.Root, vault.ID)
}

func (s *NativeSyncService) accountsRoot() string { return filepath.Join(s.opts.Root, ".accounts") }

func (s *NativeSyncService) accountPaths(userID string) (VaultPaths, error) {
	return NewVaultPaths(s.accountsRoot(), userID)
}

func userKey(userID string) string { return "user:" + userID }

func strPtr(s string) *string { return &s }

func (s *NativeSyncService) prepareAccounts() error {
	if err := os.MkdirAll(s.opts.Root, 0o700); err != nil {
		return err
	}
	if err := safeDirectory(s.opts.Root); err != nil {
		return err
	}
	root := s.accountsRoot()
	if err := os.Mkdir(root, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	if err := safeDirectory(root); err != nil {
		return err
	}
	return os.Chmod(root, 0o700)
}

// AccountStatus reports the owner's (user-scoped) Obsidian account state.
func (s *NativeSyncService) AccountStatus(ctx context.Context, userID string) (httpx.ObsidianAccount, error) {
	if err := s.assertOpen(nil); err != nil {
		return httpx.ObsidianAccount{}, err
	}
	return s.accountStatus(ctx, userID)
}

func (s *NativeSyncService) accountStatus(ctx context.Context, userID string) (httpx.ObsidianAccount, error) {
	ap, err := s.accountPaths(userID)
	if err != nil {
		return httpx.ObsidianAccount{}, err
	}
	authenticated, err := s.opts.Client.HasAuth(ctx, ap)
	if err != nil {
		return httpx.ObsidianAccount{}, err
	}
	s.mu.Lock()
	details := s.accountDetails[userID]
	s.mu.Unlock()
	vaults, err := s.deps.Database.Vaults().ListByOwner(ctx, userID)
	if err != nil {
		return httpx.ObsidianAccount{}, err
	}
	expired := false
	for _, v := range vaults {
		if v.SyncMode != vm.SyncModeObsidian {
			continue
		}
		st, err := s.Status(ctx, v)
		if err != nil {
			return httpx.ObsidianAccount{}, err
		}
		if st.Enabled && st.Phase == vm.PhaseError && st.LastErrorCode != nil && *st.LastErrorCode == string(protocol.CodeObsidianAuthExpired) {
			expired = true
		}
	}
	acct := httpx.ObsidianAccount{Authenticated: authenticated && !expired, Email: details.email, LastErrorCode: details.lastErrorCode}
	if expired {
		acct.LastErrorCode = strPtr(string(protocol.CodeObsidianAuthExpired))
	}
	return acct, nil
}

// AccountLogin signs the user in once into a staging directory; only the
// auth token is then copied into the user's account store and every owned
// Obsidian vault, preserving Sync state and checkouts.
func (s *NativeSyncService) AccountLogin(ctx context.Context, userID string, in httpx.ObsidianLogin) (httpx.ObsidianAccount, error) {
	leave, err := s.enter()
	if err != nil {
		return httpx.ObsidianAccount{}, err
	}
	defer leave()
	ctx = context.WithoutCancel(ctx)
	now := s.deps.Clock.Now()
	s.mu.Lock()
	var attempts []int64
	for _, t := range s.loginAttempts[userID] {
		if t > now-15*60_000 {
			attempts = append(attempts, t)
		}
	}
	if len(attempts) >= 5 {
		s.loginAttempts[userID] = attempts
		s.mu.Unlock()
		return httpx.ObsidianAccount{}, httpx.Fail(http.StatusTooManyRequests, protocol.CodeObsidianRateLimit, "Too many sign-in attempts. Try again in 15 minutes.")
	}
	s.loginAttempts[userID] = append(attempts, now)
	s.mu.Unlock()

	var out httpx.ObsidianAccount
	err = s.controls.run(userKey(userID), func() error {
		var err error
		out, err = s.accountLoginLocked(ctx, userID, in)
		return err
	})
	return out, err
}

func (s *NativeSyncService) accountLoginLocked(ctx context.Context, userID string, in httpx.ObsidianLogin) (httpx.ObsidianAccount, error) {
	if err := s.assertOpen(nil); err != nil {
		return httpx.ObsidianAccount{}, err
	}
	err := s.doAccountLogin(ctx, userID, in)
	if err != nil {
		failure := asFailure(err)
		if failure == nil {
			failure = NativeFailure(protocol.CodeObsidianLoginFailed)
		}
		s.mu.Lock()
		s.accountDetails[userID] = accountInfo{email: s.accountDetails[userID].email, lastErrorCode: strPtr(string(failure.Code))}
		s.mu.Unlock()
		return httpx.ObsidianAccount{}, failure
	}
	return s.accountStatus(ctx, userID)
}

func (s *NativeSyncService) doAccountLogin(ctx context.Context, userID string, in httpx.ObsidianLogin) error {
	staging, err := NewVaultPaths(s.accountsRoot(), "login-"+randomHex(16))
	if err != nil {
		return err
	}
	staged := false
	defer func() {
		if staged {
			_ = os.RemoveAll(staging.Root)
		}
	}()
	if err := s.prepareAccounts(); err != nil {
		return err
	}
	if err := PreparePaths(staging); err != nil {
		return err
	}
	staged = true
	client := s.opts.Client
	if err := client.Login(ctx, staging, in); err != nil {
		return err
	}
	if ok, err := client.HasAuth(ctx, staging); err != nil {
		return err
	} else if !ok {
		return NativeFailure(protocol.CodeObsidianLoginFailed)
	}
	account, err := s.accountPaths(userID)
	if err != nil {
		return err
	}
	if err := client.CopyAuth(ctx, staging, account); err != nil {
		return err
	}
	email := in.Email
	s.mu.Lock()
	s.accountDetails[userID] = accountInfo{email: &email}
	s.mu.Unlock()
	vaults, err := s.deps.Database.Vaults().ListByOwner(ctx, userID)
	if err != nil {
		return err
	}
	for _, vault := range vaults {
		if vault.SyncMode != vm.SyncModeObsidian {
			continue
		}
		vault := vault
		if err := s.controls.run(vault.ID, func() error { return s.refreshVaultAuth(ctx, vault, account) }); err != nil {
			return err
		}
	}
	return nil
}

func (s *NativeSyncService) refreshVaultAuth(ctx context.Context, vault vm.Vault, account VaultPaths) (err error) {
	s.mu.Lock()
	skip := s.deleting[vault.ID]
	s.mu.Unlock()
	if skip {
		return nil
	}
	if err := s.assertOpen(&vault); err != nil {
		return err
	}
	if err := s.stop(vault); err != nil {
		return err
	}
	defer func() {
		// Relaunch even if copying failed, as the try/finally of the TS source.
		if st, serr := s.Status(ctx, vault); serr == nil && st.Enabled && st.RemoteVaultID != nil {
			s.launch(vault)
		}
	}()
	private, err := s.privatePaths(vault)
	if err != nil {
		return err
	}
	if err := s.opts.Client.CopyAuth(ctx, account, private); err != nil {
		return err
	}
	st, err := s.Status(ctx, vault)
	if err != nil {
		return err
	}
	phase := vm.PhasePendingRemote
	if st.RemoteVaultID != nil {
		phase = vm.PhaseStopped
	}
	return s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) { c.Phase = phase; c.LastErrorCode = nil })
}

func (s *NativeSyncService) useAccount(ctx context.Context, vault vm.Vault, paths VaultPaths) error {
	account, err := s.accountPaths(vault.OwnerUserID)
	if err != nil {
		return err
	}
	ok, err := s.opts.Client.HasAuth(ctx, account)
	if err != nil {
		return err
	}
	if ok {
		return s.opts.Client.CopyAuth(ctx, account, paths)
	}
	return nil
}

// Status returns the persisted settings, or the initial ones.
func (s *NativeSyncService) Status(ctx context.Context, vault vm.Vault) (vm.ObsidianSyncSettings, error) {
	found, err := s.deps.Database.ObsidianSync().Find(ctx, vault.ID)
	if err != nil {
		return vm.ObsidianSyncSettings{}, err
	}
	if found != nil {
		return *found, nil
	}
	return httpx.InitialObsidianSettings(vault.ID), nil
}

// patch merges under the vault lock so a worker update cannot undo Pause.
func (s *NativeSyncService) patch(ctx context.Context, vault vm.Vault, mutate func(*vm.ObsidianSyncSettings)) error {
	// Keep this short settings transaction from being interrupted by a canceling
	// worker context (e.g. stop), which can abandon the transaction and leave the
	// next write with SQLITE_BUSY. Long sync/import work stays cancelable.
	ctx = context.WithoutCancel(ctx)
	return s.deps.Database.Transaction(ctx, func(repos db.TransactionRepositories) error {
		if err := repos.LockVault(ctx, vault.ID); err != nil {
			return err
		}
		v, err := repos.Vaults().FindByID(ctx, vault.ID)
		if err != nil || v == nil {
			return err
		}
		current, err := repos.ObsidianSync().Find(ctx, vault.ID)
		if err != nil {
			return err
		}
		next := httpx.InitialObsidianSettings(vault.ID)
		if current != nil {
			next = *current
		}
		mutate(&next)
		next.VaultID = vault.ID
		return repos.ObsidianSync().Upsert(ctx, next)
	})
}

func (s *NativeSyncService) privatePaths(vault vm.Vault) (VaultPaths, error) {
	paths, err := s.paths(vault)
	if err != nil {
		return paths, err
	}
	if err := PreparePaths(paths); err != nil {
		return paths, err
	}
	for _, d := range []string{paths.Root, paths.Config, paths.Tmp} {
		if err := safeDirectory(d); err != nil {
			return paths, err
		}
	}
	return paths, nil
}

// stop aborts the vault's worker and waits for it (and its child) to exit.
func (s *NativeSyncService) stop(vault vm.Vault) error {
	s.mu.Lock()
	w := s.workers[vault.ID]
	s.mu.Unlock()
	if w == nil {
		return nil
	}
	w.cancel()
	<-w.done
	s.mu.Lock()
	if s.workers[vault.ID] == w {
		delete(s.workers, vault.ID)
	}
	s.mu.Unlock()
	return nil
}

func (s *NativeSyncService) capacity(ctx context.Context, vault vm.Vault) error {
	rows, err := s.deps.Database.ObsidianSync().List(ctx)
	if err != nil {
		return err
	}
	n := 0
	for _, r := range rows {
		if r.Enabled && r.VaultID != vault.ID {
			n++
		}
	}
	if n >= s.opts.maxVaults() {
		return httpx.Fail(http.StatusConflict, protocol.CodeObsidianSyncLimit, "The server has reached its Obsidian Sync vault limit.")
	}
	return nil
}

// Login stores the owner's account credentials (user-scoped).
func (s *NativeSyncService) Login(ctx context.Context, vault vm.Vault, in httpx.ObsidianLogin) error {
	_, err := s.AccountLogin(ctx, vault.OwnerUserID, in)
	return err
}

// Remotes lists remote vaults available to the vault owner's account.
func (s *NativeSyncService) Remotes(ctx context.Context, vault vm.Vault) ([]httpx.ObsidianRemote, error) {
	if err := s.assertOpen(&vault); err != nil {
		return nil, err
	}
	leave, err := s.enter()
	if err != nil {
		return nil, err
	}
	defer leave()
	ctx = context.WithoutCancel(ctx)
	var out []httpx.ObsidianRemote
	err = s.controls.run(userKey(vault.OwnerUserID), func() error {
		return s.controls.run(vault.ID, func() error {
			if err := s.assertOpen(&vault); err != nil {
				return err
			}
			paths, err := s.privatePaths(vault)
			if err == nil {
				var st vm.ObsidianSyncSettings
				if st, err = s.Status(ctx, vault); err == nil && st.RemoteVaultID == nil {
					err = s.useAccount(ctx, vault, paths)
				}
			}
			if err == nil {
				out, err = s.opts.Client.Remotes(ctx, paths)
			}
			return orFailure(err, protocol.CodeObsidianSyncFailed)
		})
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// Setup links the vault to a remote vault and starts the initial download.
func (s *NativeSyncService) Setup(ctx context.Context, vault vm.Vault, in httpx.ObsidianSetup) error {
	if err := s.assertOpen(&vault); err != nil {
		return err
	}
	leave, err := s.enter()
	if err != nil {
		return err
	}
	defer leave()
	ctx = context.WithoutCancel(ctx)
	// The global gate serialises capacity reservations across vaults.
	return s.controls.run(userKey(vault.OwnerUserID), func() error {
		return s.controls.run("capacity", func() error {
			return s.controls.run(vault.ID, func() error { return s.setupLocked(ctx, vault, in) })
		})
	})
}

func (s *NativeSyncService) setupLocked(ctx context.Context, vault vm.Vault, in httpx.ObsidianSetup) error {
	if err := s.assertOpen(&vault); err != nil {
		return err
	}
	if err := s.capacity(ctx, vault); err != nil {
		return err
	}
	settings, err := s.Status(ctx, vault)
	if err != nil {
		return err
	}
	if settings.RemoteVaultID != nil && *settings.RemoteVaultID != in.RemoteVaultID {
		return httpx.Fail(http.StatusConflict, protocol.CodeObsidianSetupFailed, "Create a new Tephra vault to connect a different remote vault.")
	}
	if err := s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) { c.Enabled = false }); err != nil {
		return err
	}
	if err := s.stop(vault); err != nil {
		return err
	}
	paths, err := s.privatePaths(vault)
	if err != nil {
		return err
	}
	failure := func() error {
		if settings.RemoteVaultID == nil {
			if err := s.useAccount(ctx, vault, paths); err != nil {
				return err
			}
		}
		remotes, err := s.opts.Client.Remotes(ctx, paths)
		if err != nil {
			return err
		}
		found := false
		for _, r := range remotes {
			found = found || r.ID == in.RemoteVaultID
		}
		if !found {
			return NativeFailure(protocol.CodeObsidianSetupFailed)
		}
		// Explicit setup/reset is the only action allowed to recreate a lost
		// checkout. Remove BOTH sync state and checkout while no process can start.
		if err := os.RemoveAll(filepath.Join(ClientStateRoot(paths), "sync")); err != nil {
			return err
		}
		if err := os.RemoveAll(paths.Vault); err != nil {
			return err
		}
		if err := os.Mkdir(paths.Vault, 0o700); err != nil {
			return err
		}
		if err := s.opts.Client.Setup(ctx, paths, in); err != nil {
			return err
		}
		remote := in.RemoteVaultID
		mode := vm.ObsidianSyncMode(in.Mode)
		if err := s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) {
			c.RemoteVaultID = &remote
			c.Mode = mode
			c.Enabled = true
			c.Phase = vm.PhaseInitialSync
			c.HasSynced = false
			c.LastErrorCode = nil
		}); err != nil {
			return err
		}
		s.launch(vault)
		return nil
	}()
	if failure == nil {
		return nil
	}
	f := asFailure(failure)
	if f == nil {
		f = NativeFailure(protocol.CodeObsidianSetupFailed)
	}
	code := string(f.Code)
	if err := s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) {
		c.Enabled = false
		c.Phase = vm.PhaseError
		c.LastErrorCode = &code
	}); err != nil {
		return err
	}
	return f
}

// Enable pauses (false) or resumes (true) background sync. It is the
// compatibility wrapper around UpdateSettings.
func (s *NativeSyncService) Enable(ctx context.Context, vault vm.Vault, enabled bool) error {
	return s.UpdateSettings(ctx, vault, httpx.ObsidianSettingsUpdate{Enabled: &enabled})
}

// UpdateSettings applies a partial settings update. Supplied fields are
// validated and persisted; omitted fields keep their stored values. A
// frequency-only change while paused never launches a worker. On an enabled
// vault it shares Enable(true)'s setup guard: without a linked remote it fails
// instead of clearing the recorded error and launching a worker that would
// exit immediately. Otherwise the update restarts the worker through the usual
// patch/stop/repatch/launch sequence so a stale worker cannot resurrect old
// state.
func (s *NativeSyncService) UpdateSettings(ctx context.Context, vault vm.Vault, in httpx.ObsidianSettingsUpdate) error {
	if in.Enabled == nil && in.Frequency == nil {
		return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Supply enabled or frequency.")
	}
	if in.Frequency != nil && !in.Frequency.Valid() {
		return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Unsupported sync frequency.")
	}
	if err := s.assertOpen(&vault); err != nil {
		return err
	}
	leave, err := s.enter()
	if err != nil {
		return err
	}
	defer leave()
	ctx = context.WithoutCancel(ctx)
	return s.controls.run("capacity", func() error {
		return s.controls.run(vault.ID, func() error {
			if err := s.assertOpen(&vault); err != nil {
				return err
			}
			if in.Enabled != nil {
				return s.applyEnabledLocked(ctx, vault, *in.Enabled, in.Frequency)
			}
			st, err := s.Status(ctx, vault)
			if err != nil {
				return err
			}
			if !st.Enabled {
				return s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) { c.Frequency = *in.Frequency })
			}
			// An enabled row without a linked remote cannot sync. Fail exactly
			// like Enable(true) before patching, rather than recording
			// initial-sync and launching a worker that exits on its first read.
			if err := s.requireEnabledSetup(ctx, vault); err != nil {
				return err
			}
			apply := func(c *vm.ObsidianSyncSettings) {
				c.Frequency = *in.Frequency
				c.Phase = vm.PhaseInitialSync
				c.LastErrorCode = nil
			}
			if err := s.patch(ctx, vault, apply); err != nil {
				return err
			}
			if err := s.stop(vault); err != nil {
				return err
			}
			// A finishing worker may have overwritten the phase while stopping.
			if err := s.patch(ctx, vault, apply); err != nil {
				return err
			}
			s.launch(vault)
			return nil
		})
	})
}

// requireEnabledSetup is the state guard shared by Enable(true) and frequency
// updates of an enabled vault: the vault must be under the capacity limit and
// linked to a remote vault.
func (s *NativeSyncService) requireEnabledSetup(ctx context.Context, vault vm.Vault) error {
	if err := s.capacity(ctx, vault); err != nil {
		return err
	}
	st, err := s.Status(ctx, vault)
	if err != nil {
		return err
	}
	if st.RemoteVaultID == nil {
		return NativeFailure(protocol.CodeObsidianSetupFailed)
	}
	return nil
}

func (s *NativeSyncService) applyEnabledLocked(ctx context.Context, vault vm.Vault, enabled bool, frequency *vm.ObsidianSyncFrequency) error {
	if enabled {
		if err := s.requireEnabledSetup(ctx, vault); err != nil {
			return err
		}
	}
	phase := vm.PhaseStopped
	if enabled {
		phase = vm.PhaseInitialSync
	}
	apply := func(c *vm.ObsidianSyncSettings) {
		c.Enabled = enabled
		c.Phase = phase
		c.LastErrorCode = nil
		if frequency != nil {
			c.Frequency = *frequency
		}
	}
	if err := s.patch(ctx, vault, apply); err != nil {
		return err
	}
	if err := s.stop(vault); err != nil {
		return err
	}
	// A finishing worker may have overwritten the phase while stopping.
	if err := s.patch(ctx, vault, apply); err != nil {
		return err
	}
	if enabled {
		s.launch(vault)
	}
	return nil
}

// launch starts the supervised worker for a vault (no-op if closing,
// deleting or already running). Workers use the service context, never a
// request context.
func (s *NativeSyncService) launch(vault vm.Vault) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closing || s.deleting[vault.ID] || s.workers[vault.ID] != nil {
		return
	}
	ctx, cancel := context.WithCancel(s.rootCtx)
	w := &worker{cancel: cancel, done: make(chan struct{})}
	s.workers[vault.ID] = w
	go func() {
		defer close(w.done)
		defer cancel()
		defer func() {
			_ = recover() // a crashing worker must never take the API down
			s.mu.Lock()
			if s.workers[vault.ID] == w {
				delete(s.workers, vault.ID)
			}
			s.mu.Unlock()
		}()
		_ = s.supervise(ctx, vault)
	}()
}

func (s *NativeSyncService) preflight(ctx context.Context, vault vm.Vault, state vm.ObsidianSyncSettings, paths VaultPaths) error {
	err := func() error {
		if err := safeDirectory(paths.Vault); err != nil {
			return err
		}
		stateRoot := ClientStateRoot(paths)
		syncDirs, err := os.ReadDir(filepath.Join(stateRoot, "sync"))
		if err != nil {
			return err
		}
		if len(syncDirs) == 0 {
			return NativeFailure(protocol.CodeObsidianCheckoutMiss)
		}
		if state.HasSynced {
			files, err := s.deps.Database.VaultFiles().ListByVault(ctx, vault.ID)
			if err != nil {
				return err
			}
			// A checkout that lost all visible files while retaining a nonempty
			// ledger must not be read by the official client as user deletions.
			if len(files) > 0 {
				names, err := os.ReadDir(paths.Vault)
				if err != nil {
					return err
				}
				visible := 0
				for _, n := range names {
					if n.Name()[0] != '.' {
						visible++
					}
				}
				if visible == 0 {
					return NativeFailure(protocol.CodeObsidianCheckoutMiss)
				}
			}
			for _, f := range files {
				destination, err := confinedPath(paths.Vault, f.Path, false)
				if err != nil {
					return err
				}
				info, err := os.Lstat(destination)
				if err != nil {
					return err
				}
				if !info.Mode().IsRegular() {
					return NativeFailure(protocol.CodeObsidianCheckoutMiss)
				}
			}
		}
		token, err := os.Lstat(filepath.Join(stateRoot, "auth_token"))
		if err != nil {
			return err
		}
		if !token.Mode().IsRegular() {
			return NativeFailure(protocol.CodeObsidianAuthExpired)
		}
		return nil
	}()
	if err == nil {
		return nil
	}
	if f := asFailure(err); f != nil {
		return f
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	return NativeFailure(protocol.CodeObsidianCheckoutMiss)
}

// sleep waits d or until ctx ends; it reports whether the full time elapsed.
func sleep(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return true
	case <-ctx.Done():
		return false
	}
}

func (s *NativeSyncService) importLocked(ctx context.Context, vault vm.Vault, paths VaultPaths) (int64, error) {
	defer s.contents.lock(vault.ID)()
	return ImportCheckout(ctx, s.deps, vault, paths)
}

func (s *NativeSyncService) supervise(ctx context.Context, vault vm.Vault) error {
	failures := 0
	for ctx.Err() == nil && !s.isClosing() {
		settings, err := s.Status(ctx, vault)
		if err != nil {
			return err
		}
		if !settings.Enabled || settings.RemoteVaultID == nil {
			return nil
		}
		err = s.cycle(ctx, vault, settings, &failures)
		if err == nil {
			continue
		}
		if ctx.Err() != nil || s.isClosing() {
			return nil
		}
		f := asFailure(err)
		if f == nil {
			f = NativeFailure(protocol.CodeObsidianSyncFailed)
		}
		code := string(f.Code)
		if perr := s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) { c.Phase = vm.PhaseError; c.LastErrorCode = &code }); perr != nil {
			return perr
		}
		switch f.Code {
		case protocol.CodeObsidianCheckoutMiss, protocol.CodeObsidianAuthExpired, protocol.CodeObsidianSetupFailed:
			return nil
		}
		failures++
		// enabled stays persisted so a reboot or manual retry recovers.
		exp := failures - 1
		if exp > 8 {
			exp = 8
		}
		delay := s.opts.retryInterval() << uint(exp)
		if delay > 300*time.Second || delay <= 0 {
			delay = 300 * time.Second
		}
		sleep(ctx, delay)
	}
	return nil
}

// cycle is one preflight -> initial sync -> import -> steady state: the
// periodic one-shot loop or the continuous long-lived run, selected by
// EffectiveFrequency.
func (s *NativeSyncService) cycle(ctx context.Context, vault vm.Vault, settings vm.ObsidianSyncSettings, failures *int) error {
	paths, err := s.privatePaths(vault)
	if err != nil {
		return err
	}
	if err := s.preflight(ctx, vault, settings, paths); err != nil {
		return err
	}
	setPhase := func(p vm.ObsidianSyncPhase, clearErr bool) error {
		return s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) {
			c.Phase = p
			if clearErr {
				c.LastErrorCode = nil
			}
		})
	}
	if err := setPhase(vm.PhaseInstalling, true); err != nil {
		return err
	}
	if err := s.opts.Client.Ensure(ctx); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return nil
	}
	if err := s.opts.Client.Configure(ctx, paths, string(settings.Mode)); err != nil {
		return err
	}
	if err := setPhase(vm.PhaseInitialSync, false); err != nil {
		return err
	}
	if err := s.opts.Client.Sync(ctx, paths, false); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return nil
	}
	if _, err := s.importLocked(ctx, vault, paths); err != nil {
		return err
	}
	if ctx.Err() != nil {
		return nil
	}
	now := s.deps.Clock.Now()
	if err := s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) {
		c.Phase = vm.PhaseRunning
		c.HasSynced = true
		c.LastSyncedAt = &now
		// TS patches only these three fields (lastErrorCode was cleared when installing).
	}); err != nil {
		return err
	}
	started := time.Now()
	if settings.EffectiveFrequency() != vm.FrequencyContinuous {
		err = s.periodic(ctx, vault, paths, failures)
		if time.Since(started) > 60*time.Second {
			*failures = 0
		}
		// A nil result means the settings no longer call for this periodic
		// worker (or the worker was cancelled); let the supervisor re-read.
		return err
	}
	err = s.continuous(ctx, vault, paths)
	if time.Since(started) > 60*time.Second {
		*failures = 0
	}
	if err != nil {
		return err
	}
	if ctx.Err() == nil {
		return NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	return nil
}

// periodic runs one-shot sync passes for a non-continuous frequency. It waits
// a full interval before each pass, re-reads the persisted status, runs the
// same preflight used by the continuous path, then syncs and imports without
// ever overlapping passes. Errors return to the supervisor for error state and
// exponential retry; cancellation is always a clean stop.
func (s *NativeSyncService) periodic(ctx context.Context, vault vm.Vault, paths VaultPaths, failures *int) error {
	for {
		st, err := s.Status(ctx, vault)
		if err != nil {
			return err
		}
		if !st.Enabled || st.RemoteVaultID == nil || st.EffectiveFrequency() == vm.FrequencyContinuous {
			return nil
		}
		interval := s.opts.frequencyInterval(st.EffectiveFrequency())
		if interval <= 0 {
			return nil
		}
		if !sleep(ctx, interval) {
			return nil
		}
		st, err = s.Status(ctx, vault)
		if err != nil {
			return err
		}
		if !st.Enabled || st.RemoteVaultID == nil || st.EffectiveFrequency() == vm.FrequencyContinuous {
			return nil
		}
		if s.isClosing() {
			return nil
		}
		if err := s.preflight(ctx, vault, st, paths); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if err := s.opts.Client.Sync(ctx, paths, false); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		if ctx.Err() != nil {
			return nil
		}
		if _, err := s.importLocked(ctx, vault, paths); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		now := s.deps.Clock.Now()
		if err := s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) { c.LastSyncedAt = &now }); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}
		*failures = 0
	}
}

// continuous runs the long-lived official sync and re-imports the checkout
// when it changes (stat fingerprint) or at least once a minute.
func (s *NativeSyncService) continuous(parent context.Context, vault vm.Vault, paths VaultPaths) error {
	ctx, cancel := context.WithCancel(parent)
	defer cancel()
	ended := make(chan struct{})
	var childErr error
	go func() {
		defer close(ended)
		defer cancel()
		childErr = s.opts.Client.Sync(ctx, paths, true)
	}()
	var loopErr error
	var lastFP uint64
	haveFP := false
	lastScan := time.Now()
	timer := time.NewTimer(s.opts.scanInterval())
	defer timer.Stop()
loop:
	for {
		select {
		case <-ctx.Done():
			break loop
		case <-ended:
			break loop
		case <-timer.C:
		}
		fp, ferr := checkoutFingerprint(ctx, paths.Vault)
		if ctx.Err() != nil {
			break
		}
		if ferr != nil || !haveFP || fp != lastFP || time.Since(lastScan) >= 60*time.Second {
			lastFP, haveFP = fp, ferr == nil
			lastScan = time.Now()
			if _, err := s.importLocked(ctx, vault, paths); err != nil {
				if ctx.Err() == nil {
					loopErr = err
				}
				break
			}
			now := s.deps.Clock.Now()
			if err := s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) { c.LastSyncedAt = &now }); err != nil {
				if ctx.Err() == nil {
					loopErr = err
				}
				break
			}
		}
		timer.Reset(s.opts.scanInterval())
	}
	cancel()
	<-ended
	if loopErr != nil {
		return loopErr
	}
	if parent.Err() == nil {
		if childErr != nil {
			return childErr
		}
		return NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	return nil
}

// WriteNote stops sync, writes the note into the checkout, imports it into
// the ledger as one revision, and restarts sync.
func (s *NativeSyncService) WriteNote(ctx context.Context, vault vm.Vault, plan httpx.NotePlan, text string) (httpx.NoteCommitResult, error) {
	if err := s.assertOpen(&vault); err != nil {
		return httpx.NoteCommitResult{}, err
	}
	leave, err := s.enter()
	if err != nil {
		return httpx.NoteCommitResult{}, err
	}
	defer leave()
	ctx = context.WithoutCancel(ctx)
	data := []byte(text)
	if int64(len(data)) > s.deps.BlobLimit() {
		return httpx.NoteCommitResult{}, httpx.Fail(http.StatusRequestEntityTooLarge, protocol.CodeBlobTooLarge, "Content exceeds the configured size limit.")
	}
	var result httpx.NoteCommitResult
	err = s.controls.run(vault.ID, func() error {
		var err error
		result, err = s.writeNoteLocked(ctx, vault, plan, data)
		return err
	})
	return result, err
}

func (s *NativeSyncService) writeNoteLocked(ctx context.Context, vault vm.Vault, plan httpx.NotePlan, data []byte) (httpx.NoteCommitResult, error) {
	if err := s.assertOpen(&vault); err != nil {
		return httpx.NoteCommitResult{}, err
	}
	state, err := s.Status(ctx, vault)
	if err != nil {
		return httpx.NoteCommitResult{}, err
	}
	if state.Mode != vm.ObsidianModeBidirectional {
		return httpx.NoteCommitResult{}, httpx.Fail(http.StatusConflict, protocol.CodeObsidianReadOnly, "This vault downloads from Obsidian Sync. Edit it in Obsidian.")
	}
	if !state.Enabled || !state.HasSynced || state.Phase != vm.PhaseRunning {
		return httpx.NoteCommitResult{}, httpx.Fail(http.StatusConflict, protocol.CodeObsidianSyncFailed, "Wait for Obsidian Sync to be running before editing.")
	}
	if err := s.stop(vault); err != nil {
		return httpx.NoteCommitResult{}, err
	}
	defer s.launch(vault)
	unlock := s.contents.lock(vault.ID)
	defer unlock()
	res, err := s.writeNoteInCheckout(ctx, vault, state, plan, data)
	if err != nil {
		return httpx.NoteCommitResult{}, orFailure(err, protocol.CodeObsidianSyncFailed)
	}
	return res, nil
}

func (s *NativeSyncService) writeNoteInCheckout(ctx context.Context, vault vm.Vault, state vm.ObsidianSyncSettings, plan httpx.NotePlan, data []byte) (httpx.NoteCommitResult, error) {
	var none httpx.NoteCommitResult
	paths, err := s.paths(vault)
	if err != nil {
		return none, err
	}
	if err := s.preflight(ctx, vault, state, paths); err != nil {
		return none, err
	}
	if _, err := ImportCheckout(ctx, s.deps, vault, paths); err != nil {
		return none, err
	}
	files := s.deps.Database.VaultFiles()
	var current *vm.CurrentVaultFile
	if plan.Kind == "update" {
		current, err = files.FindByID(ctx, vault.ID, plan.FileID)
	} else {
		current, err = files.FindByPath(ctx, vault.ID, plan.Path)
	}
	if err != nil {
		return none, err
	}
	if plan.Kind == "create" && current != nil {
		return httpx.NoteCommitResult{Status: "exists", Current: current}, nil
	}
	if plan.Kind == "update" && current == nil {
		return none, httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "File was not found.")
	}
	if plan.Kind == "update" && current.BlobHash != plan.BaseHash {
		return httpx.NoteCommitResult{Status: "conflict", Current: current}, nil
	}
	if current != nil && current.Kind != vm.KindMarkdown {
		return none, httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Only Markdown notes can be edited.")
	}
	fresh, err := s.deps.Database.Vaults().FindByID(ctx, vault.ID)
	if err != nil {
		return none, err
	}
	if fresh == nil {
		return none, NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	if current != nil && current.BlobHash == protocol.SHA256Hex(data) {
		return httpx.NoteCommitResult{Status: "up-to-date", Revision: fresh.LatestRevision, File: current}, nil
	}
	path := plan.Path
	if plan.Kind != "create" {
		path = current.Path
	}
	if !isMarkdownPath(path) {
		return none, httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidPath, "Markdown notes must end in .md.")
	}
	if err := AtomicNoteWrite(paths, path, data); err != nil {
		return none, err
	}
	revision, err := ImportCheckout(ctx, s.deps, vault, paths)
	if err != nil {
		return none, err
	}
	file, err := files.FindByPath(ctx, vault.ID, path)
	if err != nil {
		return none, err
	}
	if file == nil {
		return none, NativeFailure(protocol.CodeObsidianSyncFailed)
	}
	return httpx.NoteCommitResult{Status: "committed", Revision: revision, File: file}, nil
}

// Remove stops the worker, unlinks the remote registration (best effort) and
// deletes all local state. The child is gone first, so local removal cannot
// propagate to the remote vault. The caller deletes the vault row afterwards.
func (s *NativeSyncService) Remove(ctx context.Context, vault vm.Vault) error {
	leave, err := s.enter()
	if err != nil {
		return err
	}
	defer leave()
	ctx = context.WithoutCancel(ctx)
	return s.controls.run(userKey(vault.OwnerUserID), func() error {
		s.mu.Lock()
		s.deleting[vault.ID] = true
		s.mu.Unlock()
		return s.controls.run(vault.ID, func() error {
			if err := s.patch(ctx, vault, func(c *vm.ObsidianSyncSettings) { c.Enabled = false; c.Phase = vm.PhaseStopped }); err != nil {
				return err
			}
			if err := s.stop(vault); err != nil {
				return err
			}
			paths, err := s.paths(vault)
			if err != nil {
				return err
			}
			_ = s.opts.Client.Unlink(ctx, paths)
			if err := os.RemoveAll(paths.Root); err != nil {
				return err
			}
			s.mu.Lock()
			delete(s.loginAttempts, vault.ID)
			s.mu.Unlock()
			return nil
		})
	})
}

// Boot resumes every enabled vault, enforcing the vault limit. Call it from
// a goroutine: it only queries the database and launches workers.
func (s *NativeSyncService) Boot(ctx context.Context) error {
	leave, err := s.enter()
	if err != nil {
		return err
	}
	defer leave()
	rows, err := s.deps.Database.ObsidianSync().List(ctx)
	if err != nil {
		return err
	}
	started := 0
	for _, row := range rows {
		if !row.Enabled {
			continue
		}
		vault, err := s.deps.Database.Vaults().FindByID(ctx, row.VaultID)
		if err != nil {
			return err
		}
		if vault == nil || vault.SyncMode != vm.SyncModeObsidian {
			continue
		}
		if started >= s.opts.maxVaults() {
			if err := s.patch(ctx, *vault, func(c *vm.ObsidianSyncSettings) {
				code := string(protocol.CodeObsidianSyncLimit)
				c.Enabled = false
				c.Phase = vm.PhaseError
				c.LastErrorCode = &code
			}); err != nil {
				return err
			}
			continue
		}
		started++
		s.launch(*vault)
	}
	return nil
}

// Close stops accepting work, terminates every child and waits for all
// workers and in-flight operations. Safe to call more than once.
func (s *NativeSyncService) Close() {
	s.mu.Lock()
	s.closing = true
	s.mu.Unlock()
	s.opts.Client.Close()
	s.rootCancel()
	s.ops.Wait()
	s.mu.Lock()
	ws := make([]*worker, 0, len(s.workers))
	for _, w := range s.workers {
		ws = append(ws, w)
	}
	s.mu.Unlock()
	for _, w := range ws {
		w.cancel()
		<-w.done
	}
}
