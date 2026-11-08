package obsidian

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func (n *native) files(t *testing.T) []vm.CurrentVaultFile {
	t.Helper()
	f, err := n.DB.VaultFiles().ListByVault(bg, n.vault.ID)
	if err != nil {
		t.Fatal(err)
	}
	return f
}

func (n *native) revisions(t *testing.T) []vm.VaultRevision {
	t.Helper()
	r, err := n.DB.VaultRevisions().List(bg, n.vault.ID)
	if err != nil {
		t.Fatal(err)
	}
	return r
}

func (n *native) importNow(t *testing.T) int64 {
	t.Helper()
	rev, err := ImportCheckout(bg, n.Deps, n.vault, n.paths)
	if err != nil {
		t.Fatal(err)
	}
	return rev
}

func TestImportsExactBytesAsVerifiedHashesAndRevisions(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	if err := n.svc.Enable(bg, n.vault, false); err != nil {
		t.Fatal(err)
	}
	first := n.files(t)[0]
	data, _ := os.ReadFile(filepath.Join(n.paths.Vault, "Note.md"))
	if first.BlobHash != protocol.SHA256Hex(data) {
		t.Fatal("blob hash is not the SHA-256 of the exact bytes")
	}
	if stored, ok := n.Blobs.Bytes(first.BlobHash); !ok || string(stored) != string(data) {
		t.Fatal("stored blob differs from the checkout bytes")
	}
	if len(n.revisions(t)) != 1 {
		t.Fatal("want one revision")
	}
	n.importNow(t)
	if len(n.revisions(t)) != 1 {
		t.Fatal("no-op import created a duplicate revision")
	}
	os.WriteFile(filepath.Join(n.paths.Vault, "Note.md"), []byte("# Changed\n"), 0o644)
	n.importNow(t)
	changed, _ := n.DB.VaultFiles().FindByPath(bg, n.vault.ID, "Note.md")
	if changed == nil || changed.FileID != first.FileID || changed.UpdatedRevision != 2 {
		t.Fatalf("changed %+v", changed)
	}
	os.Remove(filepath.Join(n.paths.Vault, "Note.md"))
	n.importNow(t)
	if len(n.files(t)) != 0 {
		t.Fatal("deleted file still in the ledger")
	}
	versions, _ := n.DB.FileVersions().ListByFile(bg, n.vault.ID, first.FileID)
	var types []string
	for _, v := range versions {
		types = append(types, string(v.ChangeType))
	}
	if !reflect.DeepEqual(types, []string{"create", "modify", "delete"}) {
		t.Fatalf("change types %v", types)
	}
}

