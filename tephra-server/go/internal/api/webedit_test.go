package api_test

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func writeToken(t *testing.T, s *testutil.Session, scopes ...string) string {
	t.Helper()
	list := `"` + strings.Join(scopes, `","`) + `"`
	r := testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/tokens", s.BrowserHeaders,
		fmt.Sprintf(`{"name":"scoped-%s","scopes":[%s]}`, strings.Join(scopes, "+"), list))
	if r.Status != 201 {
		t.Fatalf("token: %d %s", r.Status, r.Text())
	}
	return decode[struct{ Value string }](t, r).Value
}

func saveOK(t *testing.T, r testutil.Response) protocol.SaveContentResponse {
	t.Helper()
	if r.Status != 200 {
		t.Fatalf("save: %d %s", r.Status, r.Text())
	}
	out, err := protocol.ParseSaveContentResponse(r.Body)
	if err != nil {
		t.Fatalf("schema: %v: %s", err, r.Text())
	}
	return out
}

// recordingIndex is an IndexService with only indexVault, like vi.fn().
type recordingIndex struct {
	mu    sync.Mutex
	calls [][2]any
	ch    chan struct{}
}

func newRecordingIndex() *recordingIndex { return &recordingIndex{ch: make(chan struct{}, 16)} }

func (r *recordingIndex) IndexVault(_ context.Context, vaultID string, revision int64) error {
	r.mu.Lock()
	r.calls = append(r.calls, [2]any{vaultID, revision})
	r.mu.Unlock()
	r.ch <- struct{}{}
	return nil
}

func (r *recordingIndex) wait(t *testing.T) {
	t.Helper()
	select {
	case <-r.ch:
	case <-time.After(5 * time.Second):
		t.Fatal("indexVault was not called")
	}
}

func (r *recordingIndex) count() int { r.mu.Lock(); defer r.mu.Unlock(); return len(r.calls) }

func TestWebEditCommitsExactlyOneRevisionAndOneModifyRow(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ctx := context.Background()
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "hello", "markdown"}}, commitOpts{})
	updated := "hello edited"
	body := saveOK(t, putContent(s, s.BrowserHeaders, "note-1", updated, seeded[0].Hash, nil))
	if body.Status != "committed" || body.Revision != 2 || body.BlobHash != sha(updated) || body.Mtime <= 100 || body.Size != int64(len(updated)) {
		t.Fatalf("body = %+v", body)
	}
	if v, _ := s.DB.Vaults().FindByID(ctx, s.VaultID); v.LatestRevision != 2 {
		t.Fatalf("latestRevision = %d", v.LatestRevision)
	}
	if revs, _ := s.DB.VaultRevisions().List(ctx, s.VaultID); len(revs) != 2 {
		t.Fatalf("revisions = %d", len(revs))
	}
	rows, _ := s.DB.FileVersions().ListByRevision(ctx, s.VaultID, 2)
	if len(rows) != 1 || rows[0].FileID != "note-1" || rows[0].Path != "Note.md" || *rows[0].BlobHash != sha(updated) || rows[0].ChangeType != vm.ChangeModify {
		t.Fatalf("rows = %+v", rows)
	}
	f, _ := s.DB.VaultFiles().FindByID(ctx, s.VaultID, "note-1")
	if f.BlobHash != sha(updated) || f.Mtime != body.Mtime || f.UpdatedRevision != 2 {
		t.Fatalf("file = %+v", f)
	}
	owner, _ := s.DB.Users().FindByEmail(ctx, "owner@example.com")
	dev, _ := s.DB.Devices().FindByID(ctx, "web:"+owner.ID)
	if dev == nil || dev.UserID != owner.ID || dev.Name != "Tephra Web" || dev.Platform == nil || *dev.Platform != "web" {
		t.Fatalf("device = %+v", dev)
	}
	// The stored blob keeps the exact bytes and the request mime type.
	meta, _ := s.DB.Blobs().FindByHash(ctx, sha(updated))
	if meta == nil || meta.MimeType == nil || *meta.MimeType != "text/markdown; charset=utf-8" {
		t.Fatalf("blob meta = %+v", meta)
	}
	if b, ok := s.Blobs.Bytes(sha(updated)); !ok || string(b) != updated {
		t.Fatalf("blob bytes = %q", b)
	}
	// The manifest hash of the new revision is the canonical hash of the vault state.
	revs, _ := s.DB.VaultRevisions().List(ctx, s.VaultID)
	want, _ := protocol.HashManifest([]protocol.SyncManifestEntry{{FileID: "note-1", Path: "Note.md", Hash: sha(updated), Size: int64(len(updated)), Mtime: body.Mtime, Kind: "markdown"}})
	if revs[1].ManifestHash != want || revs[1].DeviceID != "web:"+owner.ID {
		t.Fatalf("revision = %+v want %s", revs[1], want)
	}
}

