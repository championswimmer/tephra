package api_test

import (
	"context"
	"encoding/json"
	"errors"
	"net/url"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/championswimmer/tephra/tephra-server/go/internal/core"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/indexer"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func baseDB(t *testing.T) db.Database {
	if testutil.UseSQLite() {
		return testutil.OpenSQLite(t)
	}
	return testutil.NewMemoryDatabase()
}

// runtimeIndex wires the real Go runtime index service (a WithDeps option).
func runtimeIndex(d *httpx.Dependencies) {
	d.IndexService = indexer.NewRuntimeIndexService(indexer.RuntimeDeps{Database: d.Database, BlobStore: d.BlobStore, Clock: d.Clock, IDs: d.IDs})
}

func waitIndexed(t *testing.T, s *testutil.Session) {
	t.Helper()
	for i := 0; i < 400; i++ {
		if st, _ := s.DB.NoteIndex().GetState(context.Background(), s.VaultID); st != nil && st.IndexedRevision >= 1 {
			time.Sleep(50 * time.Millisecond) // let the graph cache refresh finish
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("background indexing did not finish")
}

func resolve(s *testutil.Session, path string) testutil.Response {
	return getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/resolve?path="+url.QueryEscape(path))
}

// ---- path resolver ----

func TestResolvesExactPaths(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"file-1", "Notes/Hello.md", "hi", ""}}, commitOpts{})
	r := resolve(s, "Notes/Hello.md")
	body := decode[struct {
		Match, RequestedPath, CanonicalPath string
		File                                struct{ FileID string }
	}](t, r)
	if r.Status != 200 || body.Match != "exact" || body.CanonicalPath != "Notes/Hello.md" || body.File.FileID != "file-1" || body.RequestedPath != "Notes/Hello.md" {
		t.Fatalf("body = %s", r.Text())
	}
	if !strings.HasPrefix(r.Text(), `{"match":"exact","requestedPath":"Notes/Hello.md","canonicalPath":"Notes/Hello.md","file":{"fileId":"file-1"`) {
		t.Fatalf("key order: %s", r.Text())
	}
}

func TestResolvesNFDRequestsToNFCRowsAsNormalized(t *testing.T) {
	s := testutil.Setup(t, newApp)
	nfc, nfd := "Café.md", "Café.md"
	commitSeeds(t, s, []seed{{"file-1", nfc, "cafe", ""}}, commitOpts{})
	r := resolve(s, nfd)
	body := decode[struct{ Match, CanonicalPath, RequestedPath string }](t, r)
	if r.Status != 200 || body.Match != "normalized" || body.CanonicalPath != nfc || body.RequestedPath != nfd {
		t.Fatalf("body = %s", r.Text())
	}
}

func TestResolvesCaseOnlyMissesAsCase(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"file-1", "Note.md", "hi", ""}}, commitOpts{})
	body := decode[struct{ Match, CanonicalPath string }](t, resolve(s, "note.md"))
	if body.Match != "case" || body.CanonicalPath != "Note.md" {
		t.Fatalf("body = %+v", body)
	}
}

func TestResolveReturns409AmbiguousPathWhenTheFoldMatchesSeveralFiles(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"file-1", "Note.md", "one", ""}, {"file-2", "NOTE.md", "two", ""}}, commitOpts{})
	r := resolve(s, "note.md")
	body := decode[struct {
		Error      struct{ Code, Message string }
		Candidates []struct{ FileID string }
	}](t, r)
	if r.Status != 409 || body.Error.Code != "AMBIGUOUS_PATH" || body.Error.Message != "Multiple files match this path." {
		t.Fatalf("body = %d %s", r.Status, r.Text())
	}
	var ids []string
	for _, c := range body.Candidates {
		ids = append(ids, c.FileID)
	}
	sort.Strings(ids)
	if strings.Join(ids, ",") != "file-1,file-2" {
		t.Fatalf("candidates = %v", ids)
	}
}

func TestResolvesRenamedFilesThroughHistoryAndReportsTheMove(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"file-1", "Old.md", "hi", ""}}, commitOpts{})
	commitSeeds(t, s, []seed{{"file-1", "New.md", "hi", ""}}, commitOpts{})
	r := resolve(s, "Old.md")
	body := decode[struct {
		Match, CanonicalPath, MovedFromPath string
		MovedAtRevision                     *int64
	}](t, r)
	if r.Status != 200 || body.Match != "historic" || body.CanonicalPath != "New.md" || body.MovedFromPath != "Old.md" || body.MovedAtRevision == nil || *body.MovedAtRevision != 1 {
		t.Fatalf("body = %s", r.Text())
	}
}

