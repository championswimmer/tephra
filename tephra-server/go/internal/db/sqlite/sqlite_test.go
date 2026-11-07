package sqlite

import (
	"context"
	"database/sql"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

var ctx = context.Background()

func ptr[T any](v T) *T { return &v }

func openTemp(t *testing.T) (*DB, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "tephra.db")
	d, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = d.Close() })
	return d, path
}

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func mustFail(t *testing.T, err error, msg string) {
	t.Helper()
	if err == nil {
		t.Fatal("expected error, got nil")
	}
	if msg != "" && !strings.Contains(err.Error(), msg) {
		t.Fatalf("error %q does not contain %q", err, msg)
	}
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v\nwant %#v", got, want)
	}
}

func hash(c string) string { return strings.Repeat(c, 64) }

func seed(t *testing.T, d *DB) {
	t.Helper()
	must(t, d.Users().Insert(ctx, vm.User{ID: "user-1", Email: "one@example.com", CreatedAt: 1, UpdatedAt: 1}))
	must(t, d.Vaults().Insert(ctx, vm.Vault{ID: "vault-1", OwnerUserID: "user-1", Name: "Vault", CreatedAt: 2, UpdatedAt: 2}))
	must(t, d.Devices().Insert(ctx, vm.Device{ID: "device-1", UserID: "user-1", Name: "Phone", Platform: ptr("mobile"), CreatedAt: 3, LastSeenAt: 3}))
	must(t, d.Blobs().Insert(ctx, vm.BlobMetadata{Hash: hash("a"), Size: 5, MimeType: ptr("text/markdown"), CreatedAt: 4}))
}

func file(id, vault, path string, rev int64) vm.CurrentVaultFile {
	return vm.CurrentVaultFile{FileID: id, VaultID: vault, Path: path, BlobHash: hash("a"), Size: 5, Mtime: 1, Kind: vm.KindMarkdown, UpdatedRevision: rev}
}

func revision(rev int64, manifest string, created int64) vm.VaultRevision {
	return vm.VaultRevision{VaultID: "vault-1", Revision: rev, ManifestHash: manifest, DeviceID: "device-1", CreatedAt: created}
}

func token(id, tokenHash string, scopes []vm.ApiTokenScope) vm.ApiToken {
	return vm.ApiToken{ID: id, UserID: "user-1", VaultID: ptr("vault-1"), TokenHash: tokenHash, Name: "Sync", Scopes: scopes, CreatedAt: 1}
}

func TestImplementsInterfaces(t *testing.T) {
	var _ db.Database = (*DB)(nil)
	var _ db.TransactionRepositories = (*txRepos)(nil)
}