func TestResumesEnabledStateOnBootAndLeavesPausedVaultsAlone(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	n.svc.Close()
	recovered := n.newService(t, nil)
	if err := recovered.Boot(bg); err != nil {
		t.Fatal(err)
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
	if n.client.count("ensure") != 2 || n.client.count("login") != 1 {
		t.Fatalf("ensure=%d login=%d", n.client.count("ensure"), n.client.count("login"))
	}
	if err := recovered.Enable(bg, n.vault, false); err != nil {
		t.Fatal(err)
	}
	recovered.Close()
	paused := n.newService(t, nil)
	if err := paused.Boot(bg); err != nil {
		t.Fatal(err)
	}
	if n.client.Active() != 0 || n.client.count("ensure") != 2 {
		t.Fatal("a paused vault was started")
	}
	if got := read(t, filepath.Join(ClientStateRoot(n.paths), "auth_token")); got != "saved-token:obsidian@example.com" {
		t.Fatalf("auth token %q", got)
	}
}

func TestNeverStartsSyncWithLostCheckoutOrState(t *testing.T) {
	for _, kind := range []string{"absent", "empty", "nested-empty", "state-absent"} {
		t.Run(kind, func(t *testing.T) {
			n := nativeFixture(t, nil, nil)
			n.connect(t, "bidirectional")
			if err := n.svc.Enable(bg, n.vault, false); err != nil {
				t.Fatal(err)
			}
			calls := n.client.count("sync")
			switch kind {
			case "nested-empty":
				os.Remove(filepath.Join(n.paths.Vault, "Note.md"))
				os.Mkdir(filepath.Join(n.paths.Vault, "Empty folder"), 0o755)
			case "empty":
				os.Remove(filepath.Join(n.paths.Vault, "Note.md"))
			case "absent":
				os.RemoveAll(n.paths.Vault)
			default:
				os.RemoveAll(filepath.Join(ClientStateRoot(n.paths), "sync"))
			}
			if err := n.svc.Enable(bg, n.vault, true); err != nil {
				t.Fatal(err)
			}
			eventually(t, "CHECKOUT_MISSING", func() bool {
				c := n.status(t).LastErrorCode
				return c != nil && *c == "OBSIDIAN_CHECKOUT_MISSING"
			})
			if n.client.count("sync") != calls {
				t.Fatal("sync started against a lost checkout")
			}
			if len(n.files(t)) != 1 {
				t.Fatal("ledger changed")
			}
			if err := n.svc.Setup(bg, n.vault, httpx.ObsidianSetup{RemoteVaultID: "remote-1", Mode: "bidirectional"}); err != nil {
				t.Fatal(err)
			}
			eventually(t, "child active", func() bool { return n.client.Active() == 1 })
		})
	}
}

func TestStopsBeforeWebWritesAndPreservesOptimisticConcurrency(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	file := n.files(t)[0]
	before := len(n.client.Events())
	res, err := n.svc.WriteNote(bg, n.vault, httpx.NotePlan{Kind: "update", FileID: file.FileID, BaseHash: file.BlobHash}, "# Web edit\n")
	if err != nil || res.Status != "committed" {
		t.Fatalf("%+v %v", res, err)
	}
	if ev := n.client.Events(); ev[before] != "stopped" {
		t.Fatalf("events %v", ev)
	}
	if got := read(t, filepath.Join(n.paths.Vault, file.Path)); got != "# Web edit\n" {
		t.Fatal(got)
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
	res, err = n.svc.WriteNote(bg, n.vault, httpx.NotePlan{Kind: "update", FileID: file.FileID, BaseHash: file.BlobHash}, "stale edit")
	if err != nil || res.Status != "conflict" || res.Current == nil {
		t.Fatalf("%+v %v", res, err)
	}
	if got := read(t, filepath.Join(n.paths.Vault, file.Path)); got != "# Web edit\n" {
		t.Fatal("conflict overwrote the file")
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
	res, err = n.svc.WriteNote(bg, n.vault, httpx.NotePlan{Kind: "create", Path: "Folder/Agent.md"}, "# Agent note\n")
	if err != nil || res.Status != "committed" {
		t.Fatalf("%+v %v", res, err)
	}
	if got := read(t, filepath.Join(n.paths.Vault, "Folder/Agent.md")); got != "# Agent note\n" {
		t.Fatal(got)
	}
	if len(n.revisions(t)) != 3 {
		t.Fatalf("revisions %d", len(n.revisions(t)))
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
	// Existing path, unchanged content and non-markdown targets.
	res, err = n.svc.WriteNote(bg, n.vault, httpx.NotePlan{Kind: "create", Path: "Folder/Agent.md"}, "x")
	if err != nil || res.Status != "exists" {
		t.Fatalf("%+v %v", res, err)
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
	cur, _ := n.DB.VaultFiles().FindByPath(bg, n.vault.ID, "Folder/Agent.md")
	res, err = n.svc.WriteNote(bg, n.vault, httpx.NotePlan{Kind: "update", FileID: cur.FileID, BaseHash: cur.BlobHash}, "# Agent note\n")
	if err != nil || res.Status != "up-to-date" {
		t.Fatalf("%+v %v", res, err)
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
	_, err = n.svc.WriteNote(bg, n.vault, httpx.NotePlan{Kind: "create", Path: "Folder/NotMd.txt"}, "x")
	wantCode(t, err, protocol.CodeInvalidPath)
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
}

func TestPullOnlyDisablesWritesAndNeverStoresSecrets(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "pull-only")
	file := n.files(t)[0]
	_, err := n.svc.WriteNote(bg, n.vault, httpx.NotePlan{Kind: "update", FileID: file.FileID, BaseHash: file.BlobHash}, "edit")
	wantCode(t, err, protocol.CodeObsidianReadOnly)
	rows, _ := n.DB.ObsidianSync().List(bg)
	raw, _ := httpx.MarshalJSON(rows)
	for _, s := range []string{"never-retained", "123456", "saved-token"} {
		if strings.Contains(string(raw), s) {
			t.Fatalf("settings contain %q", s)
		}
	}
}

func TestPauseStaysPersistentWhileReconciliationFinishes(t *testing.T) {
	var gate *gatedDB
	n := nativeFixture(t, nil, func(d db.Database) db.Database { gate = &gatedDB{Database: d}; return gate })
	n.connect(t, "bidirectional")
	gate.arm()
	os.WriteFile(filepath.Join(n.paths.Vault, "Note.md"), []byte("# Remote change"), 0o644)
	eventually(t, "scan in progress", gate.isScanning)
	paused := make(chan error, 1)
	go func() { paused <- n.svc.Enable(bg, n.vault, false) }()
	eventually(t, "enabled=false", func() bool { return !n.status(t).Enabled })
	gate.release()
	if err := <-paused; err != nil {
		t.Fatal(err)
	}
	st := n.status(t)
	if st.Enabled || st.Phase != vm.PhaseStopped || n.client.Active() != 0 {
		t.Fatalf("status %+v active %d", st, n.client.Active())
	}
}

func TestRetriesUnavailableRuntimeOnBootWithoutPassword(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	n.svc.Close()
	n.client.mu.Lock()
	n.client.ensureErrs = []error{NativeFailure(protocol.CodeObsidianUnavailable)}
	n.client.mu.Unlock()
	recovered := n.newService(t, func(o *Options) { o.RetryInterval = 10 * time.Millisecond })
	if err := recovered.Boot(bg); err != nil {
		t.Fatal(err)
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
	if n.client.count("ensure") != 3 || n.client.count("login") != 1 {
		t.Fatalf("ensure=%d login=%d", n.client.count("ensure"), n.client.count("login"))
	}
}

func TestRemoveStopsAndReapsWorkerBeforeUnlinkAndRejectsResurrection(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	if err := n.svc.Remove(bg, n.vault); err != nil {
		t.Fatal(err)
	}
	ev := n.client.Events()
	if !reflect.DeepEqual(ev[len(ev)-2:], []string{"stopped", "unlink"}) {
		t.Fatalf("events %v", ev)
	}
	if n.client.count("logout") != 0 {
		t.Fatal("logout was called")
	}
	if _, err := os.Stat(n.paths.Root); err == nil {
		t.Fatal("local state not removed")
	}
	if n.status(t).Enabled {
		t.Fatal("still enabled")
	}
	wantCode(t, n.svc.Enable(bg, n.vault, true), protocol.CodeObsidianUnavailable)
}

func TestHaltsOnExpiredAuthAndResumesAfterReloginWithoutSavingPassword(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	n.svc.Enable(bg, n.vault, false)
	n.client.setFailure(NativeFailure(protocol.CodeObsidianAuthExpired))
	n.svc.Enable(bg, n.vault, true)
	eventually(t, "AUTH_EXPIRED", func() bool {
		c := n.status(t).LastErrorCode
		return c != nil && *c == "OBSIDIAN_AUTH_EXPIRED"
	})
	n.client.setFailure(nil)
	if err := n.svc.Login(bg, n.vault, httpx.ObsidianLogin{Email: "obsidian@example.com", Password: "new-password"}); err != nil {
		t.Fatal(err)
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
}

func TestEnforcesReducedVaultLimitOnReboot(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	n.svc.Close()
	other := n.vault
	other.ID, other.Name = "other-vault", "Other"
	if err := n.DB.Vaults().Insert(bg, other); err != nil {
		t.Fatal(err)
	}
	remote := "remote-1"
	st := httpx.InitialObsidianSettings(other.ID)
	st.Enabled, st.RemoteVaultID = true, &remote
	n.DB.ObsidianSync().Upsert(bg, st)
	recovered := n.newService(t, func(o *Options) { o.MaxVaults = 1 })
	if err := recovered.Boot(bg); err != nil {
		t.Fatal(err)
	}
	eventually(t, "child active", func() bool { return n.client.Active() == 1 })
	got, _ := recovered.Status(bg, other)
	if got.Enabled || got.Phase != vm.PhaseError || got.LastErrorCode == nil || *got.LastErrorCode != "OBSIDIAN_SYNC_LIMIT" {
		t.Fatalf("other %+v", got)
	}
}

func TestThrottlesLoginAttemptsAndBoundsEnabledVaults(t *testing.T) {
	n := nativeFixture(t, func(o *Options) { o.MaxVaults = 1 }, nil)
	n.connect(t, "bidirectional")
	other := n.vault
	other.ID, other.Name = "other-vault", "Other"
	n.DB.Vaults().Insert(bg, other)
	wantCode(t, n.svc.Setup(bg, other, httpx.ObsidianSetup{RemoteVaultID: "remote-1", Mode: "bidirectional"}), protocol.CodeObsidianSyncLimit)
	for i := 0; i < 4; i++ {
		if err := n.svc.Login(bg, n.vault, httpx.ObsidianLogin{Email: "test@example.com", Password: "secret"}); err != nil {
			t.Fatal(err)
		}
	}
	wantCode(t, n.svc.Login(bg, n.vault, httpx.ObsidianLogin{Email: "test@example.com", Password: "secret"}), protocol.CodeObsidianRateLimit)
}

func TestCloseTerminatesChildrenAndRejectsFurtherWork(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	n.svc.Close()
	if n.client.Active() != 0 {
		t.Fatal("child survived Close")
	}
	wantCode(t, n.svc.Enable(bg, n.vault, true), protocol.CodeObsidianUnavailable)
	_, err := n.svc.AccountStatus(bg, n.vault.OwnerUserID)
	wantCode(t, err, protocol.CodeObsidianUnavailable)
	wantCode(t, n.svc.Boot(bg), protocol.CodeObsidianUnavailable)
	n.svc.Close() // idempotent
}

func TestIgnoresConfigFilesRefusesSymlinksAndTraversal(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	n.svc.Enable(bg, n.vault, false)
	write(t, filepath.Join(n.paths.Vault, ".obsidian/plugins/evil/main.js"), `throw Error("plugin must never run")`)
	scanned, err := ScanCheckout(bg, n.paths.Vault, 100_000)
	if err != nil || len(scanned) != 1 || scanned[0].Path != "Note.md" {
		t.Fatalf("scan %v %v", scanned, err)
	}
	if err := os.Symlink("/etc/passwd", filepath.Join(n.paths.Vault, "linked.md")); err != nil {
		t.Fatal(err)
	}
	_, err = ImportCheckout(bg, n.Deps, n.vault, n.paths)
	wantCode(t, err, protocol.CodeObsidianSyncFailed)
	if len(n.files(t)) != 1 {
		t.Fatal("a failed scan changed the ledger")
	}
	wantCode(t, AtomicNoteWrite(n.paths, "../escape.md", nil), protocol.CodeInvalidPath)
	wantCode(t, AtomicNoteWrite(n.paths, "/escape.md", nil), protocol.CodeInvalidPath)
	wantCode(t, AtomicNoteWrite(n.paths, ".hidden/x.md", nil), protocol.CodeInvalidPath)
	if err := os.Symlink(n.root, filepath.Join(n.paths.Vault, "linked-dir")); err != nil {
		t.Fatal(err)
	}
	wantCode(t, AtomicNoteWrite(n.paths, "linked-dir/escape.md", nil), protocol.CodeObsidianSyncFailed)
	_, err = ScanCheckout(bg, n.paths.Vault, 1)
	wantCode(t, err, protocol.CodeObsidianSyncFailed)
	if _, err := os.Stat(filepath.Join(n.root, "escape.md")); err == nil {
		t.Fatal("wrote outside the checkout")
	}
}

func TestFrequencyIntervalMappingHasSafeFallback(t *testing.T) {
	o := Options{}
	for frequency, want := range map[vm.ObsidianSyncFrequency]time.Duration{
		vm.Frequency6Hours:                      6 * time.Hour,
		vm.Frequency1Hour:                       time.Hour,
		vm.Frequency30Minutes:                   30 * time.Minute,
		vm.Frequency10Minutes:                   10 * time.Minute,
		vm.FrequencyContinuous:                  0,
		vm.ObsidianSyncFrequency("unsupported"): 0,
	} {
		if got := o.frequencyInterval(frequency); got != want {
			t.Fatalf("frequencyInterval(%q) = %v, want %v", frequency, got, want)
		}
	}
	o.FrequencyInterval = func(vm.ObsidianSyncFrequency) time.Duration { return 25 * time.Millisecond }
	if got := o.frequencyInterval(vm.Frequency10Minutes); got != 25*time.Millisecond {
		t.Fatalf("seam interval = %v", got)
	}
	o.FrequencyInterval = func(vm.ObsidianSyncFrequency) time.Duration { return 0 }
	if got := o.frequencyInterval(vm.Frequency30Minutes); got != 30*time.Minute {
		t.Fatalf("zero seam interval = %v, want production fallback", got)
	}
}

func TestPeriodicFrequencySyncsImportsAndUpdatesTimestamp(t *testing.T) {
	const interval = 15 * time.Millisecond
	n := nativeFixture(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(interval) }, nil)
	n.connect(t, "bidirectional")
	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency10Minutes)})
	eventually(t, "periodic worker running", func() bool {
		st := n.status(t)
		return st.Phase == vm.PhaseRunning && st.Frequency == vm.Frequency10Minutes
	})
	if n.client.Active() != 0 {
		t.Fatal("periodic mode started a continuous child")
	}
	initial := n.status(t)
	if initial.LastSyncedAt == nil {
		t.Fatal("initial one-shot did not record a timestamp")
	}
	base := n.client.count("sync")
	n.Clock.Advance(1000)
	eventually(t, "repeated periodic passes", func() bool {
		return n.client.count("sync") >= base+2
	})
	eventually(t, "periodic timestamp update", func() bool {
		st := n.status(t)
		return st.LastSyncedAt != nil && *st.LastSyncedAt > *initial.LastSyncedAt
	})

	write(t, filepath.Join(n.paths.Vault, "Periodic.md"), "# Periodic\n")
	eventually(t, "periodic import", func() bool {
		f, err := n.DB.VaultFiles().FindByPath(bg, n.vault.ID, "Periodic.md")
		return err == nil && f != nil
	})
	if n.client.Active() != 0 {
		t.Fatal("periodic mode started a continuous child")
	}
}

// Periodic (non-continuous) mode must not keep any Obsidian headless process
// alive between passes: each pass is a one-shot that exits, so idle memory is
// released. Only continuous mode holds a long-lived child.
func TestPeriodicModeLeavesNoHeadlessProcessBetweenPasses(t *testing.T) {
	n := nativeFixture(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(time.Hour) }, nil)
	n.connect(t, "bidirectional")
	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency10Minutes)})
	eventually(t, "periodic worker idle after initial pass", func() bool {
		return n.status(t).Phase == vm.PhaseRunning && n.client.count("sync") >= 1
	})
	if n.client.Active() != 0 || n.client.OneShotActive() != 0 {
		t.Fatalf("headless process alive while idle: continuous=%d oneShot=%d", n.client.Active(), n.client.OneShotActive())
	}
}

