package indexer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/core"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// ---- minimal in-memory fake of the db interfaces used by the index service ----

type fakeDB struct {
	db.Repositories // unimplemented repositories panic if touched
	vault           *vm.Vault
	files           []vm.CurrentVaultFile
	meta            map[string]vm.NoteMetadata
	links           map[string][]vm.NoteLink // by source
	state           *vm.VaultIndexState
	cache           *db.GraphCacheEntry
	failUpsert      bool
}

func newFakeDB() *fakeDB {
	return &fakeDB{meta: map[string]vm.NoteMetadata{}, links: map[string][]vm.NoteLink{}}
}

type fakeTx struct{ *fakeDB }

func (f fakeTx) LockVault(context.Context, string) error { return nil }

func (f *fakeDB) Transaction(_ context.Context, fn func(db.TransactionRepositories) error) error {
	return fn(fakeTx{f})
}
func (f *fakeDB) Vaults() db.VaultRepository          { return fakeVaults{f: f} }
func (f *fakeDB) VaultFiles() db.VaultFileRepository  { return fakeFiles{f: f} }
func (f *fakeDB) NoteIndex() db.NoteIndexRepository   { return fakeNotes{f: f} }
func (f *fakeDB) GraphCache() db.GraphCacheRepository { return fakeCache{f: f} }

type fakeVaults struct {
	db.VaultRepository
	f *fakeDB
}

func (v fakeVaults) FindByID(context.Context, string) (*vm.Vault, error) { return v.f.vault, nil }

type fakeFiles struct {
	db.VaultFileRepository
	f *fakeDB
}

func (v fakeFiles) ListByVault(context.Context, string) ([]vm.CurrentVaultFile, error) {
	return v.f.files, nil
}

type fakeNotes struct {
	db.NoteIndexRepository
	f *fakeDB
}

func (n fakeNotes) ListMetadata(context.Context, string) ([]vm.NoteMetadata, error) {
	out := []vm.NoteMetadata{}
	for _, m := range n.f.meta {
		out = append(out, m)
	}
	return out, nil
}
func (n fakeNotes) UpsertMetadata(_ context.Context, m vm.NoteMetadata) error {
	n.f.meta[m.FileID] = m
	return nil
}
func (n fakeNotes) DeleteMetadata(_ context.Context, id string) error {
	delete(n.f.meta, id)
	delete(n.f.links, id)
	return nil
}
func (n fakeNotes) ListLinks(context.Context, string) ([]vm.NoteLink, error) {
	out := []vm.NoteLink{}
	for _, f := range n.f.files { // deterministic order
		out = append(out, n.f.links[f.FileID]...)
	}
	return out, nil
}
func (n fakeNotes) ReplaceLinksForSource(_ context.Context, _ string, src string, links []vm.NoteLink) error {
	n.f.links[src] = links
	return nil
}
func (n fakeNotes) SetState(_ context.Context, s vm.VaultIndexState) error {
	n.f.state = &s
	return nil
}

type fakeCache struct {
	db.GraphCacheRepository
	f *fakeDB
}

func (c fakeCache) Upsert(_ context.Context, e db.GraphCacheEntry) error {
	if c.f.failUpsert {
		return errors.New("boom")
	}
	c.f.cache = &e
	return nil
}
func (c fakeCache) DeleteByVault(context.Context, string) error { c.f.cache = nil; return nil }

type memBlobs struct {
	blobstore.Store
	data map[string][]byte
}

func (m memBlobs) Get(_ context.Context, h string) (*blobstore.ReadResult, error) {
	b, ok := m.data[h]
	if !ok {
		return nil, blobstore.ErrNotFound
	}
	return &blobstore.ReadResult{Body: io.NopCloser(bytes.NewReader(b)), Size: int64(len(b))}, nil
}

type seqIDs struct{ n int }