func TestRepositoriesPersistAfterReopening(t *testing.T) {
	d, path := openTemp(t)
	seed(t, d)
	must(t, d.Sessions().Insert(ctx, vm.Session{ID: "session-1", UserID: "user-1", ExpiresAt: 10, CreatedAt: 4}))
	must(t, d.ApiTokens().Insert(ctx, vm.ApiToken{ID: "token-1", UserID: "user-1", VaultID: ptr("vault-1"), DeviceID: ptr("device-1"), TokenHash: "secret-hash", Name: "Sync", Scopes: []vm.ApiTokenScope{vm.ScopeVaultUpload, vm.ScopeVaultReadMetadata}, CreatedAt: 5}))
	must(t, d.VaultRevisions().Insert(ctx, revision(1, "manifest-1", 6)))
	f := file("file-1", "vault-1", "Note.md", 1)
	f.Mtime, f.MimeType = 7, ptr("text/markdown")
	must(t, d.VaultFiles().Upsert(ctx, f))
	must(t, d.FileVersions().InsertMany(ctx, []vm.FileVersion{{ID: "version-1", VaultID: "vault-1", FileID: "file-1", Revision: 1, Path: "Note.md", BlobHash: ptr(hash("a")), Size: ptr(int64(5)), Mtime: ptr(int64(7)), ChangeType: vm.ChangeCreate, CreatedAt: 6}}))
	meta := vm.NoteMetadata{FileID: "file-1", VaultID: "vault-1", IndexedBlobHash: hash("a"), Title: ptr("Note"),
		Frontmatter: map[string]any{"nested": map[string]any{"enabled": true}, "count": float64(2)},
		Headings:    []any{map[string]any{"text": "Title"}}, Tags: []string{"one", "two"}, Blocks: []any{map[string]any{"id": "block"}}, IndexedAt: 8}
	must(t, d.NoteIndex().UpsertMetadata(ctx, meta))
	link := vm.NoteLink{ID: "link-1", VaultID: "vault-1", SourceFileID: "file-1", RawText: "[[Note]]", LinkPath: "Note", TargetFileID: ptr("file-1"), CreatedAt: 8}
	must(t, d.NoteIndex().ReplaceLinksForSource(ctx, "vault-1", "file-1", []vm.NoteLink{link}))
	must(t, d.NoteIndex().SetState(ctx, vm.VaultIndexState{VaultID: "vault-1", IndexedRevision: 1}))

	n, err := d.Users().Count(ctx)
	must(t, err)
	eq(t, n, int64(1))
	u, err := d.Users().FindByEmail(ctx, "one@example.com")
	must(t, err)
	eq(t, u.ID, "user-1")
	s, err := d.Sessions().FindByID(ctx, "session-1")
	must(t, err)
	if s == nil {
		t.Fatal("session missing")
	}
	vs, _ := d.Vaults().ListByOwner(ctx, "user-1")
	eq(t, len(vs), 1)
	devs, _ := d.Devices().ListByUser(ctx, "user-1")
	eq(t, len(devs), 1)
	eq(t, *devs[0].Platform, "mobile")
	tok, err := d.ApiTokens().FindByTokenHash(ctx, "secret-hash")
	must(t, err)
	eq(t, tok.Scopes, []vm.ApiTokenScope{"vault:upload", "vault:read-metadata"})
	bs, _ := d.Blobs().FindByHashes(ctx, []string{"missing", hash("a")})
	eq(t, len(bs), 1)
	byPath, _ := d.VaultFiles().FindByPath(ctx, "vault-1", "Note.md")
	eq(t, byPath.FileID, "file-1")
	latest, _ := d.VaultRevisions().FindLatest(ctx, "vault-1")
	eq(t, latest.Revision, int64(1))
	byManifest, _ := d.VaultRevisions().FindByManifestHash(ctx, "vault-1", "manifest-1")
	if byManifest == nil {
		t.Fatal("manifest missing")
	}
	vers, _ := d.FileVersions().ListByFile(ctx, "vault-1", "file-1")
	eq(t, len(vers), 1)
	gotMeta, err := d.NoteIndex().FindMetadata(ctx, "file-1")
	must(t, err)
	eq(t, *gotMeta, meta)
	bySrc, _ := d.NoteIndex().ListLinksBySource(ctx, "vault-1", "file-1")
	eq(t, bySrc, []vm.NoteLink{link})
	byTgt, _ := d.NoteIndex().ListLinksByTarget(ctx, "vault-1", "file-1")
	eq(t, byTgt, []vm.NoteLink{link})
	st, _ := d.NoteIndex().GetState(ctx, "vault-1")
	eq(t, *st, vm.VaultIndexState{VaultID: "vault-1", IndexedRevision: 1})

	must(t, d.Close())
	re, err := Open(path)
	must(t, err)
	defer re.Close()
	u2, _ := re.Users().FindByID(ctx, "user-1")
	eq(t, u2.Email, "one@example.com")
	ms, _ := re.NoteIndex().ListMetadata(ctx, "vault-1")
	eq(t, ms, []vm.NoteMetadata{meta})
	rs, _ := re.VaultRevisions().List(ctx, "vault-1")
	eq(t, len(rs), 1)
}

func TestTransactionRollbackAndForeignKeys(t *testing.T) {
	d, _ := openTemp(t)
	err := d.Transaction(ctx, func(r db.TransactionRepositories) error {
		must(t, r.Users().Insert(ctx, vm.User{ID: "rollback", Email: "rollback@example.com", CreatedAt: 1, UpdatedAt: 1}))
		return fmt.Errorf("fail")
	})
	mustFail(t, err, "fail")
	u, err := d.Users().FindByID(ctx, "rollback")
	must(t, err)
	if u != nil {
		t.Fatal("rolled back user still present")
	}
	mustFail(t, d.Sessions().Insert(ctx, vm.Session{ID: "orphan", UserID: "missing", ExpiresAt: 1, CreatedAt: 1}), "")

	// Panics roll back too, and the panic propagates.
	func() {
		defer func() {
			if recover() == nil {
				t.Fatal("expected panic")
			}
		}()
		_ = d.Transaction(ctx, func(r db.TransactionRepositories) error {
			_ = r.Users().Insert(ctx, vm.User{ID: "panic", Email: "p@example.com", CreatedAt: 1, UpdatedAt: 1})
			panic("boom")
		})
	}()
	u, _ = d.Users().FindByID(ctx, "panic")
	if u != nil {
		t.Fatal("panicked transaction was committed")
	}
	// The write connection is usable afterwards, and commits are visible.
	out, err := db.InTransaction(ctx, d, func(r db.TransactionRepositories) (int64, error) {
		must(t, r.Users().Insert(ctx, vm.User{ID: "ok", Email: "ok@example.com", CreatedAt: 1, UpdatedAt: 1}))
		return r.Users().Count(ctx)
	})
	must(t, err)
	eq(t, out, int64(1))
	u, _ = d.Users().FindByID(ctx, "ok")
	if u == nil {
		t.Fatal("committed user missing")
	}
}