func TestPeriodicPassesNeverOverlap(t *testing.T) {
	const interval = 10 * time.Millisecond
	n := nativeFixture(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(interval) }, nil)
	n.connect(t, "bidirectional")
	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency10Minutes)})
	eventually(t, "periodic worker running", func() bool { return n.status(t).Phase == vm.PhaseRunning })

	release, started := n.client.gateOneShot()
	defer release()
	waitSignal(t, started, "gated one-shot pass")
	atStart := n.client.count("sync")
	time.Sleep(5 * interval)
	if got := n.client.OneShotActive(); got != 1 {
		t.Fatalf("active one-shot passes = %d, want 1", got)
	}
	if got := n.client.MaxOneShot(); got != 1 {
		t.Fatalf("overlapping one-shot passes = %d, want 1", got)
	}
	if got := n.client.count("sync"); got != atStart {
		t.Fatalf("sync started again while the previous pass was blocked: %d -> %d", atStart, got)
	}
	release()
	eventually(t, "next periodic pass after release", func() bool {
		return n.client.count("sync") > atStart
	})
}

func TestWriteNoteRestartsPeriodicWorker(t *testing.T) {
	const interval = 10 * time.Millisecond
	n := nativeFixture(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(interval) }, nil)
	n.connect(t, "bidirectional")
	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency10Minutes)})
	eventually(t, "periodic worker running", func() bool { return n.status(t).Phase == vm.PhaseRunning })
	file := n.files(t)[0]
	res, err := n.svc.WriteNote(bg, n.vault, httpx.NotePlan{Kind: "update", FileID: file.FileID, BaseHash: file.BlobHash}, "# Periodic edit\n")
	if err != nil || res.Status != "committed" {
		t.Fatalf("%+v %v", res, err)
	}
	eventually(t, "periodic worker resumed", func() bool {
		st := n.status(t)
		return st.Phase == vm.PhaseRunning && st.Frequency == vm.Frequency10Minutes
	})
	base := n.client.count("sync")
	eventually(t, "periodic passes resume after write", func() bool {
		return n.client.count("sync") > base
	})
	if n.client.Active() != 0 {
		t.Fatal("write restarted continuous sync in periodic mode")
	}
}

