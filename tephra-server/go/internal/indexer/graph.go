package indexer

import (
	"bytes"
	"sort"
	"strconv"
	"unicode/utf8"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// GraphNodeLimit caps the node count of a graph payload.
const GraphNodeLimit = 10_000

// Graph node kinds.
const (
	KindNote       = "note"
	KindAttachment = "attachment"
	KindTag        = "tag"
	KindUnresolved = "unresolved"
)

// GraphPayloadNode is a node of the v2 graph payload. Title nil marshals null.
type GraphPayloadNode struct {
	ID        string
	Path      string
	Title     *string
	Kind      string
	Tags      []string
	CreatedAt int64
}

// GraphPayloadEdge references nodes by array index.
type GraphPayloadEdge struct {
	S      int
	T      int
	Count  int
	Embeds int
}

// GraphPayload is the GET /vaults/:id/graph body (v2).
type GraphPayload struct {
	Revision     int64
	Truncated    bool
	IndexPending bool // emitted as "indexPending":true only when set
	Nodes        []GraphPayloadNode
	Edges        []GraphPayloadEdge
}

// BuildGraphPayloadInput is the input of BuildGraphPayload.
type BuildGraphPayloadInput struct {
	Files           []vm.CurrentVaultFile
	MetadataRows    []vm.NoteMetadata
	Links           []vm.NoteLink
	LatestRevision  int64
	IndexedRevision int64
}

// BuildGraphPayload builds the graph payload v2: markdown notes plus
// attachment and synthesized tag nodes (external and unresolved links produce
// neither nodes nor edges); edges reference nodes by array index.
func BuildGraphPayload(in BuildGraphPayloadInput) GraphPayload {
	metadata := make(map[string]*vm.NoteMetadata, len(in.MetadataRows))
	for i := range in.MetadataRows {
		metadata[in.MetadataRows[i].FileID] = &in.MetadataRows[i]
	}
	var notes, attachments []GraphPayloadNode
	for _, f := range in.Files {
		meta := metadata[f.FileID]
		seed := GraphPayloadNode{ID: f.FileID, Path: f.Path, Kind: KindAttachment, Tags: []string{}, CreatedAt: f.Mtime}
		if meta != nil {
			seed.Title = meta.Title
		}
		if f.Kind == vm.KindMarkdown {
			seed.Kind = KindNote
			if meta != nil && meta.Tags != nil {
				seed.Tags = meta.Tags
			}
			notes = append(notes, seed)
		} else {
			attachments = append(attachments, seed)
		}
	}
	byPath := func(s []GraphPayloadNode) {
		sort.SliceStable(s, func(i, j int) bool { return jstext.LocaleCompare(s[i].Path, s[j].Path) < 0 })
	}
	byPath(notes)
	byPath(attachments)

	// Tag nodes inherit the oldest tagged note's createdAt.
	tagCreated := map[string]int64{}
	for _, n := range notes {
		for _, tag := range n.Tags {
			if cur, ok := tagCreated[tag]; !ok || n.CreatedAt < cur {
				tagCreated[tag] = n.CreatedAt
			}
		}
	}
	names := make([]string, 0, len(tagCreated))
	for name := range tagCreated {
		names = append(names, name)
	}
	sort.Slice(names, func(i, j int) bool { return utf16Less(names[i], names[j]) })

	all := make([]GraphPayloadNode, 0, len(notes)+len(attachments)+len(names))
	all = append(all, notes...)
	all = append(all, attachments...)
	for _, name := range names {
		title := "#" + name
		all = append(all, GraphPayloadNode{ID: "tag:" + name, Path: name, Title: &title, Kind: KindTag, Tags: []string{}, CreatedAt: tagCreated[name]})
	}
	truncated := len(all) > GraphNodeLimit
	nodes := all
	if truncated {
		nodes = all[:GraphNodeLimit]
	}
	indexByID := make(map[string]int, len(nodes))
	for i, n := range nodes {
		indexByID[n.ID] = i
	}

	edgeIdx := map[[2]int]int{}
	edges := []GraphPayloadEdge{}
	addEdge := func(s, t int, embed bool) {
		k := [2]int{s, t}
		if i, ok := edgeIdx[k]; ok {
			edges[i].Count++
			if embed {
				edges[i].Embeds++
			}
			return
		}
		e := GraphPayloadEdge{S: s, T: t, Count: 1}
		if embed {
			e.Embeds = 1
		}
		edgeIdx[k] = len(edges)
		edges = append(edges, e)
	}
	for _, l := range in.Links {
		s, ok := indexByID[l.SourceFileID]
		if !ok || l.TargetFileID == nil {
			continue
		}
		if t, ok := indexByID[*l.TargetFileID]; ok {
			addEdge(s, t, l.IsEmbed)
		}
	}
	for _, n := range notes {
		s, ok := indexByID[n.ID]
		if !ok {
			continue
		}
		for _, tag := range n.Tags {
			if t, ok := indexByID["tag:"+tag]; ok {
				addEdge(s, t, false)
			}
		}
	}
	return GraphPayload{
		Revision:     in.LatestRevision,
		Truncated:    truncated,
		IndexPending: in.IndexedRevision < in.LatestRevision,
		Nodes:        nodes,
		Edges:        edges,
	}
}

const hexDigits = "0123456789abcdef"

// writeJSString writes s exactly as JavaScript's JSON.stringify would
// (no HTML escaping, U+2028/2029 raw, control characters as lowercase \u00xx).
func writeJSString(b *bytes.Buffer, s string) {
	b.WriteByte('"')
	for i := 0; i < len(s); {
		c := s[i]
		if c < utf8.RuneSelf {
			switch {
			case c == '"':
				b.WriteString(`\"`)
			case c == '\\':
				b.WriteString(`\\`)
			case c == '\b':
				b.WriteString(`\b`)
			case c == '\f':
				b.WriteString(`\f`)
			case c == '\n':
				b.WriteString(`\n`)
			case c == '\r':
				b.WriteString(`\r`)
			case c == '\t':
				b.WriteString(`\t`)
			case c < 0x20:
				b.WriteString(`\u00`)
				b.WriteByte(hexDigits[c>>4])
				b.WriteByte(hexDigits[c&0xf])
			default:
				b.WriteByte(c)
			}
			i++
			continue
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r == utf8.RuneError && size == 1 {
			b.WriteString("�")
		} else {
			b.WriteString(s[i : i+size])
		}
		i += size
	}
	b.WriteByte('"')
}

// MarshalJSON emits the payload with TS key order and JSON.stringify escaping,
// so the bytes (and therefore the ETag's validity) match the Node server.
func (p GraphPayload) MarshalJSON() ([]byte, error) {
	var b bytes.Buffer
	b.Grow(64 + len(p.Nodes)*128 + len(p.Edges)*32)
	b.WriteString(`{"revision":`)
	b.WriteString(strconv.FormatInt(p.Revision, 10))
	b.WriteString(`,"truncated":`)
	b.WriteString(strconv.FormatBool(p.Truncated))
	if p.IndexPending {
		b.WriteString(`,"indexPending":true`)
	}
	b.WriteString(`,"nodes":[`)
	for i, n := range p.Nodes {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"id":`)
		writeJSString(&b, n.ID)
		b.WriteString(`,"path":`)
		writeJSString(&b, n.Path)
		b.WriteString(`,"title":`)
		if n.Title == nil {
			b.WriteString("null")
		} else {
			writeJSString(&b, *n.Title)
		}
		b.WriteString(`,"kind":`)
		writeJSString(&b, n.Kind)
		b.WriteString(`,"tags":[`)
		for j, t := range n.Tags {
			if j > 0 {
				b.WriteByte(',')
			}
			writeJSString(&b, t)
		}
		b.WriteString(`],"createdAt":`)
		b.WriteString(strconv.FormatInt(n.CreatedAt, 10))
		b.WriteByte('}')
	}
	b.WriteString(`],"edges":[`)
	for i, e := range p.Edges {
		if i > 0 {
			b.WriteByte(',')
		}
		b.WriteString(`{"s":` + strconv.Itoa(e.S) + `,"t":` + strconv.Itoa(e.T) + `,"count":` + strconv.Itoa(e.Count) + `,"embeds":` + strconv.Itoa(e.Embeds) + `}`)
	}
	b.WriteString(`]}`)
	return b.Bytes(), nil
}

// GraphETag is the weak ETag of a cached graph payload.
func GraphETag(latestRevision, indexedRevision int64) string {
	return `W/"` + strconv.FormatInt(latestRevision, 10) + "-" + strconv.FormatInt(indexedRevision, 10) + `-graph-v2"`
}