func TestUniqueConstraints(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	mustFail(t, d.Users().Insert(ctx, vm.User{ID: "user-2", Email: "one@example.com", CreatedAt: 1, UpdatedAt: 1}), "")
	must(t, d.ApiTokens().Insert(ctx, token("token-1", "same", []vm.ApiTokenScope{})))
	mustFail(t, d.ApiTokens().Insert(ctx, token("token-2", "same", []vm.ApiTokenScope{})), "")
	must(t, d.VaultFiles().Upsert(ctx, file("file-1", "vault-1", "same.md", 1)))
	mustFail(t, d.VaultFiles().Upsert(ctx, file("file-2", "vault-1", "same.md", 1)), "")
	must(t, d.VaultRevisions().Insert(ctx, revision(1, "same-manifest", 1)))
	// Since 005 the manifest hash is a plain index; newest wins.
	must(t, d.VaultRevisions().Insert(ctx, revision(2, "same-manifest", 2)))
	r, _ := d.VaultRevisions().FindByManifestHash(ctx, "vault-1", "same-manifest")
	eq(t, r.Revision, int64(2))
}

func TestVaultNamesUniqueCaseSensitive(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	v, _ := d.Vaults().FindByName(ctx, "Vault")
	eq(t, v.ID, "vault-1")
	v, _ = d.Vaults().FindByName(ctx, "vault")
	if v != nil {
		t.Fatal("case-insensitive match")
	}
	v, _ = d.Vaults().FindByName(ctx, "Missing")
	if v != nil {
		t.Fatal("unexpected vault")
	}
	mustFail(t, d.Vaults().Insert(ctx, vm.Vault{ID: "vault-2", OwnerUserID: "user-1", Name: "Vault", CreatedAt: 3, UpdatedAt: 3}), "")
	must(t, d.Vaults().Insert(ctx, vm.Vault{ID: "vault-3", OwnerUserID: "user-1", Name: "vault", CreatedAt: 3, UpdatedAt: 3}))
	v, _ = d.Vaults().FindByName(ctx, "vault")
	eq(t, v.ID, "vault-3")
}

func TestVaultDeletionCascades(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	tk := token("token-1", "secret-hash", []vm.ApiTokenScope{vm.ScopeVaultUpload})
	tk.DeviceID = ptr("device-1")
	must(t, d.ApiTokens().Insert(ctx, tk))
	must(t, d.VaultRevisions().Insert(ctx, revision(1, "manifest-1", 6)))
	must(t, d.VaultFiles().Upsert(ctx, file("file-1", "vault-1", "Note.md", 1)))
	must(t, d.FileVersions().InsertMany(ctx, []vm.FileVersion{{ID: "version-1", VaultID: "vault-1", FileID: "file-1", Revision: 1, Path: "Note.md", BlobHash: ptr(hash("a")), Size: ptr(int64(5)), Mtime: ptr(int64(7)), ChangeType: vm.ChangeCreate, CreatedAt: 6}}))
	must(t, d.NoteIndex().UpsertMetadata(ctx, vm.NoteMetadata{FileID: "file-1", VaultID: "vault-1", IndexedBlobHash: hash("a"), Title: ptr("Note"), IndexedAt: 8}))
	must(t, d.NoteIndex().ReplaceLinksForSource(ctx, "vault-1", "file-1", []vm.NoteLink{{ID: "link-1", VaultID: "vault-1", SourceFileID: "file-1", RawText: "[[Note]]", LinkPath: "Note", TargetFileID: ptr("file-1"), CreatedAt: 8}}))
	must(t, d.NoteIndex().SetState(ctx, vm.VaultIndexState{VaultID: "vault-1", IndexedRevision: 1}))

	must(t, d.Vaults().Delete(ctx, "vault-1"))

	if v, _ := d.Vaults().FindByID(ctx, "vault-1"); v != nil {
		t.Fatal("vault remains")
	}
	if v, _ := d.ApiTokens().FindByID(ctx, "token-1"); v != nil {
		t.Fatal("token remains")
	}
	if v, _ := d.VaultFiles().FindByID(ctx, "vault-1", "file-1"); v != nil {
		t.Fatal("file remains")
	}
	if v, _ := d.VaultRevisions().FindLatest(ctx, "vault-1"); v != nil {
		t.Fatal("revision remains")
	}
	vers, _ := d.FileVersions().ListByFile(ctx, "vault-1", "file-1")
	eq(t, vers, []vm.FileVersion{})
	if v, _ := d.NoteIndex().FindMetadata(ctx, "file-1"); v != nil {
		t.Fatal("metadata remains")
	}
	links, _ := d.NoteIndex().ListLinksBySource(ctx, "vault-1", "file-1")
	eq(t, links, []vm.NoteLink{})
	if v, _ := d.NoteIndex().GetState(ctx, "vault-1"); v != nil {
		t.Fatal("state remains")
	}
	if b, _ := d.Blobs().FindByHash(ctx, hash("a")); b == nil {
		t.Fatal("blob must survive")
	}
}