func TestFrequencyUpdateWhileEnabledRestartsWorkerAndReturnsToContinuous(t *testing.T) {
	const interval = 10 * time.Millisecond
	n := nativeFixture(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(interval) }, nil)
	n.connect(t, "bidirectional")
	if n.client.Active() != 1 {
		t.Fatal("continuous worker is not running")
	}
	before := n.client.count("sync")
	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency6Hours)})
	eventually(t, "periodic restart running", func() bool {
		st := n.status(t)
		return st.Phase == vm.PhaseRunning && st.Frequency == vm.Frequency6Hours
	})
	eventually(t, "periodic restart one-shot", func() bool { return n.client.count("sync") > before })
	if n.client.Active() != 0 {
		t.Fatal("periodic restart left a continuous child running")
	}

	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.FrequencyContinuous)})
	var st vm.ObsidianSyncSettings
	eventually(t, "continuous worker restarted and running", func() bool {
		if n.client.Active() != 1 {
			return false
		}
		// The pooled read-only connections may still be pinned to a
		// pre-restart snapshot, so read the row the worker just committed
		// through the write connection.
		if err := n.DB.Transaction(bg, func(repos db.TransactionRepositories) error {
			row, err := repos.ObsidianSync().Find(bg, n.vault.ID)
			if err != nil {
				return err
			}
			if row != nil {
				st = *row
			}
			return nil
		}); err != nil {
			t.Fatal(err)
		}
		return st.Frequency == vm.FrequencyContinuous && st.Phase == vm.PhaseRunning
	})
	if st.Frequency != vm.FrequencyContinuous || st.Phase != vm.PhaseRunning {
		t.Fatalf("status after continuous restart: %+v", st)
	}
}