func TestWebEditReusesTheSyntheticWebDeviceAndNeverLogsContent(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ctx := context.Background()
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "hello", "markdown"}}, commitOpts{})
	secret := "second revision with hunter2-classified text"
	s.Logs.Reset()
	first := putContent(s, s.BrowserHeaders, "note-1", "first edit", seeded[0].Hash, nil)
	if first.Status != 200 {
		t.Fatalf("first: %d", first.Status)
	}
	second := putContent(s, s.BrowserHeaders, "note-1", secret, decode[struct{ BlobHash string }](t, first).BlobHash, nil)
	if second.Status != 200 {
		t.Fatalf("second: %d", second.Status)
	}
	owner, _ := s.DB.Users().FindByEmail(ctx, "owner@example.com")
	devices, _ := s.DB.Devices().ListByUser(ctx, owner.ID)
	n := 0
	for _, d := range devices {
		if d.ID == "web:"+owner.ID {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("web devices = %d", n)
	}
	text := s.Logs.String()
	if strings.Contains(text, secret) || strings.Contains(text, "first edit") || !strings.Contains(text, "file_id") {
		t.Fatalf("log = %s", text)
	}
}

func TestWebEditReturnsUpToDateAndCreatesNothingForByteIdenticalContent(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ctx := context.Background()
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "hello", "markdown"}}, commitOpts{})
	body := saveOK(t, putContent(s, s.BrowserHeaders, "note-1", "hello", seeded[0].Hash, nil))
	if body.Status != "up-to-date" || body.Revision != 1 || body.BlobHash != seeded[0].Hash || body.Mtime != 100 {
		t.Fatalf("body = %+v", body)
	}
	if revs, _ := s.DB.VaultRevisions().List(ctx, s.VaultID); len(revs) != 1 {
		t.Fatalf("revisions = %d", len(revs))
	}
	if rows, _ := s.DB.FileVersions().ListByRevision(ctx, s.VaultID, 2); len(rows) != 0 {
		t.Fatalf("rows = %+v", rows)
	}
	if devs, _ := s.DB.Devices().ListByUser(ctx, "nobody"); len(devs) != 0 {
		t.Fatal("no devices expected")
	}
}

func TestWebEditRejectsAStaleIfMatchWith409EditConflict(t *testing.T) {
	s := testutil.Setup(t, newApp)
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "v1", "markdown"}}, commitOpts{})
	second := putContent(s, s.BrowserHeaders, "note-1", "v2", seeded[0].Hash, nil)
	committed := decode[struct {
		BlobHash string
		Mtime    int64
	}](t, second)
	stale := putContent(s, s.BrowserHeaders, "note-1", "v3-stale", seeded[0].Hash, nil)
	if stale.Status != 409 {
		t.Fatalf("stale: %d %s", stale.Status, stale.Text())
	}
	body, err := protocol.ParseEditConflictResponse(stale.Body)
	if err != nil {
		t.Fatal(err)
	}
	if body.Error.Code != protocol.CodeEditConflict || body.Current.BlobHash != committed.BlobHash || body.Current.Mtime != committed.Mtime || body.Current.Revision != 2 {
		t.Fatalf("body = %+v", body)
	}
	if !strings.Contains(stale.Text(), `"error":{"code":"EDIT_CONFLICT","message":"The file changed since it was loaded."},"current":{`) {
		t.Fatalf("shape: %s", stale.Text())
	}
	if v, _ := s.DB.Vaults().FindByID(context.Background(), s.VaultID); v.LatestRevision != 2 {
		t.Fatalf("latestRevision = %d", v.LatestRevision)
	}
}

func TestWebEditAcceptsAnAngleBracketedAndQuotedIfMatchAndRequiresTheHeader(t *testing.T) {
	s := testutil.Setup(t, newApp)
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "v1", "markdown"}}, commitOpts{})
	if r := putContent(s, s.BrowserHeaders, "note-1", "v2", "<"+seeded[0].Hash+">", nil); r.Status != 200 {
		t.Fatalf("bracketed: %d %s", r.Status, r.Text())
	}
	v2 := sha("v2")
	if r := putContent(s, s.BrowserHeaders, "note-1", "v3", `"`+v2+`"`, nil); r.Status != 200 {
		t.Fatalf("quoted: %d %s", r.Status, r.Text())
	}
	wantErr(t, putContent(s, s.BrowserHeaders, "note-1", "v4", "", nil), 400, "INVALID_MANIFEST", "An If-Match header with the base content hash is required.")
	wantErr(t, putContent(s, s.BrowserHeaders, "note-1", "v4", "not-a-hash", nil), 400, "INVALID_MANIFEST", "If-Match must be a SHA-256 hash of the base content.")
}