func TestTransactionsAreSerialised(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	var mu sync.Mutex
	var events []string
	add := func(e string) { mu.Lock(); events = append(events, e); mu.Unlock() }
	release := make(chan struct{})
	started := make(chan struct{})
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		must(t, d.Transaction(ctx, func(r db.TransactionRepositories) error {
			must(t, r.LockVault(ctx, "vault-1"))
			add("first-start")
			close(started)
			<-release
			add("first-end")
			return nil
		}))
	}()
	<-started
	go func() {
		defer wg.Done()
		must(t, d.Transaction(ctx, func(r db.TransactionRepositories) error {
			must(t, r.LockVault(ctx, "vault-1"))
			add("second")
			return nil
		}))
	}()
	time.Sleep(100 * time.Millisecond)
	mu.Lock()
	eq(t, events, []string{"first-start"})
	mu.Unlock()
	close(release)
	wg.Wait()
	eq(t, events, []string{"first-start", "first-end", "second"})

	err := d.Transaction(ctx, func(r db.TransactionRepositories) error { return r.LockVault(ctx, "nope") })
	mustFail(t, err, "Vault not found: nope")
}

func TestReadersDoNotBlockOnOpenTransaction(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	entered, release := make(chan struct{}), make(chan struct{})
	done := make(chan error, 1)
	go func() {
		done <- d.Transaction(ctx, func(r db.TransactionRepositories) error {
			if err := r.Users().Insert(ctx, vm.User{ID: "u2", Email: "u2@example.com", CreatedAt: 1, UpdatedAt: 1}); err != nil {
				return err
			}
			close(entered)
			<-release
			return nil
		})
	}()
	<-entered
	n, err := d.Users().Count(ctx) // read pool, sees the pre-commit snapshot
	must(t, err)
	eq(t, n, int64(1))
	close(release)
	must(t, <-done)
	n, _ = d.Users().Count(ctx)
	eq(t, n, int64(2))
}

func TestDeleteExpiredSessions(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	must(t, d.Sessions().Insert(ctx, vm.Session{ID: "old", UserID: "user-1", ExpiresAt: 5, CreatedAt: 1}))
	must(t, d.Sessions().Insert(ctx, vm.Session{ID: "new", UserID: "user-1", ExpiresAt: 15, CreatedAt: 1}))
	n, err := d.Sessions().DeleteExpired(ctx, 5)
	must(t, err)
	eq(t, n, int64(1))
	if s, _ := d.Sessions().FindByID(ctx, "new"); s == nil {
		t.Fatal("new session removed")
	}
}

func TestFindUnreferencedOlderThan(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	referenced, oldOrphan, recentOrphan, versionOnly := hash("b"), hash("c"), hash("d"), hash("e")
	for _, b := range []struct {
		h string
		c int64
	}{{referenced, 10}, {oldOrphan, 10}, {recentOrphan, 100}, {versionOnly, 10}} {
		must(t, d.Blobs().Insert(ctx, vm.BlobMetadata{Hash: b.h, Size: 1, CreatedAt: b.c}))
	}
	f := file("file-1", "vault-1", "Note.md", 1)
	f.BlobHash, f.Size = referenced, 1
	must(t, d.VaultFiles().Upsert(ctx, f))
	must(t, d.VaultRevisions().Insert(ctx, revision(1, "manifest-1", 11)))
	must(t, d.FileVersions().InsertMany(ctx, []vm.FileVersion{{ID: "version-1", VaultID: "vault-1", FileID: "file-9", Revision: 1, Path: "Old.md", BlobHash: &versionOnly, Size: ptr(int64(1)), Mtime: ptr(int64(1)), ChangeType: vm.ChangeCreate, CreatedAt: 11}}))
	hashes := func(cutoff int64, limit int) []string {
		bs, err := d.Blobs().FindUnreferencedOlderThan(ctx, cutoff, limit)
		must(t, err)
		out := []string{}
		for _, b := range bs {
			out = append(out, b.Hash)
		}
		return out
	}
	eq(t, hashes(50, 10), []string{hash("a"), oldOrphan})
	eq(t, hashes(50, 1), []string{hash("a")})
	eq(t, hashes(50, 0), []string{})
	eq(t, hashes(4, 10), []string{})
}