func TestFrequencyUpdateWhilePausedPersistsWithoutLaunching(t *testing.T) {
	const interval = 10 * time.Millisecond
	n := nativeFixture(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(interval) }, nil)
	n.connect(t, "bidirectional")
	if err := n.svc.Enable(bg, n.vault, false); err != nil {
		t.Fatal(err)
	}
	before := n.status(t)
	if before.LastSyncedAt == nil {
		t.Fatal("paused status lost its timestamp")
	}
	base := n.client.count("sync")
	n.Clock.Advance(1000)
	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency30Minutes)})
	after := n.status(t)
	if after.Enabled || after.Phase != vm.PhaseStopped {
		t.Fatalf("paused frequency update changed enable/phase: %+v", after)
	}
	if after.Frequency != vm.Frequency30Minutes {
		t.Fatalf("frequency = %q", after.Frequency)
	}
	if after.LastSyncedAt == nil || *after.LastSyncedAt != *before.LastSyncedAt {
		t.Fatal("paused frequency update changed LastSyncedAt")
	}
	if after.HasSynced != before.HasSynced || !reflect.DeepEqual(after.LastErrorCode, before.LastErrorCode) {
		t.Fatal("paused frequency update changed sync state")
	}
	if n.client.Active() != 0 || n.client.count("sync") != base {
		t.Fatal("paused frequency update launched a worker")
	}

	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Enabled: boolPtr(true), Frequency: frequencyPtr(vm.Frequency1Hour)})
	eventually(t, "combined enable and frequency", func() bool {
		st := n.status(t)
		return st.Enabled && st.Phase == vm.PhaseRunning && st.Frequency == vm.Frequency1Hour
	})
	if n.client.Active() != 0 {
		t.Fatal("combined enable started a continuous child in periodic mode")
	}
}

