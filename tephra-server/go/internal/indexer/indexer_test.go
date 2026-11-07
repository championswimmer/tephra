package indexer

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/markdown"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func sp(s string) *string { return &s }

func file(fileID, path string, kind vm.VaultFileKind) vm.CurrentVaultFile {
	return vm.CurrentVaultFile{FileID: fileID, VaultID: "vault", Path: path, Kind: kind, BlobHash: "hash-" + fileID, Size: 1, Mtime: 1, UpdatedRevision: 1}
}

func counter(prefix string) func() string {
	n := 0
	return func() string { n++; return fmt.Sprintf("%s%d", prefix, n) }
}

// ---- indexer.test.ts ----

func TestIndexUtilities(t *testing.T) {
	files := []vm.CurrentVaultFile{file("a", "A.md", vm.KindMarkdown), file("b", "Folder/B.md", vm.KindMarkdown), file("image", "image.png", vm.KindAttachment)}

	t.Run("creates metadata and occurrence link rows against the current path index", func(t *testing.T) {
		rows := BuildIndexRows(BuildIndexInput{
			VaultID: "vault", Files: files, IndexedAt: 10, GenerateID: counter("link-"),
			Notes: []ParsedVaultNote{
				{FileID: "a", Parsed: markdown.ParseNote("---\ntitle: Alpha\ntags: [one]\n---\n# Heading\n[[Folder/B]] [[Folder/B]] ![[image.png]] [[Missing]]")},
				{FileID: "b", Parsed: markdown.ParseNote("# Beta")},
			},
		})
		m := rows.Metadata[0]
		if m.FileID != "a" || *m.Title != "Alpha" || !reflect.DeepEqual(m.Tags, []string{"one"}) || m.IndexedBlobHash != "hash-a" {
			t.Fatalf("metadata: %+v", m)
		}
		var targets, ids []string
		for _, l := range rows.Links {
			if l.TargetFileID == nil {
				targets = append(targets, "<nil>")
			} else {
				targets = append(targets, *l.TargetFileID)
			}
			ids = append(ids, l.ID)
		}
		if !reflect.DeepEqual(targets, []string{"b", "b", "image", "<nil>"}) {
			t.Fatalf("targets %v", targets)
		}
		if !reflect.DeepEqual(ids, []string{"link-1", "link-2", "link-3", "link-4"}) {
			t.Fatalf("ids %v", ids)
		}
	})

	t.Run("aggregates graph edges and excludes attachment and unresolved targets", func(t *testing.T) {
		rows := BuildIndexRows(BuildIndexInput{
			VaultID: "vault", Files: files, IndexedAt: 10, GenerateID: counter(""),
			Notes: []ParsedVaultNote{{FileID: "a", Parsed: markdown.ParseNote("[[Folder/B]] [[Folder/B]] ![[Folder/B]] ![[image.png]] [[Missing]]")}},
		})
		g := BuildGraph(BuildGraphInput{Files: files, Metadata: rows.Metadata, Links: rows.Links})
		if len(g.Nodes) != 2 || g.Nodes[0].ID != "a" || g.Nodes[1].ID != "b" {
			t.Fatalf("nodes %+v", g.Nodes)
		}
		if !reflect.DeepEqual(g.Edges, []GraphEdge{{Source: "a", Target: "b", Count: 3, EmbedCount: 1}}) {
			t.Fatalf("edges %+v", g.Edges)
		}
	})
}

// ---- graph-payload.test.ts ----

func gfile(fileID, path string, mtime int64, kind vm.VaultFileKind) vm.CurrentVaultFile {
	f := file(fileID, path, kind)
	f.Mtime = mtime
	return f
}

func gmeta(fileID string, title *string, tags ...string) vm.NoteMetadata {
	if tags == nil {
		tags = []string{}
	}
	return vm.NoteMetadata{FileID: fileID, VaultID: "vault", IndexedBlobHash: "hash-" + fileID, Title: title, Frontmatter: map[string]any{}, Headings: []any{}, Tags: tags, Blocks: []any{}, IndexedAt: 1}
}

