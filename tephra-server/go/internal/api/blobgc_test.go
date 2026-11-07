package api_test

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/api"
	"github.com/championswimmer/tephra/tephra-server/go/internal/auth"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

const (
	dayMs = int64(24 * 60 * 60 * 1000)
	gcNow = testutil.FixedNow
)

// gcFixture seeds a user, vault, device and sync token directly (real SQLite,
// memory blobs) like blob-gc.test.ts.
func gcFixture(t *testing.T, raw string) (*testutil.Fixture, func(string) testutil.Headers) {
	t.Helper()
	f := testutil.NewFixture(t, testutil.WithDatabase(testutil.OpenSQLite(t)))
	ctx := context.Background()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	must(f.DB.Users().Insert(ctx, vm.User{ID: "user-1", Email: "owner@example.com", CreatedAt: gcNow, UpdatedAt: gcNow}))
	must(f.DB.Vaults().Insert(ctx, vm.Vault{ID: "vault-1", OwnerUserID: "user-1", Name: "Vault", CreatedAt: gcNow, UpdatedAt: gcNow}))
	must(f.DB.Devices().Insert(ctx, vm.Device{ID: "device-1", UserID: "user-1", Name: "Device", CreatedAt: gcNow, LastSeenAt: gcNow}))
	vault, device := "vault-1", "device-1"
	must(f.DB.ApiTokens().Insert(ctx, vm.ApiToken{ID: "token-1", UserID: "user-1", VaultID: &vault, DeviceID: &device,
		TokenHash: auth.HashOpaqueToken(raw), Name: "Sync", Scopes: []vm.ApiTokenScope{vm.ScopeVaultUpload, vm.ScopeVaultReadMetadata}, CreatedAt: gcNow}))
	return f, func(contentType string) testutil.Headers {
		h := testutil.Bearer(raw)
		if contentType != "" {
			h["content-type"] = contentType
		}
		return h
	}
}

func TestBlobGCCollectsOnlyOldOrphansAndNeverDeletesReferencedBlobs(t *testing.T) {
	f, hdr := gcFixture(t, "gc-device-token")
	app := newApp(f.Deps)
	ctx := context.Background()
	upload := func(content, mime string) testutil.Response {
		h := hdr(mime)
		h["x-tephra-blob-size"] = fmt.Sprint(len(content))
		return testutil.Do(app, "PUT", "/api/v1/vaults/vault-1/blobs/"+sha(content), h, []byte(content))
	}
	// Commit a referenced blob 8 days ago so its row is older than the grace period.
	f.Clock.Set(gcNow - 8*dayMs)
	referenced := "# Referenced"
	if r := upload(referenced, "text/markdown"); r.Status != 200 {
		t.Fatalf("upload: %d", r.Status)
	}
	files := []protocol.SyncManifestEntry{{FileID: "file-1", Path: "Note.md", Hash: sha(referenced), Size: int64(len(referenced)), Mtime: 1, Kind: "markdown"}}
	if r := testutil.Do(app, "POST", "/api/v1/vaults/vault-1/sync/commit", hdr("application/json"), sortedBody(t, "device-1", files)); r.Status != 200 {
		t.Fatalf("commit: %d %s", r.Status, r.Text())
	}
	f.Clock.Set(gcNow)
	// A recent orphan uploaded through the API.
	if r := upload("recent orphan", "text/plain"); r.Status != 200 {
		t.Fatalf("recent: %d", r.Status)
	}
	// An old orphan inserted directly with an aged timestamp.
	old := "old orphan"
	_ = f.Blobs.Put(ctx, putInput(sha(old), old))
	_ = f.DB.Blobs().Insert(ctx, vm.BlobMetadata{Hash: sha(old), Size: int64(len(old)), CreatedAt: gcNow - 8*dayMs})

	deleted, err := api.CollectUnreferencedBlobs(ctx, f.Deps, api.CollectBlobsOptions{Now: gcNow})
	if err != nil || len(deleted) != 1 || deleted[0] != sha(old) {
		t.Fatalf("deleted = %v err = %v", deleted, err)
	}
	if m, _ := f.DB.Blobs().FindByHash(ctx, sha(old)); m != nil {
		t.Fatal("old orphan row should be gone")
	}
	if has, _ := f.Blobs.Has(ctx, sha(old)); has {
		t.Fatal("old orphan bytes should be gone")
	}
	for name, content := range map[string]string{"recent orphan (grace period)": "recent orphan", "referenced": referenced} {
		if m, _ := f.DB.Blobs().FindByHash(ctx, sha(content)); m == nil {
			t.Fatalf("%s row deleted", name)
		}
		if has, _ := f.Blobs.Has(ctx, sha(content)); !has {
			t.Fatalf("%s bytes deleted", name)
		}
	}
	again, err := api.CollectUnreferencedBlobs(ctx, f.Deps, api.CollectBlobsOptions{Now: gcNow})
	if err != nil || again == nil || len(again) != 0 {
		t.Fatalf("second run = %v (%v)", again, err)
	}
}