func TestWebEditRejectsNonMarkdownFilesAndSizeMismatches(t *testing.T) {
	s := testutil.Setup(t, newApp)
	image := commitSeeds(t, s, []seed{{"img-1", "img.png", "png-bytes", "attachment"}}, commitOpts{})
	wantErr(t, putContent(s, s.BrowserHeaders, "img-1", "nope", image[0].Hash, nil), 400, "INVALID_MANIFEST", "Only Markdown files can be edited from the web.")
	note := commitSeeds(t, s, []seed{
		{"img-1", "img.png", "png-bytes", "attachment"},
		{"note-1", "Note.md", "hello", "markdown"},
	}, commitOpts{deviceID: "device-2"})
	mismatch := putContent(s, s.BrowserHeaders, "note-1", "hello!", note[1].Hash, testutil.Headers{"x-tephra-content-size": "9999"})
	wantErr(t, mismatch, 400, "INVALID_MANIFEST", "Uploaded size does not match the declared size.")
	short := putContent(s, s.BrowserHeaders, "note-1", "hello!", note[1].Hash, testutil.Headers{"x-tephra-content-size": "2"})
	wantErr(t, short, 400, "INVALID_MANIFEST", "Uploaded size does not match the declared size.")
	wantErr(t, putContent(s, s.BrowserHeaders, "nope", "x", note[1].Hash, nil), 404, "VAULT_NOT_FOUND", "File was not found.")
	wantErr(t, putContent(s, s.BrowserHeaders, "note-1", "x", note[1].Hash, testutil.Headers{"x-tephra-content-size": "zzz"}), 400, "INVALID_MANIFEST", "A valid content size is required.")
}

func TestWebEditRejectsOversizedContentWith413(t *testing.T) {
	s := testutil.Setup(t, newApp, testutil.WithMaxBlobBytes(16))
	seeded := commitSeeds(t, s, []seed{
		{"note-1", "Note.md", "tiny", "markdown"},
		{"note-2", "Other.md", "tiny", "markdown"},
	}, commitOpts{})
	r := putContent(s, s.BrowserHeaders, "note-2", "this text is definitely longer than sixteen bytes", seeded[1].Hash, nil)
	wantErr(t, r, 413, "BLOB_TOO_LARGE", "Content exceeds the configured size limit.")
}

func TestWebEditForbidsUploadOnlyTokensAndAllowsWriteTokens(t *testing.T) {
	s := testutil.Setup(t, newApp)
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "hello", "markdown"}}, commitOpts{})
	wantErr(t, putContent(s, testutil.Bearer(s.Token), "note-1", "edit", seeded[0].Hash, nil), 403, "VAULT_ACCESS_DENIED", "")
	writer := writeToken(t, s, "vault:read-metadata", "vault:write")
	r := putContent(s, testutil.Bearer(writer), "note-1", "edit", seeded[0].Hash, nil)
	if saveOK(t, r).Status != "committed" {
		t.Fatalf("body = %s", r.Text())
	}
}

func TestWebEditKeepsMtimeStrictlyGreaterThanThePreviousFileMtime(t *testing.T) {
	s := testutil.Setup(t, newApp)
	future := testutil.FixedNow + 500
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "hello", "markdown"}}, commitOpts{mtime: future})
	body := saveOK(t, putContent(s, s.BrowserHeaders, "note-1", "hello!", seeded[0].Hash, nil))
	if body.Mtime != future+1 {
		t.Fatalf("mtime = %d want %d", body.Mtime, future+1)
	}
}

func TestWebEditRecordsAnEditThenRevertAsANewRevision(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ctx := context.Background()
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "original", "markdown"}}, commitOpts{})
	edited := putContent(s, s.BrowserHeaders, "note-1", "edited", seeded[0].Hash, nil)
	editedHash := decode[struct{ BlobHash string }](t, edited).BlobHash
	body := saveOK(t, putContent(s, s.BrowserHeaders, "note-1", "original", editedHash, nil))
	if body.Status != "committed" || body.Revision != 3 || body.BlobHash != seeded[0].Hash {
		t.Fatalf("body = %+v", body)
	}
	revs, _ := s.DB.VaultRevisions().List(ctx, s.VaultID)
	var nums []int64
	for _, r := range revs {
		nums = append(nums, r.Revision)
	}
	if fmt.Sprint(nums) != "[1 2 3]" {
		t.Fatalf("revisions = %v", nums)
	}
	if r, _ := s.DB.VaultRevisions().FindByManifestHash(ctx, s.VaultID, revs[2].ManifestHash); r == nil || r.Revision != 3 {
		t.Fatalf("newest-wins lookup = %+v", r)
	}
	rows, _ := s.DB.FileVersions().ListByRevision(ctx, s.VaultID, 3)
	if len(rows) != 1 || rows[0].ChangeType != vm.ChangeModify {
		t.Fatalf("rows = %+v", rows)
	}
}