func TestFileIDIsolatedAcrossVaults(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	must(t, d.Vaults().Insert(ctx, vm.Vault{ID: "vault-2", OwnerUserID: "user-1", Name: "Second", CreatedAt: 3, UpdatedAt: 3}))
	must(t, d.VaultFiles().Upsert(ctx, file("file-1", "vault-1", "Note.md", 1)))
	must(t, d.VaultFiles().Upsert(ctx, file("file-1", "vault-2", "Note.md", 1)))
	a, _ := d.VaultFiles().FindByID(ctx, "vault-1", "file-1")
	b, _ := d.VaultFiles().FindByID(ctx, "vault-2", "file-1")
	eq(t, a.VaultID, "vault-1")
	eq(t, b.VaultID, "vault-2")
	renamed := file("file-1", "vault-1", "Renamed.md", 2)
	renamed.Mtime = 2
	must(t, d.VaultFiles().Upsert(ctx, renamed))
	a, _ = d.VaultFiles().FindByID(ctx, "vault-1", "file-1")
	b, _ = d.VaultFiles().FindByID(ctx, "vault-2", "file-1")
	eq(t, a.Path, "Renamed.md")
	eq(t, b.Path, "Note.md")
	must(t, d.VaultFiles().Delete(ctx, "vault-1", "file-1"))
	if a, _ = d.VaultFiles().FindByID(ctx, "vault-1", "file-1"); a != nil {
		t.Fatal("vault-1 file remains")
	}
	if b, _ = d.VaultFiles().FindByID(ctx, "vault-2", "file-1"); b == nil {
		t.Fatal("vault-2 file removed")
	}
}

func TestPathFoldAndLatestByPath(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	must(t, d.VaultFiles().Upsert(ctx, file("file-1", "vault-1", "Notes/Hello.md", 1)))
	must(t, d.VaultFiles().Upsert(ctx, file("file-2", "vault-1", "NOTES/HELLO.md", 1)))
	must(t, d.VaultFiles().Upsert(ctx, file("file-3", "vault-1", "Dir/ÜBER.md", 1)))
	got, _ := d.VaultFiles().FindByPathFold(ctx, "vault-1", "notes/hello.md")
	ids := []string{}
	for _, f := range got {
		ids = append(ids, f.FileID)
	}
	eq(t, ids, []string{"file-2", "file-1"}) // ORDER BY path: "NOTES/..." < "Notes/..."
	none, _ := d.VaultFiles().FindByPathFold(ctx, "vault-1", "notes/missing.md")
	eq(t, none, []vm.CurrentVaultFile{})
	uni, _ := d.VaultFiles().FindByPathFold(ctx, "vault-1", "dir/über.md")
	eq(t, len(uni), 1) // full-Unicode fold, not SQLite's ASCII lower()

	must(t, d.VaultRevisions().Insert(ctx, revision(1, "manifest-1", 5)))
	must(t, d.VaultRevisions().Insert(ctx, revision(2, "manifest-2", 6)))
	v := func(id string, rev int64, ct vm.FileChangeType) vm.FileVersion {
		return vm.FileVersion{ID: id, VaultID: "vault-1", FileID: "file-1", Revision: rev, Path: "Old.md", BlobHash: ptr(hash("a")), Size: ptr(int64(5)), Mtime: ptr(int64(1)), ChangeType: ct, CreatedAt: 5 + rev}
	}
	must(t, d.FileVersions().InsertMany(ctx, []vm.FileVersion{v("version-1", 1, vm.ChangeCreate), v("version-2", 2, vm.ChangeRename)}))
	latest, _ := d.FileVersions().FindLatestByPath(ctx, "vault-1", "Old.md")
	eq(t, latest.ID, "version-2")
	eq(t, latest.Revision, int64(2))
	if m, _ := d.FileVersions().FindLatestByPath(ctx, "vault-1", "Missing.md"); m != nil {
		t.Fatal("unexpected version")
	}
	since, _ := d.FileVersions().ListSince(ctx, "vault-1", 1, 10)
	eq(t, len(since), 1)
	none2, _ := d.FileVersions().ListSince(ctx, "vault-1", 0, 0)
	eq(t, none2, []vm.FileVersion{})
	byRev, _ := d.FileVersions().ListByRevision(ctx, "vault-1", 2)
	eq(t, len(byRev), 1)
}

func TestInsertManyIsAtomic(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	must(t, d.VaultRevisions().Insert(ctx, revision(1, "m", 1)))
	mk := func(id string) vm.FileVersion {
		return vm.FileVersion{ID: id, VaultID: "vault-1", FileID: "f", Revision: 1, Path: "p", BlobHash: ptr(hash("a")), Size: ptr(int64(1)), Mtime: ptr(int64(1)), ChangeType: vm.ChangeCreate, CreatedAt: 1}
	}
	mustFail(t, d.FileVersions().InsertMany(ctx, []vm.FileVersion{mk("x"), mk("x")}), "")
	got, _ := d.FileVersions().ListByRevision(ctx, "vault-1", 1)
	eq(t, len(got), 0)
}