func (s *seqIDs) Generate() string { s.n++; return "id-" + string(rune('0'+s.n%10)) + "-" + itoa(s.n) }
func itoa(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func setup(texts map[string]string) (*fakeDB, memBlobs, IndexService) {
	d := newFakeDB()
	blobs := memBlobs{data: map[string][]byte{}}
	d.vault = &vm.Vault{ID: "v", LatestRevision: 4}
	i := 0
	for p, text := range texts {
		i++
		id := "f" + itoa(i)
		kind := vm.KindMarkdown
		if !strings.HasSuffix(p, ".md") {
			kind = vm.KindAttachment
		}
		d.files = append(d.files, vm.CurrentVaultFile{FileID: id, VaultID: "v", Path: p, Kind: kind, BlobHash: "h-" + id, Mtime: int64(i)})
		blobs.data["h-"+id] = []byte(text)
	}
	svc := NewRuntimeIndexService(RuntimeDeps{Database: d, BlobStore: blobs, Clock: core.NewFakeClock(5000), IDs: &seqIDs{}})
	return d, blobs, svc
}

func TestRuntimeIndexVault(t *testing.T) {
	ctx := context.Background()
	d, _, svc := setup(map[string]string{
		"A.md":    "---\ntitle: Alpha\ntags: [x]\n---\n[[B]] [web](https://e.com) ![[img.png]]",
		"B.md":    "\xEF\xBB\xBF# Beta\n[[A]]",
		"img.png": "bytes",
	})
	d.meta["stale"] = vm.NoteMetadata{FileID: "stale", VaultID: "v"}
	d.links["stale"] = []vm.NoteLink{{ID: "s"}}
	d.cache = &db.GraphCacheEntry{ETag: "old"}

	if err := svc.IndexVault(ctx, "v", 4); err != nil {
		t.Fatal(err)
	}
	if _, ok := d.meta["stale"]; ok || len(d.meta) != 2 {
		t.Fatalf("meta %v", d.meta)
	}
	if d.state == nil || d.state.IndexedRevision != 4 || d.state.LastError != nil {
		t.Fatalf("state %+v", d.state)
	}
	var aID, bID string
	for _, f := range d.files {
		switch f.Path {
		case "A.md":
			aID = f.FileID
		case "B.md":
			bID = f.FileID
		}
	}
	if *d.meta[aID].Title != "Alpha" || *d.meta[bID].Title != "Beta" {
		t.Fatalf("titles %v %v", *d.meta[aID].Title, *d.meta[bID].Title) // BOM must not hide the heading
	}
	if n := len(d.links[aID]); n != 3 {
		t.Fatalf("A links %d", n)
	}
	if d.links[aID][0].TargetFileID == nil || *d.links[aID][0].TargetFileID != bID {
		t.Fatal("A->B unresolved")
	}
	if d.links[aID][1].TargetFileID != nil {
		t.Fatal("external link resolved")
	}
	// Graph cache populated, ETag and payload exactly what BuildGraphPayload yields.
	if d.cache == nil || d.cache.ETag != `W/"4-4-graph-v2"` || d.cache.Revision != 4 || d.cache.IndexedRevision != 4 || d.cache.UpdatedAt != 5000 {
		t.Fatalf("cache %+v", d.cache)
	}
	want, _ := BuildGraphPayload(BuildGraphPayloadInput{Files: d.files, MetadataRows: mapMeta(d), Links: allLinks(d), LatestRevision: 4, IndexedRevision: 4}).MarshalJSON()
	if string(want) != d.cache.PayloadJSON {
		t.Fatalf("payload mismatch:\n%s\n%s", want, d.cache.PayloadJSON)
	}
	var parsed struct {
		Revision int64
		Nodes    []struct{ ID, Kind string }
		Edges    []map[string]int
	}
	if err := json.Unmarshal([]byte(d.cache.PayloadJSON), &parsed); err != nil || parsed.Revision != 4 || len(parsed.Nodes) != 4 {
		t.Fatalf("payload %s err=%v", d.cache.PayloadJSON, err)
	}
}

func mapMeta(d *fakeDB) []vm.NoteMetadata {
	out, _ := fakeNotes{f: d}.ListMetadata(context.Background(), "v")
	return out
}
func allLinks(d *fakeDB) []vm.NoteLink {
	out, _ := fakeNotes{f: d}.ListLinks(context.Background(), "v")
	return out
}

func TestRuntimeIndexVaultRefreshFailureIsSilent(t *testing.T) {
	d, _, svc := setup(map[string]string{"A.md": "# A"})
	d.failUpsert = true
	d.cache = &db.GraphCacheEntry{ETag: "old"}
	if err := svc.IndexVault(context.Background(), "v", 4); err != nil {
		t.Fatal(err)
	}
	if d.cache != nil || d.state.IndexedRevision != 4 {
		t.Fatalf("cache=%v state=%+v", d.cache, d.state)
	}
}

func TestRuntimeIndexVaultMissingBlob(t *testing.T) {
	d, blobs, svc := setup(map[string]string{"A.md": "# A"})
	delete(blobs.data, "h-f1")
	d.cache = &db.GraphCacheEntry{ETag: "old"}
	err := svc.IndexVault(context.Background(), "v", 4)
	if err == nil || err.Error() != "Missing Markdown blob h-f1" {
		t.Fatalf("err %v", err)
	}
	if d.cache != nil {
		t.Fatal("cache not dropped")
	}
	if d.state == nil || d.state.IndexedRevision != 3 || d.state.LastError == nil || *d.state.LastError != "Missing Markdown blob h-f1" {
		t.Fatalf("state %+v", d.state)
	}
	// revision 0 clamps at 0.
	_ = svc.IndexVault(context.Background(), "v", 0)
	if d.state.IndexedRevision != 0 {
		t.Fatalf("clamp: %d", d.state.IndexedRevision)
	}
}

func TestRuntimeRenderAndSearch(t *testing.T) {
	d, _, svc := setup(map[string]string{"Notes/A.md": "x", "B.md": "x", "img.png": "x"})
	ctx := context.Background()
	idOf := func(p string) string {
		for _, f := range d.files {
			if f.Path == p {
				return f.FileID
			}
		}
		return ""
	}
	out, err := svc.RenderMarkdown(ctx, RenderMarkdownInput{VaultID: "v", FileID: idOf("Notes/A.md"), Markdown: "[[B]] ![[img.png]]"})
	if err != nil {
		t.Fatal(err)
	}
	b, _ := json.Marshal(out)
	s := string(b)
	if !strings.Contains(s, "/api/v1/vaults/v/attachments/"+idOf("img.png")) || !strings.Contains(s, idOf("B.md")) {
		t.Fatalf("render %s", s)
	}
	if _, err := svc.RenderMarkdown(ctx, RenderMarkdownInput{VaultID: "v", FileID: "nope", Markdown: "x"}); err == nil || err.Error() != "Markdown source file is not current" {
		t.Fatalf("err %v", err)
	}

	d.meta[idOf("B.md")] = vm.NoteMetadata{FileID: idOf("B.md"), Title: sp("Zebra Title")}
	res, _ := svc.Search(ctx, SearchInput{VaultID: "v", Query: "  ZEBRA ", Limit: 10})
	if len(res) != 1 || res[0].(SearchResult).Path != "B.md" || *res[0].(SearchResult).Title != "Zebra Title" {
		t.Fatalf("title search %+v", res)
	}
	res, _ = svc.Search(ctx, SearchInput{VaultID: "v", Query: "notes/", Limit: 10})
	if len(res) != 1 || res[0].(SearchResult).Title != nil {
		t.Fatalf("path search %+v", res)
	}
	res, _ = svc.Search(ctx, SearchInput{VaultID: "v", Query: ".", Limit: 2})
	if len(res) != 2 {
		t.Fatalf("limit %d", len(res))
	}
	if res, _ := svc.Search(ctx, SearchInput{VaultID: "v", Query: "   ", Limit: 5}); len(res) != 0 {
		t.Fatal("blank query")
	}
	one, _ := svc.Search(ctx, SearchInput{VaultID: "v", Query: "zebra", Limit: 1})
	jb, _ := json.Marshal(one[0])
	if !strings.Contains(string(jb), `"fileId"`) || !strings.Contains(string(jb), `"title":"Zebra Title"`) {
		t.Fatalf("search json %s", jb)
	}
}
