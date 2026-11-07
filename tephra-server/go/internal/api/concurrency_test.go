package api_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"net/http/httptest"
	"runtime"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore/fs"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/indexer"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
)

// realFixture mirrors realFixture() in sync-concurrency-perf.test.ts: real
// SQLite plus filesystem blobs. The app gets no index service so commits stay
// synchronous and tests drive indexing explicitly.
func realFixture(t *testing.T) *testutil.Session {
	t.Helper()
	store, err := fs.New(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return testutil.Setup(t, newApp, testutil.WithDatabase(testutil.OpenSQLite(t)),
		testutil.WithDeps(func(d *httpx.Dependencies) { d.BlobStore = store }))
}

func mdEntry(fileID, path, content string) protocol.SyncManifestEntry {
	mime := "text/markdown"
	return protocol.SyncManifestEntry{FileID: fileID, Path: path, Hash: sha(content), Size: int64(len(content)), Mtime: testutil.FixedNow, MimeType: &mime, Kind: "markdown"}
}

func TestConcurrentCommitsSerializeIntoRevisions1ToNWithLastWriterWinsState(t *testing.T) {
	s := realFixture(t)
	ctx := context.Background()
	const count = 8
	type manifest struct {
		deviceID string
		files    []protocol.SyncManifestEntry
		body     []byte
		hash     string
	}
	var manifests []manifest
	for i := 0; i < count; i++ {
		content := fmt.Sprintf("# Concurrent note %d\n\nBody for device %d.\n", i, i)
		if r := putBlob(t, s, s.Token, s.VaultID, content, "text/markdown"); r.Status != 200 {
			t.Fatalf("upload: %d %s", r.Status, r.Text())
		}
		files := []protocol.SyncManifestEntry{mdEntry(fmt.Sprintf("concurrent-file-%d", i), fmt.Sprintf("Concurrent-%d.md", i), content)}
		h, _ := protocol.HashManifest(files)
		dev := fmt.Sprintf("concurrent-device-%d", i)
		manifests = append(manifests, manifest{dev, files, sortedBody(t, dev, files), h})
	}
	type result struct {
		Status   string
		Revision int64
	}
	results := make([]result, count)
	var wg sync.WaitGroup
	for i, m := range manifests {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := commitManifest(s, s.Token, s.VaultID, m.deviceID, m.body)
			if r.Status != 200 {
				t.Errorf("commit %d: %d %s", i, r.Status, r.Text())
				return
			}
			results[i] = decode[result](t, r)
		}()
	}
	wg.Wait()
	var revisions []int64
	for _, r := range results {
		if r.Status != "committed" {
			t.Fatalf("results = %+v", results)
		}
		revisions = append(revisions, r.Revision)
	}
	sort.Slice(revisions, func(i, j int) bool { return revisions[i] < revisions[j] })
	for i, r := range revisions {
		if r != int64(i+1) {
			t.Fatalf("revisions = %v", revisions)
		}
	}
	listing := decode[struct {
		Revision int
		Files    []struct{ FileID, Path, BlobHash string }
	}](t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files"))
	if listing.Revision != count || len(listing.Files) != 1 {
		t.Fatalf("listing = %+v", listing)
	}
	var winner *manifest
	for i := range manifests {
		if manifests[i].files[0].FileID == listing.Files[0].FileID {
			winner = &manifests[i]
		}
	}
	if winner == nil || listing.Files[0].Path != winner.files[0].Path || listing.Files[0].BlobHash != winner.files[0].Hash {
		t.Fatalf("winner mismatch: %+v", listing.Files)
	}
	stored, _ := s.DB.VaultRevisions().List(ctx, s.VaultID)
	if len(stored) != count {
		t.Fatalf("stored revisions = %d", len(stored))
	}
	hashes := map[string]bool{}
	for i, rev := range stored {
		hashes[rev.ManifestHash] = true
		if rev.Revision != int64(i+1) {
			t.Fatalf("revision gap: %+v", stored)
		}
	}
	for _, m := range manifests {
		if !hashes[m.hash] {
			t.Fatalf("missing manifest hash %s", m.hash)
		}
	}
	total := 0
	for rev := int64(1); rev <= count; rev++ {
		v, _ := s.DB.FileVersions().ListByRevision(ctx, s.VaultID, rev)
		if len(v) == 0 {
			t.Fatalf("revision %d has no versions", rev)
		}
		total += len(v)
	}
	if total != 1+(count-1)*2 {
		t.Fatalf("version rows = %d", total)
	}
	for _, m := range manifests {
		v, _ := s.DB.FileVersions().ListByFile(ctx, s.VaultID, m.files[0].FileID)
		created := false
		for _, row := range v {
			created = created || row.ChangeType == "create"
		}
		if !created {
			t.Fatalf("no create row for %s", m.files[0].FileID)
		}
	}
}

func TestConcurrentDevicesCommittingTheSameIDSetConvergeOntoOneRevision(t *testing.T) {
	s := realFixture(t)
	alpha, beta := "# Alpha\n\nShared content.\n", "# Beta\n\nShared content.\n"
	putBlob(t, s, s.Token, s.VaultID, alpha, "text/markdown")
	putBlob(t, s, s.Token, s.VaultID, beta, "text/markdown")
	files := []protocol.SyncManifestEntry{mdEntry("file-alpha", "Notes/Alpha.md", alpha), mdEntry("file-beta", "Notes/Beta.md", beta)}
	type result struct {
		Status   string
		Revision int64
	}
	out := make([]result, 2)
	var wg sync.WaitGroup
	for i, dev := range []string{"device-a", "device-b"} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r := commitManifest(s, s.Token, s.VaultID, dev, sortedBody(t, dev, files))
			if r.Status != 200 {
				t.Errorf("%s: %d %s", dev, r.Status, r.Text())
				return
			}
			out[i] = decode[result](t, r)
		}()
	}
	wg.Wait()
	statuses := []string{out[0].Status, out[1].Status}
	sort.Strings(statuses)
	if strings.Join(statuses, ",") != "committed,up-to-date" || out[0].Revision != 1 || out[1].Revision != 1 {
		t.Fatalf("out = %+v", out)
	}
	listing := decode[struct {
		Revision int
		Files    []struct{ FileID, Path string }
	}](t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files"))
	var pairs []string
	for _, f := range listing.Files {
		pairs = append(pairs, f.Path+"="+f.FileID)
	}
	sort.Strings(pairs)
	if listing.Revision != 1 || strings.Join(pairs, ",") != "Notes/Alpha.md=file-alpha,Notes/Beta.md=file-beta" {
		t.Fatalf("listing = %+v", listing)
	}
	if revs, _ := s.DB.VaultRevisions().List(context.Background(), s.VaultID); len(revs) != 1 {
		t.Fatalf("revisions = %d", len(revs))
	}
}