func TestFrequencyUpdateOnEnabledVaultWithoutRemoteFailsWithoutMutation(t *testing.T) {
	n := nativeFixture(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(10 * time.Millisecond) }, nil)
	code := string(protocol.CodeObsidianSetupFailed)
	row := httpx.InitialObsidianSettings(n.vault.ID)
	row.Enabled = true
	row.Phase = vm.PhaseError
	row.LastErrorCode = &code
	if err := n.DB.ObsidianSync().Upsert(bg, row); err != nil {
		t.Fatal(err)
	}
	before := n.status(t)
	base := n.client.count("sync")

	err := n.svc.UpdateSettings(bg, n.vault, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency10Minutes)})
	wantCode(t, err, protocol.CodeObsidianSetupFailed)

	after := n.status(t)
	if !reflect.DeepEqual(after, before) {
		t.Fatalf("failed frequency update mutated settings: %+v -> %+v", before, after)
	}
	if n.client.Active() != 0 || n.client.count("sync") != base {
		t.Fatal("failed frequency update launched a worker")
	}
	// launch registers the worker before returning, so a worker started by
	// this update would still be visible here in practice.
	n.svc.mu.Lock()
	workers := len(n.svc.workers)
	n.svc.mu.Unlock()
	if workers != 0 {
		t.Fatalf("failed frequency update left %d worker(s) registered", workers)
	}
}

