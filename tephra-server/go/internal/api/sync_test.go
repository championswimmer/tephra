package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// ---- shared helpers (ports of the commitFiles/putContent test helpers) ----

type seed struct {
	fileID, path, content, kind string
}

type commitOpts struct {
	deviceID string
	mtime    int64
	mime     string
}

func sha(content string) string { return protocol.SHA256Hex([]byte(content)) }

func authJSON(token string) testutil.Headers {
	return testutil.Headers{"authorization": "Bearer " + token, "content-type": "application/json"}
}

func putBlob(t *testing.T, s *testutil.Session, token, vaultID, content, mime string) testutil.Response {
	t.Helper()
	h := testutil.Headers{"authorization": "Bearer " + token, "x-tephra-blob-size": fmt.Sprint(len(content))}
	if mime != "" {
		h["content-type"] = mime
	}
	return testutil.Do(s.App, "PUT", "/api/v1/vaults/"+vaultID+"/blobs/"+sha(content), h, []byte(content))
}

func sortedBody(t *testing.T, deviceID string, files []protocol.SyncManifestEntry) []byte {
	t.Helper()
	hash, err := protocol.HashManifest(files)
	if err != nil {
		t.Fatal(err)
	}
	sorted := append([]protocol.SyncManifestEntry(nil), files...)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].Path < sorted[j].Path })
	if sorted == nil {
		sorted = []protocol.SyncManifestEntry{}
	}
	b, err := json.Marshal(map[string]any{"deviceId": deviceID, "manifestHash": hash, "files": sorted})
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func commitManifest(s *testutil.Session, token, vaultID, deviceID string, body []byte) testutil.Response {
	return testutil.Do(s.App, "POST", "/api/v1/vaults/"+vaultID+"/sync/commit", authJSON(token), body)
}

// commitSeeds uploads each seed and commits the complete manifest (asserting 200).
func commitSeeds(t *testing.T, s *testutil.Session, entries []seed, o commitOpts) []protocol.SyncManifestEntry {
	t.Helper()
	if o.deviceID == "" {
		o.deviceID = "device-1"
	}
	if o.mtime == 0 {
		o.mtime = 100
	}
	var files []protocol.SyncManifestEntry
	for _, e := range entries {
		if r := putBlob(t, s, s.Token, s.VaultID, e.content, ""); r.Status != 200 {
			t.Fatalf("upload %s: %d %s", e.path, r.Status, r.Text())
		}
		kind := e.kind
		if kind == "" {
			kind = "markdown"
		}
		f := protocol.SyncManifestEntry{FileID: e.fileID, Path: e.path, Hash: sha(e.content), Size: int64(len(e.content)), Mtime: o.mtime, Kind: kind}
		if o.mime != "" {
			f.MimeType = &o.mime
		}
		files = append(files, f)
	}
	r := commitManifest(s, s.Token, s.VaultID, o.deviceID, sortedBody(t, o.deviceID, files))
	if r.Status != 200 {
		t.Fatalf("commit: %d %s", r.Status, r.Text())
	}
	return files
}

func getAs(s *testutil.Session, token, path string) testutil.Response {
	return testutil.Do(s.App, "GET", path, testutil.Bearer(token), nil)
}

// ---- app.test.ts: sync flows ----

func TestCreatesTokensByVaultNameAndSyncsThroughNameAddress(t *testing.T) {
	s := testutil.Setup(t, newApp)
	created := testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+url.PathEscape(s.VaultName)+"/tokens", s.BrowserHeaders, `{"name":"Plugin by name"}`)
	if created.Status != 201 {
		t.Fatalf("create: %d %s", created.Status, created.Text())
	}
	token := decode[struct{ Value string }](t, created).Value
	content := "# Named"
	files := []protocol.SyncManifestEntry{{FileID: "file-1", Path: "Note.md", Hash: sha(content), Size: int64(len(content)), Mtime: 1, Kind: "markdown"}}
	body := sortedBody(t, "device-1", files)
	byName := "/api/v1/vaults/" + url.PathEscape(s.VaultName)
	if r := testutil.Do(s.App, "POST", byName+"/sync/plan", authJSON(token), body); r.Status != 200 {
		t.Fatalf("plan: %d %s", r.Status, r.Text())
	}
	if r := putBlob(t, s, token, s.VaultID, content, "text/markdown"); r.Status != 200 {
		t.Fatalf("blob: %d %s", r.Status, r.Text())
	}
	if r := testutil.Do(s.App, "POST", byName+"/sync/commit", authJSON(token), body); r.Status != 200 {
		t.Fatalf("commit: %d %s", r.Status, r.Text())
	}
	listing := getAs(s, token, "/api/v1/vaults/"+s.VaultID+"/files")
	if rev := decode[struct{ Revision int }](t, listing).Revision; rev != 1 {
		t.Fatalf("revision = %d", rev)
	}
}

