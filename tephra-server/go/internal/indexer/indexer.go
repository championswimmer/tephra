// Package indexer ports packages/indexer (note index rows, graph payload) and
// apps/api/src/runtime-index.ts (the runtime IndexService). It is the only
// place that turns parsed Markdown plus the current vault snapshot into
// replaceable derived rows (note_metadata / note_links).
package indexer

import (
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/linkresolver"
	"github.com/championswimmer/tephra/tephra-server/go/internal/markdown"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// ParsedVaultNote pairs a file id with its parsed Markdown.
type ParsedVaultNote struct {
	FileID string
	Parsed markdown.ParsedNote
}

// IndexRows are the replaceable derived rows of an index build.
type IndexRows struct {
	Metadata               []vm.NoteMetadata
	Links                  []vm.NoteLink
	ReindexedSourceFileIDs []string
}

// GraphNode / GraphEdge / NoteGraph are the legacy (buildGraph) graph shape.
type GraphNode struct {
	ID    string `json:"id"`
	Path  string `json:"path"`
	Title string `json:"title"`
}

type GraphEdge struct {
	Source     string `json:"source"`
	Target     string `json:"target"`
	Count      int    `json:"count"`
	EmbedCount int    `json:"embedCount"`
}

type NoteGraph struct {
	Nodes []GraphNode `json:"nodes"`
	Edges []GraphEdge `json:"edges"`
}

func pathEntries(files []vm.CurrentVaultFile) []linkresolver.VaultPathEntry {
	out := make([]linkresolver.VaultPathEntry, len(files))
	for i, f := range files {
		out[i] = linkresolver.VaultPathEntry{FileID: f.FileID, Path: f.Path, Kind: string(f.Kind)}
	}
	return out
}

var mdSuffix = regexp.MustCompile(`(?i)\.md$`)

func baseTitle(path string) string {
	last := path
	if i := strings.LastIndex(path, "/"); i >= 0 {
		last = path[i+1:]
	}
	return mdSuffix.ReplaceAllString(last, "")
}

func titleFor(file vm.CurrentVaultFile, parsed markdown.ParsedNote) *string {
	if v, ok := parsed.Frontmatter.Get("title"); ok {
		if s, isStr := v.(string); isStr && jstext.Trim(s) != "" {
			t := jstext.Trim(s)
			return &t
		}
	}
	if len(parsed.Headings) > 0 && parsed.Headings[0].Text != "" {
		t := parsed.Headings[0].Text
		return &t
	}
	t := baseTitle(file.Path)
	return &t
}

// Matches /^[a-z][a-z\d+.-]*:/i.
var schemeRe = regexp.MustCompile(`(?i)^[a-z][a-z\d+.-]*:`)

// NoteRows is the derived rows for one note.
type NoteRows struct {
	Metadata vm.NoteMetadata
	Links    []vm.NoteLink
}

// BuildNoteRows builds the rows for one Markdown file against a prepared path
// index. generateID is called once per link, in link order.
func BuildNoteRows(vaultID string, file vm.CurrentVaultFile, parsed markdown.ParsedNote, index *linkresolver.VaultPathIndex, indexedAt int64, generateID func() string) NoteRows {
	headings := make([]any, len(parsed.Headings))
	for i, h := range parsed.Headings {
		headings[i] = h
	}
	blocks := make([]any, len(parsed.Blocks))
	for i, b := range parsed.Blocks {
		blocks[i] = b
	}
	tags := parsed.Tags
	if tags == nil {
		tags = []string{}
	}
	rows := NoteRows{Metadata: vm.NoteMetadata{
		FileID:          file.FileID,
		VaultID:         vaultID,
		IndexedBlobHash: file.BlobHash,
		Title:           titleFor(file, parsed),
		Frontmatter:     parsed.Frontmatter.Map(),
		Headings:        headings,
		Tags:            tags,
		Blocks:          blocks,
		IndexedAt:       indexedAt,
	}}
	for _, link := range parsed.Links {
		raw := link.LinkPath
		if link.Subpath != nil && *link.Subpath != "" {
			raw += "#" + *link.Subpath
		}
		resolution := linkresolver.ResolveLink(file.Path, raw, index)
		// External Markdown URLs are metadata, but never graph-resolvable vault links.
		external := link.Syntax == markdown.SyntaxMarkdown && (schemeRe.MatchString(link.LinkPath) || strings.HasPrefix(link.LinkPath, "//"))
		row := vm.NoteLink{
			ID:           generateID(),
			VaultID:      vaultID,
			SourceFileID: file.FileID,
			RawText:      link.Raw,
			LinkPath:     link.LinkPath,
			Subpath:      link.Subpath,
			DisplayText:  link.DisplayText,
			IsEmbed:      link.IsEmbed,
			CreatedAt:    indexedAt,
		}
		if !external && resolution.TargetFileID != "" {
			id := resolution.TargetFileID
			row.TargetFileID = &id
		}
		rows.Links = append(rows.Links, row)
	}
	return rows
}

// BuildIndexInput is the input of BuildIndexRows.
type BuildIndexInput struct {
	VaultID    string
	Files      []vm.CurrentVaultFile
	Notes      []ParsedVaultNote
	IndexedAt  int64
	GenerateID func() string
}

// BuildIndexRows builds replaceable derived rows from a complete current-vault
// snapshot. All links are resolved again so a newly created/renamed/deleted
// target cannot leave stale target_file_id values behind.
func BuildIndexRows(in BuildIndexInput) IndexRows {
	filesByID := make(map[string]vm.CurrentVaultFile, len(in.Files))
	for _, f := range in.Files {
		filesByID[f.FileID] = f
	}
	index := linkresolver.CreateVaultPathIndex(pathEntries(in.Files))
	out := IndexRows{Metadata: []vm.NoteMetadata{}, Links: []vm.NoteLink{}, ReindexedSourceFileIDs: []string{}}
	for _, note := range in.Notes {
		file, ok := filesByID[note.FileID]
		if !ok || file.Kind != vm.KindMarkdown {
			continue
		}
		out.ReindexedSourceFileIDs = append(out.ReindexedSourceFileIDs, file.FileID)
		rows := BuildNoteRows(in.VaultID, file, note.Parsed, index, in.IndexedAt, in.GenerateID)
		out.Metadata = append(out.Metadata, rows.Metadata)
		out.Links = append(out.Links, rows.Links...)
	}
	return out
}

// BuildGraphInput is the input of BuildGraph.
type BuildGraphInput struct {
	Files    []vm.CurrentVaultFile
	Metadata []vm.NoteMetadata
	Links    []vm.NoteLink
}

// BuildGraph builds the legacy Markdown-only graph.
func BuildGraph(in BuildGraphInput) NoteGraph {
	markdownIDs := map[string]bool{}
	for _, f := range in.Files {
		if f.Kind == vm.KindMarkdown {
			markdownIDs[f.FileID] = true
		}
	}
	titles := map[string]*string{}
	for _, m := range in.Metadata {
		titles[m.FileID] = m.Title
	}
	nodes := []GraphNode{}
	for _, f := range in.Files {
		if f.Kind != vm.KindMarkdown {
			continue
		}
		title := baseTitle(f.Path)
		if t := titles[f.FileID]; t != nil {
			title = *t
		}
		nodes = append(nodes, GraphNode{ID: f.FileID, Path: f.Path, Title: title})
	}
	sort.SliceStable(nodes, func(i, j int) bool { return jstext.LocaleCompare(nodes[i].Path, nodes[j].Path) < 0 })

	type key struct{ s, t string }
	agg := map[key]*GraphEdge{}
	var order []*GraphEdge
	for _, l := range in.Links {
		if l.TargetFileID == nil || !markdownIDs[l.SourceFileID] || !markdownIDs[*l.TargetFileID] {
			continue
		}
		k := key{l.SourceFileID, *l.TargetFileID}
		if e, ok := agg[k]; ok {
			e.Count++
			if l.IsEmbed {
				e.EmbedCount++
			}
		} else {
			e := &GraphEdge{Source: k.s, Target: k.t, Count: 1}
			if l.IsEmbed {
				e.EmbedCount = 1
			}
			agg[k] = e
			order = append(order, e)
		}
	}
	edges := make([]GraphEdge, len(order))
	for i, e := range order {
		edges[i] = *e
	}
	sort.SliceStable(edges, func(i, j int) bool {
		if c := jstext.LocaleCompare(edges[i].Source, edges[j].Source); c != 0 {
			return c < 0
		}
		return jstext.LocaleCompare(edges[i].Target, edges[j].Target) < 0
	})
	return NoteGraph{Nodes: nodes, Edges: edges}
}

// utf16Less orders strings by UTF-16 code units, as the default JS sort does.
func utf16Less(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}