func glink(id, source, linkPath string, target *string, embed bool) vm.NoteLink {
	return vm.NoteLink{ID: id, VaultID: "vault", SourceFileID: source, LinkPath: linkPath, IsEmbed: embed, TargetFileID: target, CreatedAt: 1}
}

func edgeBetween(p GraphPayload, a, b string) *GraphPayloadEdge {
	idx := map[string]int{}
	for i, n := range p.Nodes {
		idx[n.ID] = i
	}
	for i := range p.Edges {
		if p.Edges[i].S == idx[a] && p.Edges[i].T == idx[b] {
			return &p.Edges[i]
		}
	}
	return nil
}

func TestBuildGraphPayload(t *testing.T) {
	t.Run("synthesizes attachment and tag nodes with index-based edges", func(t *testing.T) {
		p := BuildGraphPayload(BuildGraphPayloadInput{
			Files:        []vm.CurrentVaultFile{gfile("file-a", "A.md", 100, vm.KindMarkdown), gfile("file-b", "B.md", 100, vm.KindMarkdown), gfile("file-img", "img.png", 100, vm.KindAttachment)},
			MetadataRows: []vm.NoteMetadata{gmeta("file-a", sp("Alpha"), "foo"), gmeta("file-b", sp("Beta"))},
			Links: []vm.NoteLink{
				glink("l1", "file-a", "B", sp("file-b"), false),
				glink("l2", "file-a", "img.png", sp("file-img"), true),
				glink("l3", "file-a", "Missing Note", nil, false),
				glink("l4", "file-b", "Missing Note", nil, false),
			},
			LatestRevision: 1, IndexedRevision: 1,
		})
		if p.Revision != 1 || p.Truncated || p.IndexPending {
			t.Fatalf("header %+v", p)
		}
		if strings.Contains(string(mustJSON(t, p)), "indexPending") {
			t.Fatal("indexPending present")
		}
		ids := []string{}
		byID := map[string]GraphPayloadNode{}
		for _, n := range p.Nodes {
			ids = append(ids, n.ID)
			byID[n.ID] = n
		}
		sort.Strings(ids)
		if !reflect.DeepEqual(ids, []string{"file-a", "file-b", "file-img", "tag:foo"}) {
			t.Fatalf("ids %v", ids)
		}
		if n := byID["file-a"]; n.Kind != "note" || !reflect.DeepEqual(n.Tags, []string{"foo"}) || n.CreatedAt != 100 {
			t.Fatalf("a %+v", n)
		}
		if n := byID["file-img"]; n.Kind != "attachment" || len(n.Tags) != 0 || n.CreatedAt != 100 {
			t.Fatalf("img %+v", n)
		}
		if n := byID["tag:foo"]; n.Kind != "tag" || *n.Title != "#foo" || n.CreatedAt != 100 {
			t.Fatalf("tag %+v", n)
		}
		for _, n := range p.Nodes[:3] {
			if n.Kind == "tag" {
				t.Fatal("tag before notes")
			}
		}
		if e := edgeBetween(p, "file-a", "file-b"); e == nil || e.Count != 1 || e.Embeds != 0 {
			t.Fatalf("a-b %+v", e)
		}
		if e := edgeBetween(p, "file-a", "file-img"); e == nil || e.Count != 1 || e.Embeds != 1 {
			t.Fatalf("a-img %+v", e)
		}
		if e := edgeBetween(p, "file-a", "tag:foo"); e == nil || e.Count != 1 || e.Embeds != 0 {
			t.Fatalf("a-tag %+v", e)
		}
		for _, e := range p.Edges {
			if e.S >= len(p.Nodes) || e.T >= len(p.Nodes) {
				t.Fatal("edge out of range")
			}
		}
	})

	t.Run("creates no nodes or edges for external URLs or unresolved links", func(t *testing.T) {
		p := BuildGraphPayload(BuildGraphPayloadInput{
			Files:        []vm.CurrentVaultFile{gfile("file-a", "A.md", 100, vm.KindMarkdown), gfile("file-b", "B.md", 100, vm.KindMarkdown)},
			MetadataRows: []vm.NoteMetadata{gmeta("file-a", sp("Alpha")), gmeta("file-b", sp("Beta"))},
			Links: []vm.NoteLink{
				glink("l1", "file-a", "https://example.com/page", nil, false),
				glink("l2", "file-a", "mailto:a@b.co", nil, false),
				glink("l3", "file-a", "Missing Note", nil, false),
				glink("l4", "file-a", "B", sp("file-b"), false),
			},
			LatestRevision: 1, IndexedRevision: 1,
		})
		if len(p.Nodes) != 2 || p.Nodes[0].ID != "file-a" || p.Nodes[1].ID != "file-b" {
			t.Fatalf("nodes %+v", p.Nodes)
		}
		for _, n := range p.Nodes {
			if n.Kind == "unresolved" {
				t.Fatal("unresolved node")
			}
		}
		if !reflect.DeepEqual(p.Edges, []GraphPayloadEdge{{S: 0, T: 1, Count: 1, Embeds: 0}}) {
			t.Fatalf("edges %+v", p.Edges)
		}
	})

	t.Run("aggregates duplicate edges and counts embeds", func(t *testing.T) {
		p := BuildGraphPayload(BuildGraphPayloadInput{
			Files:        []vm.CurrentVaultFile{gfile("file-a", "A.md", 100, vm.KindMarkdown), gfile("file-b", "B.md", 100, vm.KindMarkdown)},
			MetadataRows: []vm.NoteMetadata{gmeta("file-a", sp("Alpha")), gmeta("file-b", sp("Beta"))},
			Links: []vm.NoteLink{
				glink("l1", "file-a", "B", sp("file-b"), false),
				glink("l2", "file-a", "B", sp("file-b"), false),
				glink("l3", "file-a", "B", sp("file-b"), true),
			},
			LatestRevision: 2, IndexedRevision: 2,
		})
		if !reflect.DeepEqual(p.Edges, []GraphPayloadEdge{{S: 0, T: 1, Count: 3, Embeds: 1}}) {
			t.Fatalf("edges %+v", p.Edges)
		}
	})

	t.Run("flags indexPending when the index lags the vault revision", func(t *testing.T) {
		in := BuildGraphPayloadInput{
			Files:          []vm.CurrentVaultFile{gfile("file-a", "A.md", 100, vm.KindMarkdown)},
			MetadataRows:   []vm.NoteMetadata{gmeta("file-a", sp("Alpha"))},
			LatestRevision: 3,
		}
		in.IndexedRevision = 2
		if p := BuildGraphPayload(in); p.Revision != 3 || !p.IndexPending {
			t.Fatalf("%+v", p)
		}
		in.IndexedRevision = 3
		if p := BuildGraphPayload(in); strings.Contains(string(mustJSON(t, p)), "indexPending") {
			t.Fatal("indexPending present")
		}
	})

	t.Run("truncates to the node limit with markdown notes first", func(t *testing.T) {
		p := truncationPayload(GraphNodeLimit+500, 0)
		if !p.Truncated || len(p.Nodes) != GraphNodeLimit {
			t.Fatalf("truncated=%v nodes=%d", p.Truncated, len(p.Nodes))
		}
		for _, n := range p.Nodes {
			if n.Kind != "note" {
				t.Fatal("non-note node")
			}
		}
	})
}