func TestGraphCache(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	if g, _ := d.GraphCache().Find(ctx, "vault-1"); g != nil {
		t.Fatal("unexpected entry")
	}
	entry := db.GraphCacheEntry{VaultID: "vault-1", Revision: 1, IndexedRevision: 1, ETag: `W/"1-1-graph-v2"`, PayloadJSON: `{"revision":1}`, UpdatedAt: 9}
	must(t, d.GraphCache().Upsert(ctx, entry))
	got, _ := d.GraphCache().Find(ctx, "vault-1")
	eq(t, *got, entry)
	entry.Revision, entry.IndexedRevision, entry.ETag = 2, 2, `W/"2-2-graph-v2"`
	must(t, d.GraphCache().Upsert(ctx, entry))
	got, _ = d.GraphCache().Find(ctx, "vault-1")
	eq(t, got.Revision, int64(2))
	eq(t, got.IndexedRevision, int64(2))
	must(t, d.GraphCache().DeleteByVault(ctx, "vault-1"))
	if g, _ := d.GraphCache().Find(ctx, "vault-1"); g != nil {
		t.Fatal("entry remains")
	}
}

// rawDB opens a plain connection (foreign keys on, like the TS test helper).
func rawDB(t *testing.T, path string) *sql.DB {
	t.Helper()
	raw, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(1)")
	must(t, err)
	raw.SetMaxOpenConns(1)
	t.Cleanup(func() { _ = raw.Close() })
	return raw
}

func rawExec(t *testing.T, raw *sql.DB, q string) {
	t.Helper()
	if _, err := raw.Exec(q); err != nil {
		t.Fatalf("%s: %v", q, err)
	}
}

func TestUpgradesPrePathFoldV2Database(t *testing.T) {
	d, path := openTemp(t)
	seed(t, d)
	must(t, d.VaultFiles().Upsert(ctx, file("file-1", "vault-1", "Notes/Hello.md", 1)))
	must(t, d.Close())
	raw := rawDB(t, path)
	for _, q := range []string{
		"DROP INDEX IF EXISTS vault_files_path_fold_idx",
		"ALTER TABLE vault_files DROP COLUMN path_fold",
		"DROP TABLE obsidian_sync",
		"DROP TRIGGER vault_sync_mode_immutable",
		"ALTER TABLE vaults DROP COLUMN sync_mode",
		"PRAGMA user_version = 2",
	} {
		rawExec(t, raw, q)
	}
	rows, err := raw.Query("PRAGMA table_info(vault_files)")
	must(t, err)
	for rows.Next() {
		var cid int
		var name, typ string
		var notnull, pk int
		var dflt sql.NullString
		must(t, rows.Scan(&cid, &name, &typ, &notnull, &dflt, &pk))
		if name == "path_fold" {
			t.Fatal("path_fold still present")
		}
	}
	rows.Close()
	must(t, raw.Close())

	up, err := Open(path)
	must(t, err)
	defer up.Close()
	must(t, up.VaultFiles().Upsert(ctx, file("file-2", "vault-1", "Notes/World.md", 2)))
	h, _ := up.VaultFiles().FindByPath(ctx, "vault-1", "Notes/Hello.md")
	eq(t, h.FileID, "file-1")
	fold := func(p string) []string {
		fs, err := up.VaultFiles().FindByPathFold(ctx, "vault-1", p)
		must(t, err)
		out := []string{}
		for _, f := range fs {
			out = append(out, f.FileID)
		}
		return out
	}
	eq(t, fold("notes/hello.md"), []string{"file-1"})
	eq(t, fold("notes/world.md"), []string{"file-2"})
}