func TestBlobGCDefaultGracePeriodIsSevenDays(t *testing.T) {
	if api.DefaultBlobGCAgeMs != 7*dayMs || api.DefaultBlobGCLimit != 1000 {
		t.Fatalf("defaults = %d %d", api.DefaultBlobGCAgeMs, api.DefaultBlobGCLimit)
	}
}

func TestBlobGCHonorsExplicitOptions(t *testing.T) {
	f := testutil.NewFixture(t, testutil.WithDatabase(testutil.OpenSQLite(t)))
	ctx := context.Background()
	for i := 0; i < 3; i++ {
		c := fmt.Sprintf("orphan-%d", i)
		_ = f.Blobs.Put(ctx, putInput(sha(c), c))
		_ = f.DB.Blobs().Insert(ctx, vm.BlobMetadata{Hash: sha(c), Size: int64(len(c)), CreatedAt: gcNow - int64(i+2)*dayMs})
	}
	// 2.5 days: only the 3-day and 4-day orphans qualify; the limit keeps one.
	deleted, err := api.CollectUnreferencedBlobs(ctx, f.Deps, api.CollectBlobsOptions{OlderThanMs: 5 * dayMs / 2, Limit: 1})
	if err != nil || len(deleted) != 1 || deleted[0] != sha("orphan-2") {
		t.Fatalf("deleted = %v err = %v (oldest first)", deleted, err)
	}
}

func TestBlobGCDoesNotCollectBlobsSurvivingOnlyThroughPreChurnFileVersions(t *testing.T) {
	f, hdr := gcFixture(t, "gc-churn-device-token")
	app := newApp(f.Deps)
	ctx := context.Background()
	content := "# Churned note"
	_ = f.Blobs.Put(ctx, putInput(sha(content), content))
	mime := "text/markdown"
	_ = f.DB.Blobs().Insert(ctx, vm.BlobMetadata{Hash: sha(content), Size: int64(len(content)), MimeType: &mime, CreatedAt: gcNow - 8*dayMs})
	commit := func(fileID string) {
		files := []protocol.SyncManifestEntry{{FileID: fileID, Path: "Note.md", Hash: sha(content), Size: int64(len(content)), Mtime: 1, Kind: "markdown"}}
		if r := testutil.Do(app, "POST", "/api/v1/vaults/vault-1/sync/commit", hdr("application/json"), sortedBody(t, "device-1", files)); r.Status != 200 {
			t.Fatalf("commit: %d %s", r.Status, r.Text())
		}
	}
	commit("file-before-churn")
	commit("file-after-churn") // same path and bytes, new id: delete+create
	deleted, err := api.CollectUnreferencedBlobs(ctx, f.Deps, api.CollectBlobsOptions{Now: gcNow})
	if err != nil || len(deleted) != 0 {
		t.Fatalf("deleted = %v err = %v", deleted, err)
	}
	if m, _ := f.DB.Blobs().FindByHash(ctx, sha(content)); m == nil {
		t.Fatal("row deleted")
	}
	if has, _ := f.Blobs.Has(ctx, sha(content)); !has {
		t.Fatal("bytes deleted")
	}
}

func TestStartBlobGCRunsPeriodicallyUntilCancelled(t *testing.T) {
	f := testutil.NewFixture(t, testutil.WithDatabase(testutil.OpenSQLite(t)))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	orphan := "orphan"
	_ = f.Blobs.Put(ctx, putInput(sha(orphan), orphan))
	_ = f.DB.Blobs().Insert(ctx, vm.BlobMetadata{Hash: sha(orphan), Size: int64(len(orphan)), CreatedAt: gcNow - 8*dayMs})
	done := api.StartBlobGC(ctx, f.Deps, api.BlobGCOptions{Interval: 10 * time.Millisecond})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if m, _ := f.DB.Blobs().FindByHash(ctx, sha(orphan)); m == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if m, _ := f.DB.Blobs().FindByHash(context.Background(), sha(orphan)); m != nil {
		t.Fatal("background GC did not collect the orphan")
	}
	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("loop did not stop on cancel")
	}
}