func mustJSON(t *testing.T, v any) []byte {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func truncationPayload(count, nLinks int) GraphPayload {
	return BuildGraphPayload(truncationPayloadInput(count, nLinks))
}

// ---- cross-implementation vectors ----

type vecCase struct {
	Name         string
	Files        []vm.CurrentVaultFile
	MetadataRows []vm.NoteMetadata
	Links        []vm.NoteLink
	Latest       int64
	Indexed      int64
	Payload      string
}

type vectors struct {
	Cases      []vecCase
	Truncation struct {
		Count  int
		Links  int
		Sha256 string
	}
	Fixture struct {
		Files   []vm.CurrentVaultFile
		Rows    json.RawMessage
		Graph   NoteGraph
		Payload string
	}
}

func loadVectors(t *testing.T) vectors {
	t.Helper()
	data, err := os.ReadFile("testdata/indexer-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func TestGraphPayloadMatchesNodeVectors(t *testing.T) {
	v := loadVectors(t)
	if len(v.Cases) == 0 {
		t.Fatal("no vectors")
	}
	for _, c := range v.Cases {
		t.Run(c.Name, func(t *testing.T) {
			p := BuildGraphPayload(BuildGraphPayloadInput{Files: c.Files, MetadataRows: c.MetadataRows, Links: c.Links, LatestRevision: c.Latest, IndexedRevision: c.Indexed})
			got, _ := p.MarshalJSON()
			if string(got) != c.Payload {
				t.Fatalf("payload mismatch\n got: %.600s\nwant: %.600s", got, c.Payload)
			}
		})
	}
	t.Run("truncation digest", func(t *testing.T) {
		p := BuildGraphPayload(truncationPayloadInput(v.Truncation.Count, v.Truncation.Links))
		b, _ := p.MarshalJSON()
		sum := sha256.Sum256(b)
		if hex.EncodeToString(sum[:]) != v.Truncation.Sha256 {
			t.Fatal("digest mismatch")
		}
	})
}

func truncationPayloadInput(count, nLinks int) BuildGraphPayloadInput {
	files := make([]vm.CurrentVaultFile, count)
	meta := make([]vm.NoteMetadata, count)
	for i := range files {
		files[i] = gfile(fmt.Sprintf("note-%d", i), fmt.Sprintf("Note-%d.md", i), int64(i), vm.KindMarkdown)
		meta[i] = gmeta(files[i].FileID, nil)
	}
	links := make([]vm.NoteLink, nLinks)
	for i := range links {
		links[i] = glink(fmt.Sprintf("l%d", i), fmt.Sprintf("note-%d", (i*7)%count), "x", sp(fmt.Sprintf("note-%d", (i*13)%count)), i%5 == 0)
	}
	return BuildGraphPayloadInput{Files: files, MetadataRows: meta, Links: links, LatestRevision: 1, IndexedRevision: 1}
}

func TestGraphETag(t *testing.T) {
	if got := GraphETag(7, 5); got != `W/"7-5-graph-v2"` {
		t.Fatal(got)
	}
}

func TestEncodeURIComponent(t *testing.T) {
	for in, want := range map[string]string{"a b": "a%20b", "a+b": "a%2Bb", "x!*'()~-_.": "x!*'()~-_.", "é/日": "%C3%A9%2F%E6%97%A5", "v-1": "v-1"} {
		if got := encodeURIComponent(in); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

func TestDecodeUTF8(t *testing.T) {
	cases := map[string]string{
		"\xEF\xBB\xBFhi": "hi",
		"a\xE2\x82b":     "a�b", // truncated 3-byte sequence is one maximal subpart
		"\xFF\xFE":       "��",
		"\xF0\x9F\x98":   "�",
		"x\xC0\x80":      "x��",
		"\xED\xA0\x80":   "���",
		"ok é 日本 😀":      "ok é 日本 😀",
	}
	for in, want := range cases {
		if got := decodeUTF8([]byte(in)); got != want {
			t.Errorf("%q: got %q want %q", in, got, want)
		}
	}
}

// ---- compat-vault.test.ts ----

var expectedFiles = []string{
	"Home.md", "Root.md", "Simple.md", "Folders/Alpha.md", "Folders/Beta.md",
	"Duplicate/A/Shared.md", "Duplicate/B/Shared.md",
	"Links/Aliases.md", "Links/Blocks.md", "Links/Embeds.md", "Links/Headings.md", "Links/Unresolved.md",
	"Markdown/Callouts.md", "Markdown/Code.md", "Markdown/Frontmatter.md", "Markdown/Math.md", "Markdown/Tables.md", "Markdown/Tags.md", "Markdown/Tasks.md",
	"Notes/Project Alpha.md", "Notes/Referenced Note.md", "Notes/Unresolved Links.md",
	"Unicode/Café.md", "Unicode/日本語.md", "Unicode/Spaces in name.md",
	"Attachments/image.png", "Attachments/pixel.png", "Attachments/sample.pdf",
}

const vaultDir = "../../../packages/test-fixtures/vault"

func listVaultFiles(t *testing.T) []string {
	t.Helper()
	var found []string
	err := filepath.WalkDir(vaultDir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return err
		}
		rel, _ := filepath.Rel(vaultDir, p)
		found = append(found, filepath.ToSlash(rel))
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	sort.Strings(found)
	return found
}

type compat struct {
	files      []vm.CurrentVaultFile
	notes      []ParsedVaultNote
	rows       IndexRows
	graph      NoteGraph
	idByPath   map[string]string
	metaByPath map[string]vm.NoteMetadata
}

func loadCompat(t *testing.T) *compat {
	t.Helper()
	c := &compat{idByPath: map[string]string{}, metaByPath: map[string]vm.NoteMetadata{}}
	pathByID := map[string]string{}
	for i, p := range listVaultFiles(t) {
		id := fmt.Sprintf("fixture-%03d", i)
		kind := vm.KindAttachment
		if strings.HasSuffix(strings.ToLower(p), ".md") {
			kind = vm.KindMarkdown
		}
		c.files = append(c.files, vm.CurrentVaultFile{FileID: id, VaultID: "compat-fixture", Path: p, Kind: kind, BlobHash: "fixture-hash-" + id, Size: 1, Mtime: 1, UpdatedRevision: 1})
		c.idByPath[p], pathByID[id] = id, p
		if kind == vm.KindMarkdown {
			data, err := os.ReadFile(filepath.Join(vaultDir, p))
			if err != nil {
				t.Fatal(err)
			}
			c.notes = append(c.notes, ParsedVaultNote{FileID: id, Parsed: markdown.ParseNote(string(data))})
		}
	}
	n := 0
	c.rows = BuildIndexRows(BuildIndexInput{VaultID: "compat-fixture", Files: c.files, Notes: c.notes, IndexedAt: 1700000000000,
		GenerateID: func() string { n++; return fmt.Sprintf("compat-link-%03d", n) }})
	c.graph = BuildGraph(BuildGraphInput{Files: c.files, Metadata: c.rows.Metadata, Links: c.rows.Links})
	for _, m := range c.rows.Metadata {
		c.metaByPath[pathByID[m.FileID]] = m
	}
	return c
}

func (c *compat) id(t *testing.T, p string) string {
	t.Helper()
	id, ok := c.idByPath[p]
	if !ok {
		t.Fatalf("missing fixture file: %s", p)
	}
	return id
}

func (c *compat) linksFrom(t *testing.T, p string) []vm.NoteLink {
	id := c.id(t, p)
	var out []vm.NoteLink
	for _, l := range c.rows.Links {
		if l.SourceFileID == id {
			out = append(out, l)
		}
	}
	return out
}

func (c *compat) link(t *testing.T, src, raw string) vm.NoteLink {
	t.Helper()
	for _, l := range c.linksFrom(t, src) {
		if l.RawText == raw {
			return l
		}
	}
	t.Fatalf("missing link %s in %s", raw, src)
	return vm.NoteLink{}
}

func (c *compat) resolved(t *testing.T, src, raw, target string) vm.NoteLink {
	t.Helper()
	l := c.link(t, src, raw)
	if l.TargetFileID == nil || *l.TargetFileID != c.id(t, target) {
		t.Fatalf("%s %s: target %v, want %s", src, raw, l.TargetFileID, target)
	}
	return l
}

func (c *compat) unresolved(t *testing.T, src, raw string) {
	t.Helper()
	if l := c.link(t, src, raw); l.TargetFileID != nil {
		t.Fatalf("%s %s resolved to %s", src, raw, *l.TargetFileID)
	}
}

func eqPtr(t *testing.T, got *string, want string) {
	t.Helper()
	if got == nil || *got != want {
		t.Fatalf("got %v want %q", got, want)
	}
}

func TestCompatibilityFixtureVault(t *testing.T) {
	c := loadCompat(t)

	t.Run("contains exactly the expected fixture files", func(t *testing.T) {
		want := append([]string(nil), expectedFiles...)
		sort.Strings(want)
		if got := listVaultFiles(t); !reflect.DeepEqual(got, want) {
			t.Fatalf("got %v", got)
		}
	})

	t.Run("produces deterministic metadata titles", func(t *testing.T) {
		for p, want := range map[string]string{
			"Home.md": "Tephra compatibility vault", "Root.md": "Root", "Simple.md": "Simple", "Folders/Alpha.md": "Alpha",
			"Duplicate/A/Shared.md": "Shared A", "Duplicate/B/Shared.md": "Shared B", "Links/Headings.md": "Headings",
			"Markdown/Frontmatter.md": "Frontmatter Fixture", "Unicode/Café.md": "Café", "Notes/Project Alpha.md": "Project Alpha",
		} {
			m, ok := c.metaByPath[p]
			if !ok {
				t.Fatalf("missing metadata for %s", p)
			}
			eqPtr(t, m.Title, want)
		}
		if len(c.rows.Metadata) != len(c.notes) {
			t.Fatal("metadata count")
		}
	})

	t.Run("indexes frontmatter, tags, headings, and blocks", func(t *testing.T) {
		fm := c.metaByPath["Markdown/Frontmatter.md"]
		if fm.Frontmatter["title"] != "Frontmatter Fixture" {
			t.Fatalf("%v", fm.Frontmatter)
		}
		contains := func(have []string, want ...string) {
			t.Helper()
			for _, w := range want {
				found := false
				for _, h := range have {
					found = found || h == w
				}
				if !found {
					t.Fatalf("%v lacks %s", have, w)
				}
			}
		}
		contains(fm.Tags, "docs", "fixture", "inline-tag")
		contains(c.metaByPath["Markdown/Tags.md"].Tags, "alpha", "beta/gamma")
		found := false
		for _, h := range c.metaByPath["Links/Headings.md"].Headings {
			found = found || h.(markdown.HeadingInfo).Text == "Section One"
		}
		if !found {
			t.Fatal("heading Section One")
		}
		hasBlock := func(p, id string) {
			for _, b := range c.metaByPath[p].Blocks {
				if b.(markdown.BlockInfo).ID == id {
					return
				}
			}
			t.Fatalf("%s lacks block %s", p, id)
		}
		hasBlock("Links/Blocks.md", "block-one")
		hasBlock("Notes/Referenced Note.md", "fixture-block")
	})

	t.Run("resolves root, folder, alias, heading, block, and embed links", func(t *testing.T) {
		c.resolved(t, "Root.md", "[[Simple]]", "Simple.md")
		c.resolved(t, "Root.md", "[[Folders/Alpha]]", "Folders/Alpha.md")
		c.resolved(t, "Simple.md", "[[Root]]", "Root.md")
		c.resolved(t, "Folders/Alpha.md", "[[Beta]]", "Folders/Beta.md")
		c.resolved(t, "Folders/Alpha.md", "[[Folders/Beta]]", "Folders/Beta.md")
		c.resolved(t, "Folders/Beta.md", "[[Alpha]]", "Folders/Alpha.md")

		eqPtr(t, c.resolved(t, "Links/Aliases.md", "[[Simple|Custom label]]", "Simple.md").DisplayText, "Custom label")
		eqPtr(t, c.resolved(t, "Links/Aliases.md", "[[Folders/Alpha|the alpha folder]]", "Folders/Alpha.md").DisplayText, "the alpha folder")
		c.resolved(t, "Links/Aliases.md", "[[Alpha]]", "Folders/Alpha.md")

		eqPtr(t, c.resolved(t, "Links/Headings.md", "[[Headings#Section One]]", "Links/Headings.md").Subpath, "Section One")
		eqPtr(t, c.resolved(t, "Links/Blocks.md", "[[Blocks#^block-one]]", "Links/Blocks.md").Subpath, "^block-one")

		if !c.resolved(t, "Links/Embeds.md", "![[Simple]]", "Simple.md").IsEmbed {
			t.Fatal("embed")
		}
		if !c.resolved(t, "Links/Embeds.md", "![[Attachments/image.png]]", "Attachments/image.png").IsEmbed {
			t.Fatal("embed")
		}
		if !c.resolved(t, "Simple.md", "![[Embeds]]", "Links/Embeds.md").IsEmbed {
			t.Fatal("embed")
		}
		if !c.resolved(t, "Simple.md", "![[Attachments/image.png]]", "Attachments/image.png").IsEmbed {
			t.Fatal("embed")
		}

		legacy := c.resolved(t, "Notes/Project Alpha.md", "[[Referenced Note]]", "Notes/Referenced Note.md")
		if legacy.IsEmbed {
			t.Fatal("not embed")
		}
		section := c.resolved(t, "Notes/Project Alpha.md", "[[Referenced Note#Details|details]]", "Notes/Referenced Note.md")
		eqPtr(t, section.Subpath, "Details")
		eqPtr(t, section.DisplayText, "details")
		c.resolved(t, "Notes/Project Alpha.md", "[[Referenced Note#^fixture-block]]", "Notes/Referenced Note.md")
		c.resolved(t, "Home.md", "[[Notes/Project Alpha|the project]]", "Notes/Project Alpha.md")
		c.resolved(t, "Home.md", "![[Attachments/pixel.png]]", "Attachments/pixel.png")
	})

	t.Run("resolves unicode paths", func(t *testing.T) {
		c.resolved(t, "Unicode/Café.md", "[[日本語]]", "Unicode/日本語.md")
		c.resolved(t, "Unicode/Café.md", "[[Spaces in name]]", "Unicode/Spaces in name.md")
		c.resolved(t, "Unicode/日本語.md", "[[Café]]", "Unicode/Café.md")
		c.resolved(t, "Unicode/Spaces in name.md", "[[Simple]]", "Simple.md")
	})

	t.Run("marks unknown targets as unresolved", func(t *testing.T) {
		c.unresolved(t, "Links/Unresolved.md", "[[Does Not Exist]]")
		c.unresolved(t, "Notes/Unresolved Links.md", "[[Does Not Exist]]")
		n, has := 0, false
		for _, l := range c.rows.Links {
			if l.TargetFileID == nil {
				n++
				has = has || l.RawText == "[[Does Not Exist]]"
			}
		}
		if n < 2 || !has {
			t.Fatalf("unresolved %d %v", n, has)
		}
	})

	t.Run("ignores wikilink-like tokens inside fenced and inline code", func(t *testing.T) {
		code := c.linksFrom(t, "Markdown/Code.md")
		if len(code) != 1 || code[0].RawText != "[[Simple]]" || *code[0].TargetFileID != c.id(t, "Simple.md") {
			t.Fatalf("%+v", code)
		}
		for _, l := range c.rows.Links {
			if l.SourceFileID == c.id(t, "Markdown/Code.md") && strings.Contains(l.RawText, "Does Not Exist") {
				t.Fatal("code link indexed")
			}
		}
		for _, l := range c.linksFrom(t, "Notes/Project Alpha.md") {
			if l.RawText == "[[Ignored Inline Code]]" || l.RawText == "[[Ignored Fenced Code]]" {
				t.Fatal(l.RawText)
			}
		}
	})

	t.Run("resolves duplicate basenames toward the closest folder and flags distant ties", func(t *testing.T) {
		c.resolved(t, "Duplicate/A/Shared.md", "[[Shared]]", "Duplicate/A/Shared.md")
		c.resolved(t, "Duplicate/B/Shared.md", "[[Shared]]", "Duplicate/B/Shared.md")
		c.unresolved(t, "Links/Aliases.md", "[[Shared]]")
	})

	t.Run("builds a graph without attachment or unresolved targets", func(t *testing.T) {
		attachments := map[string]bool{}
		for _, f := range c.files {
			if f.Kind == vm.KindAttachment {
				attachments[f.FileID] = true
			}
		}
		for _, e := range c.graph.Edges {
			if attachments[e.Target] || e.Target == "" {
				t.Fatal("bad edge target")
			}
		}
		edge := func(a, b string) *GraphEdge {
			for i := range c.graph.Edges {
				if c.graph.Edges[i].Source == c.id(t, a) && c.graph.Edges[i].Target == c.id(t, b) {
					return &c.graph.Edges[i]
				}
			}
			return nil
		}
		if e := edge("Root.md", "Simple.md"); e == nil || e.Count != 1 {
			t.Fatal("Root->Simple")
		}
		if edge("Links/Embeds.md", "Simple.md") == nil {
			t.Fatal("Embeds->Simple")
		}
		if e := edge("Duplicate/A/Shared.md", "Duplicate/A/Shared.md"); e == nil || e.Count != 1 {
			t.Fatal("Shared self")
		}
		ok := false
		for _, n := range c.graph.Nodes {
			ok = ok || n.Path == "Unicode/日本語.md"
		}
		if !ok {
			t.Fatal("missing unicode node")
		}
	})
}

// The Go rows/graph for the real fixture vault must equal the TS output.
func TestCompatFixtureMatchesNodeVectors(t *testing.T) {
	v := loadVectors(t)
	c := loadCompat(t)
	if !reflect.DeepEqual(c.files, v.Fixture.Files) {
		t.Fatal("fixture file listing differs from TS")
	}
	norm := func(b []byte) any {
		var x any
		if err := json.Unmarshal(b, &x); err != nil {
			t.Fatal(err)
		}
		return x
	}
	got := map[string]any{"metadata": c.rows.Metadata, "links": c.rows.Links, "reindexedSourceFileIds": c.rows.ReindexedSourceFileIDs}
	if !reflect.DeepEqual(norm(mustJSON(t, got)), norm(v.Fixture.Rows)) {
		t.Fatalf("rows differ from TS\n got: %.1500s\nwant: %.1500s", mustJSON(t, got), v.Fixture.Rows)
	}
	if !reflect.DeepEqual(c.graph, v.Fixture.Graph) {
		t.Fatal("legacy graph differs")
	}
	p := BuildGraphPayload(BuildGraphPayloadInput{Files: c.files, MetadataRows: c.rows.Metadata, Links: c.rows.Links, LatestRevision: 3, IndexedRevision: 3})
	b, _ := p.MarshalJSON()
	if string(b) != v.Fixture.Payload {
		t.Fatalf("payload differs\n got: %.800s\nwant: %.800s", b, v.Fixture.Payload)
	}
}