func TestRejectsBadUploadsAndRollsBackMissingBlobCommits(t *testing.T) {
	s := testutil.Setup(t, newApp)
	hash := sha("hello")
	bad := testutil.Do(s.App, "PUT", "/api/v1/vaults/"+s.VaultID+"/blobs/"+hash,
		testutil.Headers{"authorization": "Bearer " + s.Token, "x-tephra-blob-size": "5"}, []byte("wrong"))
	wantErr(t, bad, 400, "BLOB_HASH_MISMATCH", "Uploaded content does not match the declared SHA-256 hash.")
	if got, _ := s.DB.Blobs().FindByHash(context.Background(), hash); got != nil {
		t.Fatal("no blob metadata may be recorded for a bad upload")
	}
	files := []protocol.SyncManifestEntry{{FileID: "file-1", Path: "Note.md", Hash: hash, Size: 5, Mtime: 1, Kind: "markdown"}}
	commit := commitManifest(s, s.Token, s.VaultID, "device-1", sortedBody(t, "device-1", files))
	wantErr(t, commit, 409, "BLOB_MISSING", "")
	if revs, _ := s.DB.VaultRevisions().List(context.Background(), s.VaultID); len(revs) != 0 {
		t.Fatalf("revisions = %v", revs)
	}
	if v, _ := s.DB.Vaults().FindByID(context.Background(), s.VaultID); v.LatestRevision != 0 {
		t.Fatalf("latestRevision = %d", v.LatestRevision)
	}
}

func TestRegistersTheSyncingDeviceOnCommit(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"file-1", "Note.md", "# Device", "markdown"}}, commitOpts{deviceID: "field-device", mtime: 1})
	dev, _ := s.DB.Devices().FindByID(context.Background(), "field-device")
	owner, _ := s.DB.Vaults().FindByID(context.Background(), s.VaultID)
	if dev == nil || dev.UserID != owner.OwnerUserID || dev.LastSeenAt != testutil.FixedNow {
		t.Fatalf("device = %+v", dev)
	}
}

func TestCommitsOnceServesReadsAndIsIdempotentByManifestHash(t *testing.T) {
	s := testutil.Setup(t, newApp)
	content := "# Hello"
	if r := putBlob(t, s, s.Token, s.VaultID, content, "text/markdown"); r.Status != 200 {
		t.Fatalf("upload: %d", r.Status)
	}
	mime := "text/markdown"
	files := []protocol.SyncManifestEntry{{FileID: "file-1", Path: "Note.md", Hash: sha(content), Size: int64(len(content)), Mtime: 1, Kind: "markdown", MimeType: &mime}}
	body := sortedBody(t, "device-1", files)
	first := commitManifest(s, s.Token, s.VaultID, "device-1", body)
	want := func(status string) string {
		return `{"status":"` + status + `","revision":1,"protocolVersion":"` + protocol.ProtocolVersion + `","minimumPluginVersion":"` + protocol.MinimumPluginVersion + `"}`
	}
	if first.Text() != want("committed") || first.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("first = %s", first.Text())
	}
	second := commitManifest(s, s.Token, s.VaultID, "device-1", body)
	if second.Text() != want("up-to-date") {
		t.Fatalf("second = %s", second.Text())
	}
	if revs, _ := s.DB.VaultRevisions().List(context.Background(), s.VaultID); len(revs) != 1 {
		t.Fatalf("revisions = %d", len(revs))
	}
	listing := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files")
	if decode[struct{ Revision int }](t, listing).Revision != 1 {
		t.Fatalf("listing = %s", listing.Text())
	}
	raw := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/file-1/raw")
	if raw.Text() != content {
		t.Fatalf("raw = %q", raw.Text())
	}
}