func TestUpgradesOldDatabasesThroughLatest(t *testing.T) {
	files := map[int]string{1: "001_initial.sql", 2: "002_vault_name_unique.sql", 3: "003_vault_files_path_fold.sql", 4: "004_graph_cache.sql"}
	for start := 1; start <= 4; start++ {
		t.Run(fmt.Sprintf("v%d", start), func(t *testing.T) {
			path := filepath.Join(t.TempDir(), "tephra.db")
			hash1, hash2, blob := strings.Repeat("a1", 32), strings.Repeat("b2", 32), strings.Repeat("c3", 32)
			legacy := rawDB(t, path)
			for v := 1; v <= start; v++ {
				body, err := migrationFS.ReadFile("migrations/" + files[v])
				must(t, err)
				if _, err := legacy.Exec(string(body)); err != nil {
					t.Fatal(err)
				}
			}
			rawExec(t, legacy, fmt.Sprintf(`INSERT INTO users VALUES ('user-1', 'one@example.com', NULL, 1, 1);
         INSERT INTO vaults VALUES ('vault-1', 'user-1', 'Vault', 2, 2, 2);
         INSERT INTO devices VALUES ('device-1', 'user-1', 'Phone', 'mobile', 3, 3);
         INSERT INTO blobs VALUES ('%[1]s', 5, 'text/markdown', 4);
         INSERT INTO vault_revisions VALUES ('vault-1', 1, '%[2]s', 'device-1', 5);
         INSERT INTO vault_revisions VALUES ('vault-1', 2, '%[3]s', 'device-1', 6);
         INSERT INTO file_versions
           (id, vault_id, file_id, revision, path, blob_hash, size, mtime, change_type, created_at)
           VALUES ('version-1', 'vault-1', 'file-1', 1, 'Note.md', '%[1]s', 5, 7, 'create', 5),
                  ('version-2', 'vault-1', 'file-1', 2, 'Note.md', '%[1]s', 6, 8, 'modify', 6);
         INSERT INTO vault_files
           (file_id, vault_id, path, blob_hash, size, mtime, mime_type, kind, updated_revision)
           VALUES ('file-1', 'vault-1', 'Note.md', '%[1]s', 6, 8, 'text/markdown', 'markdown', 2);
         PRAGMA user_version = %[4]d;`, blob, hash1, hash2, start))
			must(t, legacy.Close())

			up, err := Open(path)
			must(t, err)
			revs, _ := up.VaultRevisions().List(ctx, "vault-1")
			eq(t, len(revs), 2)
			v1, _ := up.FileVersions().ListByRevision(ctx, "vault-1", 1)
			v2, _ := up.FileVersions().ListByRevision(ctx, "vault-1", 2)
			eq(t, len(v1), 1)
			eq(t, len(v2), 1)
			f, _ := up.VaultFiles().FindByID(ctx, "vault-1", "file-1")
			eq(t, f.Path, "Note.md")
			eq(t, f.UpdatedRevision, int64(2))
			must(t, up.VaultRevisions().Insert(ctx, vm.VaultRevision{VaultID: "vault-1", Revision: 3, ManifestHash: hash1, DeviceID: "device-1", CreatedAt: 30}))
			r, _ := up.VaultRevisions().FindByManifestHash(ctx, "vault-1", hash1)
			eq(t, r.Revision, int64(3))
			r, _ = up.VaultRevisions().FindByManifestHash(ctx, "vault-1", hash2)
			eq(t, r.Revision, int64(2))
			must(t, up.Close())

			raw := rawDB(t, path)
			var uv int
			must(t, raw.QueryRow("PRAGMA user_version").Scan(&uv))
			eq(t, uv, 7)
			fk, err := raw.Query("PRAGMA foreign_key_check")
			must(t, err)
			if fk.Next() {
				t.Fatal("foreign_key_check reported violations")
			}
			fk.Close()
			var n int
			must(t, raw.QueryRow("SELECT count(*) FROM sqlite_master WHERE type='index' AND name='vault_revisions_manifest_idx'").Scan(&n))
			eq(t, n, 1)
			idx, err := raw.Query("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='vault_revisions'")
			must(t, err)
			for idx.Next() {
				var s sql.NullString
				must(t, idx.Scan(&s))
				if strings.Contains(s.String, "UNIQUE") {
					t.Fatalf("unique index remains: %s", s.String)
				}
			}
			idx.Close()
		})
	}
}

func TestOpenRejectsNewerSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "tephra.db")
	raw := rawDB(t, path)
	rawExec(t, raw, "PRAGMA user_version = 99")
	must(t, raw.Close())
	_, err := Open(path)
	mustFail(t, err, "newer than supported")
}

func TestOAuthCodesConsumeOnce(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	code := db.OAuthCode{CodeHash: "h1", UserID: "user-1", VaultID: "vault-1", ClientID: "c", ClientName: "Claude Code", RedirectURI: "http://127.0.0.1:1/cb", CodeChallenge: strings.Repeat("x", 43), Scopes: []vm.ApiTokenScope{vm.ScopeVaultReadMetadata}, CreatedAt: 10, ExpiresAt: 70}
	must(t, d.OAuthCodes().Insert(ctx, code))
	second := code
	second.CodeHash, second.ExpiresAt = "h2", 20
	must(t, d.OAuthCodes().Insert(ctx, second))
	got, err := d.OAuthCodes().Consume(ctx, "h1")
	must(t, err)
	eq(t, *got, code)
	again, err := d.OAuthCodes().Consume(ctx, "h1")
	must(t, err)
	if again != nil {
		t.Fatal("code consumed twice")
	}
	n, err := d.OAuthCodes().DeleteExpired(ctx, 30)
	must(t, err)
	eq(t, n, int64(1))
	if c, _ := d.OAuthCodes().Consume(ctx, "h2"); c != nil {
		t.Fatal("expired code consumable")
	}
}