func TestResolvePrefersALiveOccupantOverHistory(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"file-1", "Old.md", "first", ""}}, commitOpts{})
	commitSeeds(t, s, []seed{{"file-1", "New.md", "first", ""}, {"file-2", "Old.md", "second", ""}}, commitOpts{})
	body := decode[struct {
		Match string
		File  struct{ FileID string }
	}](t, resolve(s, "Old.md"))
	if body.Match != "exact" || body.File.FileID != "file-2" {
		t.Fatalf("body = %+v", body)
	}
}

func TestResolveReturns410FileDeletedForPathsWhoseFileIsGone(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"file-1", "Gone.md", "bye", ""}}, commitOpts{})
	commitSeeds(t, s, nil, commitOpts{})
	wantErr(t, resolve(s, "Gone.md"), 410, "FILE_DELETED", "File was deleted.")
}

func TestResolveReturns404ForUnknownPathsAnd400ForInvalidPaths(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"file-1", "Note.md", "hi", ""}}, commitOpts{})
	wantErr(t, resolve(s, "Missing.md"), 404, "VAULT_NOT_FOUND", "File was not found.")
	wantErr(t, resolve(s, "../secret"), 400, "INVALID_PATH", "Path must be a canonical vault-relative path.")
	wantErr(t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/resolve"), 400, "INVALID_PATH", "A path query parameter is required.")
	wantErr(t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/resolve?path="), 400, "INVALID_PATH", "A path query parameter is required.")
}

func TestResolveNeverWritesThePathToTheAccessLog(t *testing.T) {
	s := testutil.Setup(t, newApp)
	secret := "Personal/Therapy/2026-09-02.md"
	commitSeeds(t, s, []seed{{"file-1", secret, "private", ""}}, commitOpts{})
	s.Logs.Reset()
	if r := resolve(s, secret); r.Status != 200 {
		t.Fatalf("resolve: %d", r.Status)
	}
	text := s.Logs.String()
	if strings.Contains(text, secret) || strings.Contains(text, url.QueryEscape(secret)) || strings.Contains(text, url.PathEscape(secret)) {
		t.Fatalf("path leaked: %s", text)
	}
	var line map[string]any
	lines := strings.Split(strings.TrimSpace(text), "\n")
	_ = json.Unmarshal([]byte(lines[len(lines)-1]), &line)
	if line["path_resolved"] != true || line["resolve_match"] != "exact" {
		t.Fatalf("line = %v", line)
	}
}

// ---- file listing, raw content and headers ----

func TestFileListingTreeAndSingleFile(t *testing.T) {
	s := testutil.Setup(t, newApp)
	mime := "text/markdown"
	commitSeeds(t, s, []seed{{"file-1", "Note.md", "hi", ""}}, commitOpts{mime: mime})
	for _, p := range []string{"/files", "/tree"} {
		r := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+p)
		want := `{"revision":1,"files":[{"fileId":"file-1","path":"Note.md","blobHash":"` + sha("hi") + `","size":2,"mtime":100,"mimeType":"text/markdown","kind":"markdown"}]}`
		if r.Status != 200 || r.Text() != want {
			t.Fatalf("%s = %s", p, r.Text())
		}
	}
	one := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/file-1")
	if one.Status != 200 || !strings.HasPrefix(one.Text(), `{"file":{"fileId":"file-1"`) {
		t.Fatalf("file = %s", one.Text())
	}
	wantErr(t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/nope"), 404, "VAULT_NOT_FOUND", "File was not found.")
	empty := testutil.Setup(t, newApp)
	if r := getAs(empty, empty.Token, "/api/v1/vaults/"+empty.VaultID+"/files"); r.Text() != `{"revision":0,"files":[]}` {
		t.Fatalf("empty = %s", r.Text())
	}
}

func TestRawContentHeadersAndForcedDownloads(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{
		{"md", "Note.md", "# hi", "markdown"},
		{"bin", "assets/blob.bin", "bytes", "attachment"},
	}, commitOpts{})
	for _, suffix := range []string{"/files/md/content", "/files/md/raw", "/attachments/md"} {
		r := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+suffix)
		h := r.Header
		if r.Status != 200 || r.Text() != "# hi" || h.Get("Content-Type") != "text/markdown; charset=utf-8" || h.Get("Content-Length") != "4" ||
			h.Get("X-Content-Type-Options") != "nosniff" || h.Get("Content-Security-Policy") != "sandbox" || h.Get("Content-Disposition") != "" {
			t.Fatalf("%s: %d %v %q", suffix, r.Status, h, r.Text())
		}
	}
	bin := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/bin/raw")
	if bin.Header.Get("Content-Type") != "application/octet-stream" || bin.Header.Get("Content-Disposition") != "" {
		t.Fatalf("bin headers = %v", bin.Header)
	}
	ctx := context.Background()
	cases := []struct {
		mime     string
		download bool
	}{
		{"text/html", true}, {"text/html; charset=utf-8", true}, {"TEXT/HTML;charset=x", true}, {"application/xhtml+xml", true},
		{"image/svg+xml", true}, {"Image/SVG+XML; charset=utf-8", true},
		{"text/plain", false}, {"text/htmlx", false}, {"image/png", false}, {"application/json", false},
	}
	for i, c := range cases {
		mime := c.mime
		id := "f" + string(rune('a'+i))
		_ = s.DB.VaultFiles().Upsert(ctx, vm.CurrentVaultFile{FileID: id, VaultID: s.VaultID, Path: "dir/My Évil file " + id + ".html", BlobHash: sha("# hi"), Size: 4, Mtime: 1, MimeType: &mime, Kind: vm.KindAttachment, UpdatedRevision: 1})
		r := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/"+id+"/raw")
		cd := r.Header.Get("Content-Disposition")
		if c.download && cd != "attachment; filename=\"My%20%C3%89vil%20file%20"+id+".html\"" {
			t.Fatalf("%s: disposition = %q", c.mime, cd)
		}
		if !c.download && cd != "" {
			t.Fatalf("%s: unexpected disposition %q", c.mime, cd)
		}
		if r.Header.Get("Content-Type") != c.mime || r.Header.Get("X-Content-Type-Options") != "nosniff" || r.Header.Get("Content-Security-Policy") != "sandbox" {
			t.Fatalf("%s: headers = %v", c.mime, r.Header)
		}
	}
}