func TestCommitsAboutFiveHundredCrossLinkedNotesIndexesAndServesTheGraph(t *testing.T) {
	s := realFixture(t)
	ctx := context.Background()
	const count = 500
	pad := func(i int) string { return fmt.Sprintf("Note-%04d", i) }
	start := time.Now()
	var files []protocol.SyncManifestEntry
	bodies := map[string]string{}
	for i := 0; i < count; i++ {
		first, second := pad((i+1)%count), pad((i+7)%count)
		md := fmt.Sprintf("---\ntitle: %s\n---\n# %s\n\nConnects to [[%s]] and [[%s|alias for %s]].\n\n", pad(i), pad(i), first, second, second) +
			strings.Repeat(fmt.Sprintf("Filler sentence %d to give the note realistic body text. ", i), 6) + "\n"
		e := mdEntry(fmt.Sprintf("perf-file-%d", i), fmt.Sprintf("notes/%s.md", pad(i)), md)
		bodies[e.Hash] = md
		files = append(files, e)
	}
	for off := 0; off < count; off += 50 {
		var wg sync.WaitGroup
		for _, f := range files[off : off+50] {
			wg.Add(1)
			go func() {
				defer wg.Done()
				if r := putBlob(t, s, s.Token, s.VaultID, bodies[f.Hash], "text/markdown"); r.Status != 200 {
					t.Errorf("upload: %d %s", r.Status, r.Text())
				}
			}()
		}
		wg.Wait()
	}
	body := sortedBody(t, "perf-device", files)
	commit := commitManifest(s, s.Token, s.VaultID, "perf-device", body)
	wantCommit := fmt.Sprintf(`{"status":"committed","revision":1,"protocolVersion":%q,"minimumPluginVersion":%q}`, protocol.ProtocolVersion, protocol.MinimumPluginVersion)
	if commit.Status != 200 || commit.Text() != wantCommit {
		t.Fatalf("commit = %d %s", commit.Status, commit.Text())
	}
	svc := indexer.NewRuntimeIndexService(indexer.RuntimeDeps{Database: s.DB, BlobStore: s.Deps.BlobStore, Clock: s.Clock, IDs: s.Deps.IDs})
	if err := svc.IndexVault(ctx, s.VaultID, 1); err != nil {
		t.Fatal(err)
	}
	if st, _ := s.DB.NoteIndex().GetState(ctx, s.VaultID); st == nil || st.IndexedRevision != 1 {
		t.Fatalf("state = %+v", st)
	}
	if meta, _ := s.DB.NoteIndex().ListMetadata(ctx, s.VaultID); len(meta) != count {
		t.Fatalf("metadata = %d", len(meta))
	}
	graph := decode[graphBody](t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/graph"))
	if graph.Revision != 1 || len(graph.Nodes) != count || len(graph.Edges) == 0 {
		t.Fatalf("graph: rev=%d nodes=%d edges=%d", graph.Revision, len(graph.Nodes), len(graph.Edges))
	}
	// Recommitting the identical manifest is a no-op and plan reports up-to-date.
	if r := commitManifest(s, s.Token, s.VaultID, "perf-device", body); r.Text() != strings.Replace(wantCommit, "committed", "up-to-date", 1) {
		t.Fatalf("recommit = %s", r.Text())
	}
	plan := testutil.Do(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/sync/plan", authJSON(s.Token), body)
	wantPlan := fmt.Sprintf(`{"status":"up-to-date","latestRevision":1,"missingBlobs":[],"protocolVersion":%q,"minimumPluginVersion":%q}`, protocol.ProtocolVersion, protocol.MinimumPluginVersion)
	if plan.Text() != wantPlan {
		t.Fatalf("plan = %s", plan.Text())
	}
	if revs, _ := s.DB.VaultRevisions().List(ctx, s.VaultID); len(revs) != 1 {
		t.Fatalf("revisions = %d", len(revs))
	}
	if elapsed := time.Since(start); elapsed > 30*time.Second {
		t.Fatalf("took %s", elapsed)
	}
}

func TestBlobUploadStreamsLargeBodiesToTheFilesystemStore(t *testing.T) {
	s := realFixture(t)
	big := strings.Repeat("0123456789abcdef", 1<<18) // 4 MiB
	r := putBlob(t, s, s.Token, s.VaultID, big, "application/octet-stream")
	if r.Status != 200 || r.Text() != `{"hash":"`+sha(big)+`","stored":true}` {
		t.Fatalf("upload = %d %s", r.Status, r.Text())
	}
	back := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/none/raw")
	if back.Status != 404 {
		t.Fatalf("unexpected: %d", back.Status)
	}
	// Corrupt body of the same declared size is rejected and leaves no blob row.
	bad := strings.Repeat("x", len(big))
	h := testutil.Bearer(s.Token)
	h["x-tephra-blob-size"] = fmt.Sprint(len(big))
	wantErr(t, testutil.Do(s.App, "PUT", "/api/v1/vaults/"+s.VaultID+"/blobs/"+sha(big+"!"), h, []byte(bad)), 400, "BLOB_HASH_MISMATCH", "Uploaded content does not match the declared SHA-256 hash.")
	if m, _ := s.DB.Blobs().FindByHash(context.Background(), sha(big+"!")); m != nil {
		t.Fatal("mismatched upload recorded metadata")
	}
}

// patternReader yields n deterministic bytes without ever holding them.
type patternReader struct{ left int64 }

func (p *patternReader) Read(b []byte) (int, error) {
	if p.left <= 0 {
		return 0, io.EOF
	}
	n := int64(len(b))
	if n > p.left {
		n = p.left
	}
	for i := int64(0); i < n; i++ {
		b[i] = byte('a' + (p.left-i)%23)
	}
	p.left -= n
	return int(n), nil
}

// The point of the port is low memory: a 64 MiB upload must not allocate
// anything near its size (it is hashed and written in small chunks).
func TestBlobUploadDoesNotBufferTheWholeBody(t *testing.T) {
	s := realFixture(t)
	const size = 64 << 20
	h := sha256.New()
	if _, err := io.Copy(h, &patternReader{left: size}); err != nil {
		t.Fatal(err)
	}
	hash := hex.EncodeToString(h.Sum(nil))
	req := httptest.NewRequest("PUT", "/api/v1/vaults/"+s.VaultID+"/blobs/"+hash, &patternReader{left: size})
	req.ContentLength = size
	req.Header.Set("Authorization", "Bearer "+s.Token)
	req.Header.Set("X-Tephra-Blob-Size", fmt.Sprint(size))
	rec := httptest.NewRecorder()
	var before, after runtime.MemStats
	runtime.GC()
	runtime.ReadMemStats(&before)
	s.App.ServeHTTP(rec, req)
	runtime.ReadMemStats(&after)
	if rec.Code != 200 {
		t.Fatalf("upload = %d %s", rec.Code, rec.Body.String())
	}
	if alloc := after.TotalAlloc - before.TotalAlloc; alloc > 16<<20 {
		t.Fatalf("upload of %d bytes allocated %d bytes", size, alloc)
	}
	if m, _ := s.DB.Blobs().FindByHash(context.Background(), hash); m == nil || m.Size != size {
		t.Fatalf("meta = %+v", m)
	}
}