func TestOAuthConsumeConcurrentlyYieldsOneWinner(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	must(t, d.OAuthCodes().Insert(ctx, db.OAuthCode{CodeHash: "race", UserID: "user-1", VaultID: "vault-1", ClientID: "c", ClientName: "n", RedirectURI: "r", CodeChallenge: "x", Scopes: []vm.ApiTokenScope{}, CreatedAt: 1, ExpiresAt: 99}))
	var wg sync.WaitGroup
	wins := make(chan bool, 16)
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			c, err := d.OAuthCodes().Consume(ctx, "race")
			must(t, err)
			wins <- c != nil
		}()
	}
	wg.Wait()
	close(wins)
	n := 0
	for w := range wins {
		if w {
			n++
		}
	}
	eq(t, n, 1)
}

func TestInvalidScopesRejected(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	mustFail(t, d.ApiTokens().Insert(ctx, token("t", "h", []vm.ApiTokenScope{"bogus"})), "Invalid API token scopes")
	// nil scopes persist as [] and read back as an empty (non-nil) slice.
	must(t, d.ApiTokens().Insert(ctx, token("t2", "h2", nil)))
	got, _ := d.ApiTokens().FindByID(ctx, "t2")
	eq(t, got.Scopes, []vm.ApiTokenScope{})
}

func TestReadyCheckAndClose(t *testing.T) {
	d, _ := openTemp(t)
	must(t, d.ReadyCheck(ctx))
	must(t, d.Close())
	must(t, d.Close())
	if d.ReadyCheck(ctx) == nil {
		t.Fatal("ReadyCheck must fail after Close")
	}
}

func TestMemoryDatabase(t *testing.T) {
	d, err := Open(":memory:")
	must(t, err)
	defer d.Close()
	seed(t, d)
	must(t, d.Transaction(ctx, func(r db.TransactionRepositories) error {
		return r.Users().Insert(ctx, vm.User{ID: "u2", Email: "u2@example.com", CreatedAt: 1, UpdatedAt: 1})
	}))
	n, _ := d.Users().Count(ctx)
	eq(t, n, int64(2))
}

func TestNilSlicesReadBackEmpty(t *testing.T) {
	d, _ := openTemp(t)
	seed(t, d)
	must(t, d.VaultFiles().Upsert(ctx, file("file-1", "vault-1", "Note.md", 1)))
	must(t, d.NoteIndex().UpsertMetadata(ctx, vm.NoteMetadata{FileID: "file-1", VaultID: "vault-1", IndexedBlobHash: hash("a"), IndexedAt: 1}))
	m, _ := d.NoteIndex().FindMetadata(ctx, "file-1")
	eq(t, m.Frontmatter, map[string]any{})
	eq(t, m.Headings, []any{})
	eq(t, m.Tags, []string{})
	eq(t, m.Blocks, []any{})
	vs, _ := d.Vaults().ListByOwner(ctx, "nobody")
	eq(t, vs, []vm.Vault{})
}

func TestObsidianSyncPersistence(t *testing.T) {
	d, path := openTemp(t)
	seed(t, d)
	existing, _ := d.Vaults().FindByID(ctx, "vault-1")
	eq(t, existing.SyncMode, vm.SyncModeTephra)
	native := *existing
	native.ID, native.Name, native.SyncMode = "native-vault", "Native", vm.SyncModeObsidian
	must(t, d.Vaults().Insert(ctx, native))
	settings := vm.ObsidianSyncSettings{VaultID: native.ID, Enabled: true, RemoteVaultID: ptr("remote-1"), Mode: vm.ObsidianModeBidirectional, Phase: vm.PhaseRunning, HasSynced: true, LastSyncedAt: ptr(int64(12345))}
	must(t, d.ObsidianSync().Upsert(ctx, settings))
	got, _ := d.ObsidianSync().Find(ctx, native.ID)
	eq(t, *got, settings)
	changed := native
	changed.SyncMode = vm.SyncModeTephra
	mustFail(t, d.Vaults().Update(ctx, changed), "immutable")
	// Updating without a syncMode keeps the stored one.
	changed.SyncMode = ""
	changed.Name = "Renamed"
	must(t, d.Vaults().Update(ctx, changed))
	v, _ := d.Vaults().FindByID(ctx, native.ID)
	eq(t, v.SyncMode, vm.SyncModeObsidian)
	eq(t, v.Name, "Renamed")
	must(t, d.Close())

	re, err := Open(path)
	must(t, err)
	defer re.Close()
	list, _ := re.ObsidianSync().List(ctx)
	eq(t, list, []vm.ObsidianSyncSettings{settings})
	v, _ = re.Vaults().FindByID(ctx, native.ID)
	eq(t, v.SyncMode, vm.SyncModeObsidian)
	must(t, re.Vaults().Delete(ctx, native.ID))
	list, _ = re.ObsidianSync().List(ctx)
	eq(t, list, []vm.ObsidianSyncSettings{})
}
