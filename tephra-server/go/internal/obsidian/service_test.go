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