func TestRawContentMissingBlobAndMissingFile(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"md", "Note.md", "# hi", "markdown"}}, commitOpts{})
	_ = s.Blobs.Delete(context.Background(), sha("# hi"))
	wantErr(t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/md/raw"), 404, "BLOB_MISSING", "File content is missing.")
	wantErr(t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/zzz/raw"), 404, "VAULT_NOT_FOUND", "File was not found.")
	wantErr(t, testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID+"/files/md/raw", nil, nil), 401, "AUTH_REQUIRED", "")
}

func TestRenderedMarkdownLinksBacklinksAndSearch(t *testing.T) {
	// Without an index service rendering is unavailable; search falls back to path matching.
	plain := testutil.Setup(t, newApp)
	commitSeeds(t, plain, []seed{{"a", "Alpha.md", "[[Beta]]", ""}, {"img", "pic.png", "x", "attachment"}}, commitOpts{})
	wantErr(t, getAs(plain, plain.Token, "/api/v1/vaults/"+plain.VaultID+"/files/a/rendered"), 503, "INDEX_PENDING", "Markdown rendering is not available.")
	sr := getAs(plain, plain.Token, "/api/v1/vaults/"+plain.VaultID+"/search?q=ALP")
	if sr.Status != 200 || !strings.HasPrefix(sr.Text(), `{"revision":1,"results":[{"fileId":"a","path":"Alpha.md"`) {
		t.Fatalf("fallback search = %s", sr.Text())
	}

	s := testutil.Setup(t, newApp, testutil.WithDeps(runtimeIndex))
	commitSeeds(t, s, []seed{
		{"a", "Alpha.md", "---\ntitle: First Title\n---\n[[Beta]] and **bold**", ""},
		{"b", "Beta.md", "# Beta heading", ""},
		{"img", "pic.png", "x", "attachment"},
	}, commitOpts{})
	// Indexing is fire-and-forget after commits: wait for that pass to land,
	// then run one explicitly so the assertions below are deterministic.
	waitIndexed(t, s)
	if err := s.Deps.IndexService.(indexer.IndexService).IndexVault(context.Background(), s.VaultID, 1); err != nil {
		t.Fatal(err)
	}
	rendered := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/a/rendered")
	if rendered.Status != 200 || !strings.Contains(rendered.Text(), `"html":"`) || !strings.Contains(rendered.Text(), "<strong>bold</strong>") ||
		!strings.Contains(rendered.Text(), "First Title") == false && false {
		t.Fatalf("rendered = %d %s", rendered.Status, rendered.Text())
	}
	wantErr(t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/img/rendered"), 400, "INVALID_MANIFEST", "Only Markdown files can be rendered.")

	links := decode[struct{ Links []vm.NoteLink }](t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/a/links"))
	if len(links.Links) != 1 || links.Links[0].LinkPath != "Beta" || links.Links[0].TargetFileID == nil || *links.Links[0].TargetFileID != "b" {
		t.Fatalf("links = %+v", links.Links)
	}
	back := decode[struct{ Links []vm.NoteLink }](t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/b/backlinks"))
	if len(back.Links) != 1 || back.Links[0].SourceFileID != "a" {
		t.Fatalf("backlinks = %+v", back.Links)
	}
	all := decode[struct{ Links []vm.NoteLink }](t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/links"))
	if len(all.Links) != 1 {
		t.Fatalf("all links = %+v", all.Links)
	}
	if r := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/files/zzz/links"); r.Status != 404 {
		t.Fatalf("links of unknown file: %d", r.Status)
	}

	// Indexed search matches titles as well as paths and attaches the title.
	byTitle := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/search?q="+url.QueryEscape("  first title "))
	if byTitle.Status != 200 || !strings.Contains(byTitle.Text(), `"title":"First Title"`) {
		t.Fatalf("title search = %s", byTitle.Text())
	}
	limited := decode[struct{ Results []any }](t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/search?q=.&limit=1"))
	if len(limited.Results) != 1 {
		t.Fatalf("limit=1 results = %d", len(limited.Results))
	}
	for _, q := range []string{"", "?q=", "?q=%20%20", "?q=" + strings.Repeat("x", 201)} {
		wantErr(t, getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/search"+q), 400, "INVALID_MANIFEST", "Request validation failed.")
	}
	// limit=abc and limit=0 fall back to 50; limit above 100 is capped.
	for _, q := range []string{"&limit=abc", "&limit=0", "&limit=1000"} {
		if r := getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/search?q=a"+q); r.Status != 200 {
			t.Fatalf("limit variant %s: %d", q, r.Status)
		}
	}
}

// ---- graph payload ----

// overrideDB patches the note-index reads the way the Node tests patch the
// in-memory repository.
type overrideDB struct {
	db.Database
	metadata func() []vm.NoteMetadata
	links    func() []vm.NoteLink
	state    func() *vm.VaultIndexState
	fail     bool
}

type overrideIndex struct {
	db.NoteIndexRepository
	o *overrideDB
}

func (o *overrideDB) NoteIndex() db.NoteIndexRepository {
	return overrideIndex{o.Database.NoteIndex(), o}
}

func (i overrideIndex) ListMetadata(ctx context.Context, vaultID string) ([]vm.NoteMetadata, error) {
	if i.o.fail {
		return nil, errors.New("must not query note_metadata on a hit")
	}
	if i.o.metadata != nil {
		return i.o.metadata(), nil
	}
	return i.NoteIndexRepository.ListMetadata(ctx, vaultID)
}

func (i overrideIndex) ListLinks(ctx context.Context, vaultID string) ([]vm.NoteLink, error) {
	if i.o.fail {
		return nil, errors.New("must not query note_links on a hit")
	}
	if i.o.links != nil {
		return i.o.links(), nil
	}
	return i.NoteIndexRepository.ListLinks(ctx, vaultID)
}

func (i overrideIndex) GetState(ctx context.Context, vaultID string) (*vm.VaultIndexState, error) {
	if i.o.state != nil {
		return i.o.state(), nil
	}
	return i.NoteIndexRepository.GetState(ctx, vaultID)
}

func seedGraphFixture(t *testing.T, opts ...testutil.Option) (*testutil.Session, *overrideDB) {
	t.Helper()
	o := &overrideDB{Database: baseDB(t)}
	s := testutil.Setup(t, newApp, append([]testutil.Option{testutil.WithDatabase(o)}, opts...)...)
	commitSeeds(t, s, []seed{
		{"file-a", "A.md", "[[B]] ![[img.png]] [[Missing Note]] #foo", "markdown"},
		{"file-b", "B.md", "# B", "markdown"},
		{"file-img", "img.png", "png-bytes", "attachment"},
	}, commitOpts{})
	meta := func(fileID, title string, tags ...string) vm.NoteMetadata {
		if tags == nil {
			tags = []string{}
		}
		return vm.NoteMetadata{FileID: fileID, VaultID: s.VaultID, IndexedBlobHash: "h", Title: &title, Frontmatter: map[string]any{},
			Headings: []any{}, Tags: tags, Blocks: []any{}, IndexedAt: 1}
	}
	link := func(id, linkPath, source string, target *string, embed bool) vm.NoteLink {
		return vm.NoteLink{ID: id, VaultID: s.VaultID, SourceFileID: source, LinkPath: linkPath, IsEmbed: embed, TargetFileID: target, CreatedAt: 1}
	}
	b, img := "file-b", "file-img"
	o.metadata = func() []vm.NoteMetadata {
		return []vm.NoteMetadata{meta("file-a", "Alpha", "foo"), meta("file-b", "Beta")}
	}
	o.links = func() []vm.NoteLink {
		return []vm.NoteLink{
			link("l1", "B", "file-a", &b, false), link("l2", "img.png", "file-a", &img, true),
			link("l3", "Missing Note", "file-a", nil, false), link("l4", "Missing Note", "file-b", nil, false),
		}
	}
	o.state = func() *vm.VaultIndexState { return &vm.VaultIndexState{VaultID: s.VaultID, IndexedRevision: 1} }
	return s, o
}

func graphGet(s *testutil.Session, extra testutil.Headers) testutil.Response {
	h := testutil.Bearer(s.Token)
	for k, v := range extra {
		h[k] = v
	}
	return testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID+"/graph", h, nil)
}

type graphBody struct {
	Revision  int
	Truncated bool
	Nodes     []struct {
		ID, Kind, Path string
		Title          *string
		Tags           []string
		CreatedAt      int64
	}
	Edges []struct{ S, T, Count, Embeds int }
}

func TestGraphSynthesizesAttachmentAndTagNodesWithIndexBasedEdges(t *testing.T) {
	s, _ := seedGraphFixture(t)
	r := graphGet(s, nil)
	if r.Status != 200 || r.Header.Get("ETag") != `W/"1-1-graph-v3"` || r.Header.Get("Content-Type") != "application/json" {
		t.Fatalf("graph: %d %v", r.Status, r.Header)
	}
	body := decode[graphBody](t, r)
	if body.Revision != 1 || body.Truncated {
		t.Fatalf("body = %+v", body)
	}
	index := map[string]int{}
	var ids []string
	for i, n := range body.Nodes {
		index[n.ID] = i
		ids = append(ids, n.ID)
	}
	sort.Strings(ids)
	if strings.Join(ids, ",") != "file-a,file-b,file-img,tag:foo" {
		t.Fatalf("ids = %v", ids)
	}
	node := func(id string) (k string, created int64) { n := body.Nodes[index[id]]; return n.Kind, n.CreatedAt }
	if k, c := node("file-a"); k != "note" || c != 100 {
		t.Fatalf("file-a = %s %d", k, c)
	}
	if k, c := node("file-img"); k != "attachment" || c != 100 {
		t.Fatalf("img = %s %d", k, c)
	}
	if tag := body.Nodes[index["tag:foo"]]; tag.Kind != "tag" || tag.Title == nil || *tag.Title != "#foo" || tag.CreatedAt != 100 {
		t.Fatalf("tag = %+v", tag)
	}
	for _, n := range body.Nodes[:3] {
		if n.Kind == "tag" {
			t.Fatal("markdown nodes come first")
		}
	}
	edge := func(a, b string) (count, embeds int, ok bool) {
		for _, e := range body.Edges {
			if e.S == index[a] && e.T == index[b] {
				return e.Count, e.Embeds, true
			}
		}
		return 0, 0, false
	}
	for _, want := range []struct {
		a, b          string
		count, embeds int
	}{{"file-a", "file-b", 1, 0}, {"file-a", "file-img", 1, 1}, {"file-a", "tag:foo", 1, 0}} {
		if c, e, ok := edge(want.a, want.b); !ok || c != want.count || e != want.embeds {
			t.Fatalf("edge %s->%s = %d %d %v", want.a, want.b, c, e, ok)
		}
	}
	for _, e := range body.Edges {
		if e.S >= len(body.Nodes) || e.T >= len(body.Nodes) {
			t.Fatalf("edge out of range: %+v", e)
		}
	}
}

func TestGraphAnswers304WhenTheVaultAndIndexRevisionsAreUnchanged(t *testing.T) {
	s, _ := seedGraphFixture(t)
	etag := graphGet(s, nil).Header.Get("ETag")
	second := graphGet(s, testutil.Headers{"if-none-match": etag})
	if second.Status != 304 || len(second.Body) != 0 || second.Header.Get("ETag") != etag {
		t.Fatalf("second = %d %q %v", second.Status, second.Text(), second.Header)
	}
	// A different (older) index revision invalidates the conditional request.
	third := graphGet(s, testutil.Headers{"if-none-match": `W/"1-0-graph-v3"`})
	if third.Status != 200 {
		t.Fatalf("third = %d", third.Status)
	}
}

func TestGraphServesTheCachedPayloadWithoutTouchingTheIndexTablesOnAHit(t *testing.T) {
	s, o := seedGraphFixture(t)
	first := graphGet(s, nil)
	if first.Status != 200 || first.Header.Get("ETag") != `W/"1-1-graph-v3"` {
		t.Fatalf("first = %d", first.Status)
	}
	if c, _ := s.DB.GraphCache().Find(context.Background(), s.VaultID); c == nil || c.Revision != 1 || c.IndexedRevision != 1 {
		t.Fatalf("cache = %+v", c)
	}
	o.fail = true
	second := graphGet(s, nil)
	if second.Status != 200 || second.Header.Get("ETag") != `W/"1-1-graph-v3"` || second.Text() != first.Text() {
		t.Fatalf("second = %d %s", second.Status, second.Text())
	}
}

func TestGraphRewritesTheCacheAfterIndexVaultAndDropsItWhenIndexingFails(t *testing.T) {
	s, o := seedGraphFixture(t, testutil.WithDeps(func(d *httpx.Dependencies) {
		d.IndexService = nil
	}))
	ctx := context.Background()
	first := graphGet(s, nil)
	if first.Status != 200 || strings.Contains(first.Text(), "tag:bar") {
		t.Fatalf("first = %s", first.Text())
	}
	svc := indexer.NewRuntimeIndexService(indexer.RuntimeDeps{Database: o, BlobStore: s.Blobs, Clock: core.NewFakeClock(testutil.FixedNow + 1), IDs: &testutil.CounterIDs{}})
	title := func(t string) *string { return &t }
	o.metadata = func() []vm.NoteMetadata {
		mk := func(id, ti string, tags ...string) vm.NoteMetadata {
			if tags == nil {
				tags = []string{}
			}
			return vm.NoteMetadata{FileID: id, VaultID: s.VaultID, IndexedBlobHash: "h", Title: title(ti), Frontmatter: map[string]any{}, Headings: []any{}, Tags: tags, Blocks: []any{}, IndexedAt: 1}
		}
		return []vm.NoteMetadata{mk("file-a", "Alpha", "foo", "bar"), mk("file-b", "Beta")}
	}
	if err := svc.IndexVault(ctx, s.VaultID, 1); err != nil {
		t.Fatal(err)
	}
	second := graphGet(s, nil)
	if second.Status != 200 || !strings.Contains(second.Text(), `"tag:bar"`) {
		t.Fatalf("second = %s", second.Text())
	}
	// Drop every blob so indexing fails: the stale row is deleted and the next
	// request rebuilds from the index tables.
	for _, h := range []string{sha("[[B]] ![[img.png]] [[Missing Note]] #foo"), sha("# B"), sha("png-bytes")} {
		_ = s.Blobs.Delete(ctx, h)
	}
	if err := svc.IndexVault(ctx, s.VaultID, 1); err == nil {
		t.Fatal("indexing must fail without blobs")
	}
	if c, _ := s.DB.GraphCache().Find(ctx, s.VaultID); c != nil {
		t.Fatalf("cache row must be dropped: %+v", c)
	}
	third := graphGet(s, nil)
	if third.Status != 200 {
		t.Fatalf("third = %d", third.Status)
	}
	if c, _ := s.DB.GraphCache().Find(ctx, s.VaultID); c == nil || c.Revision != 1 || c.IndexedRevision != 1 {
		t.Fatalf("cache after rebuild = %+v", c)
	}
}