func TestWebEditSerializesConcurrentSavesOneCommitsOneConflicts(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ctx := context.Background()
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "base", "markdown"}}, commitOpts{})
	var wg sync.WaitGroup
	statuses := make([]int, 2)
	for i, text := range []string{"writer one", "writer two"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			statuses[i] = putContent(s, s.BrowserHeaders, "note-1", text, seeded[0].Hash, nil).Status
		}()
	}
	wg.Wait()
	sort.Ints(statuses)
	if fmt.Sprint(statuses) != "[200 409]" {
		t.Fatalf("statuses = %v", statuses)
	}
	if v, _ := s.DB.Vaults().FindByID(ctx, s.VaultID); v.LatestRevision != 2 {
		t.Fatalf("latestRevision = %d", v.LatestRevision)
	}
	if rows, _ := s.DB.FileVersions().ListByRevision(ctx, s.VaultID, 2); len(rows) != 1 {
		t.Fatalf("rows = %d", len(rows))
	}
}

func TestWebEditTriggersIndexVaultAndDropsTheGraphCacheRowOnCommit(t *testing.T) {
	idx := newRecordingIndex()
	s := testutil.Setup(t, newApp, testutil.WithIndexService(idx))
	ctx := context.Background()
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "hello", "markdown"}}, commitOpts{})
	idx.wait(t) // the seed commit's indexing pass
	_ = s.DB.GraphCache().Upsert(ctx, db.GraphCacheEntry{VaultID: s.VaultID, Revision: 1, IndexedRevision: 1, ETag: `W/"1-1-graph-v2"`, PayloadJSON: "{}", UpdatedAt: 1})
	if r := putContent(s, s.BrowserHeaders, "note-1", "edited", seeded[0].Hash, nil); r.Status != 200 {
		t.Fatalf("edit: %d", r.Status)
	}
	idx.wait(t)
	idx.mu.Lock()
	last := idx.calls[len(idx.calls)-1]
	idx.mu.Unlock()
	if last[0] != s.VaultID || last[1] != int64(2) {
		t.Fatalf("indexVault args = %v", last)
	}
	if c, _ := s.DB.GraphCache().Find(ctx, s.VaultID); c != nil {
		t.Fatal("graph cache row must be dropped")
	}
}

func TestWebEditLeavesTheGraphCacheRowAloneWhenTheSaveIsANoOp(t *testing.T) {
	idx := newRecordingIndex()
	s := testutil.Setup(t, newApp, testutil.WithIndexService(idx))
	ctx := context.Background()
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "hello", "markdown"}}, commitOpts{})
	idx.wait(t)
	_ = s.DB.GraphCache().Upsert(ctx, db.GraphCacheEntry{VaultID: s.VaultID, Revision: 1, IndexedRevision: 1, ETag: `W/"1-1-graph-v2"`, PayloadJSON: "{}", UpdatedAt: 1})
	if idx.count() != 1 {
		t.Fatalf("index calls = %d", idx.count())
	}
	if r := putContent(s, s.BrowserHeaders, "note-1", "hello", seeded[0].Hash, nil); r.Status != 200 {
		t.Fatalf("noop: %d", r.Status)
	}
	time.Sleep(50 * time.Millisecond)
	if idx.count() != 1 {
		t.Fatalf("no-op save must not index (calls = %d)", idx.count())
	}
	if c, _ := s.DB.GraphCache().Find(ctx, s.VaultID); c == nil {
		t.Fatal("graph cache row must stay")
	}
}

func TestWebEditAcceptsTheWriteScopeWithoutChangingTokenDefaults(t *testing.T) {
	s := testutil.Setup(t, newApp)
	writeToken(t, s, "vault:write")
	writeToken(t, s, "vault:read-metadata", "vault:upload", "vault:write")
	r := testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/tokens", s.BrowserHeaders, `{"name":"Defaulted"}`)
	created := decode[struct{ Token struct{ Scopes []string } }](t, r)
	if r.Status != 201 || strings.Join(created.Token.Scopes, ",") != "vault:read-metadata,vault:upload" {
		t.Fatalf("scopes = %v", created.Token.Scopes)
	}
}