func TestEnableOnlyPreservesFrequency(t *testing.T) {
	const interval = 10 * time.Millisecond
	n := nativeFixture(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(interval) }, nil)
	n.connect(t, "bidirectional")
	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency6Hours)})
	eventually(t, "periodic worker running", func() bool { return n.status(t).Phase == vm.PhaseRunning })
	if err := n.svc.Enable(bg, n.vault, false); err != nil {
		t.Fatal(err)
	}
	if st := n.status(t); st.Frequency != vm.Frequency6Hours || st.Enabled || st.Phase != vm.PhaseStopped {
		t.Fatalf("enable-only pause changed frequency/state: %+v", st)
	}
	if err := n.svc.Enable(bg, n.vault, true); err != nil {
		t.Fatal(err)
	}
	eventually(t, "enable-only resume", func() bool {
		st := n.status(t)
		return st.Enabled && st.Phase == vm.PhaseRunning && st.Frequency == vm.Frequency6Hours
	})
	if n.client.Active() != 0 {
		t.Fatal("enable-only resume used continuous sync")
	}
}

func TestUpdateSettingsRejectsInvalidInputWithoutMutation(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	n.connect(t, "bidirectional")
	if err := n.svc.Enable(bg, n.vault, false); err != nil {
		t.Fatal(err)
	}
	before := n.status(t)
	bad := vm.ObsidianSyncFrequency("5m")
	wantCode(t, n.svc.UpdateSettings(bg, n.vault, httpx.ObsidianSettingsUpdate{Frequency: &bad}), protocol.CodeInvalidManifest)
	wantCode(t, n.svc.UpdateSettings(bg, n.vault, httpx.ObsidianSettingsUpdate{}), protocol.CodeInvalidManifest)
	if after := n.status(t); !reflect.DeepEqual(after, before) {
		t.Fatalf("invalid update mutated settings: %+v -> %+v", before, after)
	}
}

func TestPeriodicCancellationDoesNotSetErrorPhase(t *testing.T) {
	t.Run("waiting", func(t *testing.T) {
		n := nativeFixture(t, func(o *Options) {
			o.FrequencyInterval = func(vm.ObsidianSyncFrequency) time.Duration { return time.Hour }
		}, nil)
		n.connect(t, "bidirectional")
		n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency10Minutes)})
		eventually(t, "periodic worker running", func() bool { return n.status(t).Phase == vm.PhaseRunning })
		n.svc.Close()
		st := n.status(t)
		if st.Phase == vm.PhaseError || st.LastErrorCode != nil {
			t.Fatalf("cancellation during wait recorded an error: %+v", st)
		}
		if n.client.Active() != 0 {
			t.Fatal("child survived Close")
		}
	})

	t.Run("syncing", func(t *testing.T) {
		n := nativeFixture(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(10 * time.Millisecond) }, nil)
		n.connect(t, "bidirectional")
		n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency10Minutes)})
		eventually(t, "periodic worker running", func() bool { return n.status(t).Phase == vm.PhaseRunning })
		release, started := n.client.gateOneShot()
		defer release()
		waitSignal(t, started, "gated one-shot pass")
		n.svc.Close()
		release()
		st := n.status(t)
		if st.Phase == vm.PhaseError || st.LastErrorCode != nil {
			t.Fatalf("cancellation during sync recorded an error: %+v", st)
		}
		if n.client.Active() != 0 {
			t.Fatal("child survived Close")
		}
	})
}