func TestAdvertisesProtocolVersionsAndToleratesClientVersionHeaders(t *testing.T) {
	s := testutil.Setup(t, newApp)
	content := "# Versioned"
	files := []protocol.SyncManifestEntry{{FileID: "file-1", Path: "Note.md", Hash: sha(content), Size: int64(len(content)), Mtime: 1, Kind: "markdown"}}
	body := sortedBody(t, "device-1", files)
	h := authJSON(s.Token)
	h["x-tephra-plugin-version"] = "0.1.0"
	h["x-tephra-protocol-version"] = "1"
	plan := testutil.Do(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/sync/plan", h, body)
	wantPlan := fmt.Sprintf(`{"status":"upload-required","latestRevision":0,"missingBlobs":[{"hash":%q,"size":%d}],"protocolVersion":%q,"minimumPluginVersion":%q}`,
		sha(content), len(content), protocol.ProtocolVersion, protocol.MinimumPluginVersion)
	if plan.Status != 200 || plan.Text() != wantPlan {
		t.Fatalf("plan = %d %s", plan.Status, plan.Text())
	}
	putBlob(t, s, s.Token, s.VaultID, content, "text/markdown")
	commit := testutil.Do(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/sync/commit", h, body)
	if !strings.HasPrefix(commit.Text(), `{"status":"committed","revision":1,`) {
		t.Fatalf("commit = %s", commit.Text())
	}
}

func TestPlanDedupesMissingBlobsAndSkipsUploadedOnes(t *testing.T) {
	s := testutil.Setup(t, newApp)
	a, b := "same", "other"
	files := []protocol.SyncManifestEntry{
		{FileID: "f1", Path: "A.md", Hash: sha(a), Size: 4, Mtime: 1, Kind: "markdown"},
		{FileID: "f2", Path: "B.md", Hash: sha(a), Size: 4, Mtime: 1, Kind: "markdown"},
		{FileID: "f3", Path: "C.md", Hash: sha(b), Size: 5, Mtime: 1, Kind: "markdown"},
	}
	body := sortedBody(t, "device-1", files)
	plan := func() []protocol.MissingBlob {
		r := testutil.Do(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/sync/plan", authJSON(s.Token), body)
		return decode[protocol.SyncPlanResponse](t, r).MissingBlobs
	}
	if got := plan(); len(got) != 2 || got[0].Hash != sha(a) || got[1].Hash != sha(b) {
		t.Fatalf("missing = %+v", got)
	}
	putBlob(t, s, s.Token, s.VaultID, a, "")
	if got := plan(); len(got) != 1 || got[0].Hash != sha(b) {
		t.Fatalf("missing after upload = %+v", got)
	}
	// A blob row with the wrong size counts as missing.
	_ = s.DB.Blobs().Insert(context.Background(), vm.BlobMetadata{Hash: sha(b), Size: 99, CreatedAt: 1})
	if got := plan(); len(got) != 1 {
		t.Fatalf("wrong-size metadata must stay missing: %+v", got)
	}
}

func TestCommitRejectsBadManifestHashAndNonTokenPrincipals(t *testing.T) {
	s := testutil.Setup(t, newApp)
	files := []protocol.SyncManifestEntry{{FileID: "f1", Path: "A.md", Hash: sha("x"), Size: 1, Mtime: 1, Kind: "markdown"}}
	body := sortedBody(t, "device-1", files)
	var m map[string]any
	_ = json.Unmarshal(body, &m)
	m["manifestHash"] = strings.Repeat("0", 64)
	bad, _ := json.Marshal(m)
	wantErr(t, testutil.Do(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/sync/plan", authJSON(s.Token), bad), 400, "INVALID_MANIFEST", "Manifest hash does not match its canonical contents.")
	wantErr(t, commitManifest(s, s.Token, s.VaultID, "device-1", bad), 400, "INVALID_MANIFEST", "Manifest hash does not match its canonical contents.")
	// A browser session cannot commit: an upload token is required.
	bh := testutil.Headers{"cookie": s.BrowserHeaders["cookie"], "x-tephra-csrf": s.CSRF, "content-type": "application/json"}
	wantErr(t, testutil.Do(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/sync/commit", bh, body), 403, "VAULT_ACCESS_DENIED", "An upload token is required.")
	wantErr(t, testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/sync/commit", authJSON(s.Token), `not json`), 400, "INVALID_MANIFEST", "Request body must be valid JSON.")
}

func TestCommitDeviceOwnershipAndDeletionOfOmittedFiles(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ctx := context.Background()
	other := vm.User{ID: "other-user", Email: "o@example.com", CreatedAt: 1, UpdatedAt: 1}
	_ = s.DB.Users().Insert(ctx, other)
	_ = s.DB.Devices().Insert(ctx, vm.Device{ID: "foreign-device", UserID: "other-user", Name: "x", CreatedAt: 1, LastSeenAt: 1})
	content := "# A"
	putBlob(t, s, s.Token, s.VaultID, content, "")
	files := []protocol.SyncManifestEntry{{FileID: "f1", Path: "A.md", Hash: sha(content), Size: 3, Mtime: 1, Kind: "markdown"}}
	wantErr(t, commitManifest(s, s.Token, s.VaultID, "foreign-device", sortedBody(t, "foreign-device", files)), 403, "VAULT_ACCESS_DENIED", "Device belongs to another user.")
	if v, _ := s.DB.Vaults().FindByID(ctx, s.VaultID); v.LatestRevision != 0 {
		t.Fatal("failed commit must roll back")
	}
	if r := commitManifest(s, s.Token, s.VaultID, "device-1", sortedBody(t, "device-1", files)); r.Status != 200 {
		t.Fatalf("commit: %d %s", r.Status, r.Text())
	}
	// Committing an empty manifest deletes the omitted file and logs a delete.
	r := commitManifest(s, s.Token, s.VaultID, "device-1", sortedBody(t, "device-1", nil))
	if r.Status != 200 {
		t.Fatalf("empty commit: %d %s", r.Status, r.Text())
	}
	if f, _ := s.DB.VaultFiles().FindByID(ctx, s.VaultID, "f1"); f != nil {
		t.Fatal("file should be deleted")
	}
	versions, _ := s.DB.FileVersions().ListByRevision(ctx, s.VaultID, 2)
	if len(versions) != 1 || versions[0].ChangeType != vm.ChangeDelete {
		t.Fatalf("versions = %+v", versions)
	}
}

func TestBlobUploadValidation(t *testing.T) {
	s := testutil.Setup(t, newApp, testutil.WithMaxBlobBytes(16))
	put := func(hash string, headers testutil.Headers, body string) testutil.Response {
		h := testutil.Headers{"authorization": "Bearer " + s.Token}
		for k, v := range headers {
			h[k] = v
		}
		return testutil.Do(s.App, "PUT", "/api/v1/vaults/"+s.VaultID+"/blobs/"+hash, h, []byte(body))
	}
	// Malformed hash (validation error).
	wantErr(t, put("ABC", testutil.Headers{"x-tephra-blob-size": "1"}, "x"), 400, "INVALID_MANIFEST", "Request validation failed.")
	wantErr(t, put(sha("x"), testutil.Headers{"x-tephra-blob-size": "abc"}, "x"), 400, "INVALID_MANIFEST", "A valid blob size is required.")
	wantErr(t, put(sha("x"), testutil.Headers{"x-tephra-blob-size": "-1"}, "x"), 400, "INVALID_MANIFEST", "A valid blob size is required.")
	wantErr(t, put(sha("x"), testutil.Headers{"x-tephra-blob-size": "1.5"}, "x"), 400, "INVALID_MANIFEST", "A valid blob size is required.")
	wantErr(t, put(sha("x"), testutil.Headers{"x-tephra-blob-size": "17"}, "x"), 413, "BLOB_TOO_LARGE", "Blob exceeds the configured size limit.")
	// Declared size differs from the bytes received (both directions).
	wantErr(t, put(sha("xy"), testutil.Headers{"x-tephra-blob-size": "1"}, "xy"), 400, "BLOB_HASH_MISMATCH", "Uploaded size does not match the declared size.")
	wantErr(t, put(sha("xy"), testutil.Headers{"x-tephra-blob-size": "3"}, "xy"), 400, "BLOB_HASH_MISMATCH", "Uploaded size does not match the declared size.")
	// Content-Length is used when no explicit size header is present.
	if r := put(sha("xy"), testutil.Headers{"content-length": "2"}, "xy"); r.Status != 200 {
		t.Fatalf("content-length upload: %d %s", r.Status, r.Text())
	}
	// Re-upload is idempotent and reports stored=false; the response body shape is fixed.
	r := put(sha("xy"), testutil.Headers{"x-tephra-blob-size": "2", "content-type": "text/plain"}, "xy")
	if r.Status != 200 || r.Text() != `{"hash":"`+sha("xy")+`","stored":false}` {
		t.Fatalf("re-upload: %d %s", r.Status, r.Text())
	}
	// The body is verified even when the blob already exists.
	wantErr(t, put(sha("xy"), testutil.Headers{"x-tephra-blob-size": "2"}, "zz"), 400, "BLOB_HASH_MISMATCH", "Uploaded content does not match the declared SHA-256 hash.")
	first := put(sha("fresh"), testutil.Headers{"x-tephra-blob-size": "5", "content-type": "text/plain"}, "fresh")
	if first.Text() != `{"hash":"`+sha("fresh")+`","stored":true}` {
		t.Fatalf("first upload: %s", first.Text())
	}
	meta, _ := s.DB.Blobs().FindByHash(context.Background(), sha("fresh"))
	if meta == nil || meta.Size != 5 || meta.MimeType == nil || *meta.MimeType != "text/plain" || meta.CreatedAt != testutil.FixedNow {
		t.Fatalf("meta = %+v", meta)
	}
	// Inconsistent stored metadata (row without a blob) is a 409.
	_ = s.DB.Blobs().Insert(context.Background(), vm.BlobMetadata{Hash: sha("gone"), Size: 4, CreatedAt: 1})
	wantErr(t, put(sha("gone"), testutil.Headers{"x-tephra-blob-size": "4"}, "gone"), 409, "COMMIT_FAILED", "Stored blob metadata is inconsistent.")
}

func TestBlobUploadsRequireTheUploadScope(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ro := decode[struct{ Value string }](t, testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/tokens", s.BrowserHeaders, `{"name":"ro","scopes":["vault:read-metadata"]}`)).Value
	r := testutil.Do(s.App, "PUT", "/api/v1/vaults/"+s.VaultID+"/blobs/"+sha("x"), testutil.Headers{"authorization": "Bearer " + ro, "x-tephra-blob-size": "1"}, []byte("x"))
	wantErr(t, r, 403, "VAULT_ACCESS_DENIED", "")
}

func TestKeepsIdenticalPathsInTwoVaultsIndependent(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ctx := context.Background()
	vb := decode[struct{ Vault vm.Vault }](t, testutil.DoJSON(s.App, "POST", "/api/v1/vaults", s.BrowserHeaders, `{"name":"Second Vault"}`)).Vault
	tokenB := decode[struct{ Value string }](t, testutil.DoJSON(s.App, "POST", "/api/v1/vaults/"+vb.ID+"/tokens", s.BrowserHeaders, `{"name":"Plugin B"}`)).Value
	commitEntries := func(token, vaultID string, entries []seed) testutil.Response {
		var files []protocol.SyncManifestEntry
		for _, e := range entries {
			putBlob(t, s, token, vaultID, e.content, "text/markdown")
			files = append(files, protocol.SyncManifestEntry{FileID: e.fileID, Path: e.path, Hash: sha(e.content), Size: int64(len(e.content)), Mtime: 1, Kind: "markdown"})
		}
		return commitManifest(s, token, vaultID, "device-1", sortedBody(t, "device-1", files))
	}
	if r := commitEntries(s.Token, s.VaultID, []seed{{fileID: "shared-id", path: "Note.md", content: "vault a"}}); r.Status != 200 {
		t.Fatalf("A: %d %s", r.Status, r.Text())
	}
	if r := commitEntries(tokenB, vb.ID, []seed{{fileID: "shared-id", path: "Note.md", content: "vault b"}}); r.Status != 200 {
		t.Fatalf("B: %d %s", r.Status, r.Text())
	}
	filesA, _ := s.DB.VaultFiles().ListByVault(ctx, s.VaultID)
	filesB, _ := s.DB.VaultFiles().ListByVault(ctx, vb.ID)
	if len(filesA) != 1 || len(filesB) != 1 || filesA[0].VaultID != s.VaultID || filesB[0].VaultID != vb.ID {
		t.Fatalf("A=%+v B=%+v", filesA, filesB)
	}
	readA := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/shared-id")
	if readA.Status != 200 || decode[struct{ File struct{ Path string } }](t, readA).File.Path != "Note.md" {
		t.Fatalf("read A: %s", readA.Text())
	}
	if r := commitEntries(s.Token, s.VaultID, []seed{{fileID: "shared-id", path: "Renamed.md", content: "vault a"}}); r.Status != 200 {
		t.Fatalf("recommit: %d", r.Status)
	}
	if f, _ := s.DB.VaultFiles().FindByID(ctx, vb.ID, "shared-id"); f == nil || f.Path != "Note.md" {
		t.Fatalf("vault B row stolen: %+v", f)
	}
}

func TestRejectsANonNFCPathAtCommitWithInvalidPath(t *testing.T) {
	s := testutil.Setup(t, newApp)
	nfd := "Café.md"
	content := "# nfd"
	putBlob(t, s, s.Token, s.VaultID, content, "text/markdown")
	files := []map[string]any{{"fileId": "file-nfd", "path": nfd, "hash": sha(content), "size": len(content), "mtime": 1, "kind": "markdown"}}
	body, _ := json.Marshal(map[string]any{"deviceId": "device-1", "manifestHash": strings.Repeat("0", 64), "files": files})
	wantErr(t, commitManifest(s, s.Token, s.VaultID, "device-1", body), 400, "INVALID_PATH", "")
}