func TestWebEditRequiresAuthentication(t *testing.T) {
	f := testutil.NewFixture(t)
	app := newApp(f.Deps)
	r := testutil.Do(app, "PUT", "/api/v1/vaults/vault-x/files/file-y/content", testutil.Headers{"if-match": strings.Repeat("a", 64)}, []byte("x"))
	wantErr(t, r, 401, "AUTH_REQUIRED", "")
}

func TestWebEditStreamsLargeBodiesWithoutLosingBytes(t *testing.T) {
	s := testutil.Setup(t, newApp)
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "small", "markdown"}}, commitOpts{})
	big := strings.Repeat("0123456789abcdef", 200_000) // 3.2 MB: exceeds the in-memory spool
	body := saveOK(t, putContent(s, s.BrowserHeaders, "note-1", big, seeded[0].Hash, nil))
	if body.Size != int64(len(big)) || body.BlobHash != sha(big) {
		t.Fatalf("body = %+v", body)
	}
	if b, ok := s.Blobs.Bytes(sha(big)); !ok || string(b) != big {
		t.Fatal("stored blob differs from the upload")
	}
}

type stubObsidian struct {
	httpx.ObsidianSyncService
	result httpx.NoteCommitResult
	plan   httpx.NotePlan
	text   string
}

func (s *stubObsidian) WriteNote(_ context.Context, _ vm.Vault, plan httpx.NotePlan, text string) (httpx.NoteCommitResult, error) {
	s.plan, s.text = plan, text
	return s.result, nil
}

func TestWebEditOnObsidianVaultsDelegatesToTheNativeService(t *testing.T) {
	stub := &stubObsidian{}
	s := testutil.Setup(t, newApp, testutil.WithDeps(func(d *httpx.Dependencies) { d.ObsidianSync = stub }))
	ctx := context.Background()
	owner, _ := s.DB.Users().FindByEmail(ctx, "owner@example.com")
	_ = s.DB.Vaults().Insert(ctx, vm.Vault{ID: "ov", OwnerUserID: owner.ID, Name: "OV", SyncMode: vm.SyncModeObsidian, CreatedAt: 1, UpdatedAt: 1})
	_ = s.DB.Blobs().Insert(ctx, vm.BlobMetadata{Hash: sha("old"), Size: 3, CreatedAt: 1})
	_ = s.DB.VaultFiles().Upsert(ctx, vm.CurrentVaultFile{FileID: "n1", VaultID: "ov", Path: "N.md", BlobHash: sha("old"), Size: 3, Mtime: 5, Kind: vm.KindMarkdown, UpdatedRevision: 1})
	do := func(body []byte, ifMatch string) testutil.Response {
		h := testutil.Headers{}
		for k, v := range s.BrowserHeaders {
			h[k] = v
		}
		h["if-match"] = ifMatch
		h["x-tephra-content-size"] = fmt.Sprint(len(body))
		return testutil.Do(s.App, "PUT", "/api/v1/vaults/ov/files/n1/content", h, body)
	}
	wantErr(t, do([]byte{0xff, 0xfe}, sha("old")), 400, "INVALID_MANIFEST", "Markdown content must be UTF-8.")
	cur := vm.CurrentVaultFile{BlobHash: sha("new"), Size: 3, Mtime: 9, UpdatedRevision: 4}
	stub.result = httpx.NoteCommitResult{Status: "conflict", Current: &cur}
	r := do([]byte("\xef\xbb\xbfhello"), sha("old"))
	if r.Status != 409 || !strings.Contains(r.Text(), `"current":{"blobHash":"`+sha("new")+`","size":3,"mtime":9,"revision":4}`) {
		t.Fatalf("conflict = %d %s", r.Status, r.Text())
	}
	if stub.plan.Kind != "update" || stub.plan.FileID != "n1" || stub.plan.BaseHash != sha("old") || stub.text != "\xef\xbb\xbfhello" {
		t.Fatalf("plan = %+v text = %q", stub.plan, stub.text)
	}
	file := vm.CurrentVaultFile{BlobHash: sha("hello"), Size: 5, Mtime: 12}
	stub.result = httpx.NoteCommitResult{Status: "committed", Revision: 7, File: &file}
	r = do([]byte("hello"), sha("old"))
	if r.Status != 200 || r.Text() != `{"status":"committed","revision":7,"blobHash":"`+sha("hello")+`","size":5,"mtime":12}` {
		t.Fatalf("committed = %d %s", r.Status, r.Text())
	}
}