func TestPeriodicSyncErrorsReturnToSupervisorRetry(t *testing.T) {
	const interval = 10 * time.Millisecond
	n := nativeFixture(t, func(o *Options) {
		o.FrequencyInterval = frequencyInterval(interval)
		o.RetryInterval = 10 * time.Millisecond
	}, nil)
	n.connect(t, "bidirectional")
	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency10Minutes)})
	eventually(t, "periodic worker running", func() bool { return n.status(t).Phase == vm.PhaseRunning })

	n.client.setFailure(NativeFailure(protocol.CodeObsidianSyncFailed))
	eventually(t, "periodic error phase", func() bool {
		st := n.status(t)
		return st.Enabled && st.Phase == vm.PhaseError && st.LastErrorCode != nil && *st.LastErrorCode == string(protocol.CodeObsidianSyncFailed)
	})
	n.client.setFailure(nil)
	eventually(t, "supervisor retry recovered", func() bool {
		st := n.status(t)
		return st.Enabled && st.Phase == vm.PhaseRunning && st.LastErrorCode == nil
	})
	if n.client.Active() != 0 {
		t.Fatal("periodic retry started continuous sync")
	}
}

func TestBootResumesPersistedPeriodicSettings(t *testing.T) {
	const interval = 10 * time.Millisecond
	n := nativeFixture(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(interval) }, nil)
	n.connect(t, "bidirectional")
	n.updateSettings(t, httpx.ObsidianSettingsUpdate{Frequency: frequencyPtr(vm.Frequency10Minutes)})
	eventually(t, "periodic worker running", func() bool { return n.status(t).Phase == vm.PhaseRunning })
	n.svc.Close()
	before := n.client.count("sync")

	recovered := n.newService(t, func(o *Options) { o.FrequencyInterval = frequencyInterval(interval) })
	if err := recovered.Boot(bg); err != nil {
		t.Fatal(err)
	}
	eventually(t, "boot resumed periodic passes", func() bool {
		return n.client.count("sync") >= before+2
	})
	eventually(t, "boot resumed running state", func() bool {
		st, err := recovered.Status(bg, n.vault)
		return err == nil && st.Enabled && st.Phase == vm.PhaseRunning && st.Frequency == vm.Frequency10Minutes
	})
	if n.client.Active() != 0 {
		t.Fatal("boot used continuous sync for a periodic vault")
	}
}

func TestBootTreatsEmptyFrequencyAsContinuous(t *testing.T) {
	n := nativeFixture(t, nil, func(d db.Database) db.Database { return emptyFrequencyDB{d} })
	n.connect(t, "bidirectional")
	n.svc.Close()
	// The wrapper keeps the stored row intact and only hides the frequency on
	// read, so this exercises EffectiveFrequency rather than Upsert normalizing
	// an empty value before Boot ever sees it.
	st, err := n.svc.Status(bg, n.vault)
	if err != nil {
		t.Fatal(err)
	}
	if st.Frequency != "" || st.EffectiveFrequency() != vm.FrequencyContinuous {
		t.Fatalf("fixture did not expose a legacy blank frequency: %+v", st)
	}
	recovered := n.newService(t, nil)
	if err := recovered.Boot(bg); err != nil {
		t.Fatal(err)
	}
	eventually(t, "empty frequency falls back to continuous", func() bool { return n.client.Active() == 1 })
	got, err := recovered.Status(bg, n.vault)
	if err != nil {
		t.Fatal(err)
	}
	if got.Frequency != "" || got.EffectiveFrequency() != vm.FrequencyContinuous {
		t.Fatalf("boot rewrote the legacy frequency: %+v", got)
	}
}

func TestAtomicNoteWriteCreatesPrivateFilesWithoutLeavingTemporaries(t *testing.T) {
	n := nativeFixture(t, nil, nil)
	paths, err := n.svc.privatePaths(n.vault)
	if err != nil {
		t.Fatal(err)
	}
	os.Mkdir(paths.Vault, 0o700)
	if err := AtomicNoteWrite(paths, "A/B/Note.md", []byte("hello")); err != nil {
		t.Fatal(err)
	}
	if read(t, filepath.Join(paths.Vault, "A/B/Note.md")) != "hello" || mode(t, filepath.Join(paths.Vault, "A/B/Note.md")) != 0o600 {
		t.Fatal("content or mode wrong")
	}
	if mode(t, filepath.Join(paths.Vault, "A")) != 0o700 {
		t.Fatal("parent mode wrong")
	}
	if entries, _ := os.ReadDir(paths.Tmp); len(entries) != 0 {
		t.Fatalf("temporary files left: %v", entries)
	}
}
