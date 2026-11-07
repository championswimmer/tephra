package indexer

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"strings"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/core"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/linkresolver"
	"github.com/championswimmer/tephra/tephra-server/go/internal/markdown"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// Optional capabilities of the TS IndexService (each method is optional there).
type (
	VaultIndexer interface {
		IndexVault(ctx context.Context, vaultID string, revision int64) error
	}
	RenderMarkdownInput struct {
		VaultID  string
		FileID   string
		Markdown string
	}
	MarkdownRenderer interface {
		RenderMarkdown(ctx context.Context, in RenderMarkdownInput) (any, error)
	}
	SearchInput struct {
		VaultID string
		Query   string
		Limit   int
	}
	NoteSearcher interface {
		Search(ctx context.Context, in SearchInput) ([]any, error)
	}
)

// IndexService is the full TS IndexService (all three methods present).
type IndexService interface {
	VaultIndexer
	MarkdownRenderer
	NoteSearcher
}

// SearchResult is one search hit: the current file plus its indexed title.
type SearchResult struct {
	vm.CurrentVaultFile
	Title *string `json:"title"`
}

// MarshalJSON emits the keys in Node's order (mimeType after updatedRevision).
func (r SearchResult) MarshalJSON() ([]byte, error) {
	f := r.CurrentVaultFile
	var b bytes.Buffer
	enc := json.NewEncoder(&b)
	enc.SetEscapeHTML(false)
	err := enc.Encode(struct {
		FileID          string           `json:"fileId"`
		VaultID         string           `json:"vaultId"`
		Path            string           `json:"path"`
		BlobHash        string           `json:"blobHash"`
		Size            int64            `json:"size"`
		Mtime           int64            `json:"mtime"`
		Kind            vm.VaultFileKind `json:"kind"`
		UpdatedRevision int64            `json:"updatedRevision"`
		MimeType        *string          `json:"mimeType,omitempty"`
		Title           *string          `json:"title"`
	}{f.FileID, f.VaultID, f.Path, f.BlobHash, f.Size, f.Mtime, f.Kind, f.UpdatedRevision, f.MimeType, r.Title})
	return bytes.TrimSuffix(b.Bytes(), []byte("\n")), err
}

// RuntimeDeps are the dependencies of the runtime index service.
type RuntimeDeps struct {
	Database  db.Database
	BlobStore blobstore.Store
	Clock     core.Clock
	IDs       core.IdGenerator
}

type runtimeIndex struct{ d RuntimeDeps }

// NewRuntimeIndexService ports createRuntimeIndexService.
func NewRuntimeIndexService(deps RuntimeDeps) IndexService { return &runtimeIndex{d: deps} }

// refreshGraphCache rebuilds the materialized graph row for the revision that
// just committed. Failures never fail the index: the row is deleted and the
// next graph request rebuilds on a cache miss.
func (r *runtimeIndex) refreshGraphCache(ctx context.Context, vaultID string, indexedRevision int64) {
	err := func() error {
		vault, err := r.d.Database.Vaults().FindByID(ctx, vaultID)
		if err != nil || vault == nil {
			return err
		}
		files, err := r.d.Database.VaultFiles().ListByVault(ctx, vaultID)
		if err != nil {
			return err
		}
		meta, err := r.d.Database.NoteIndex().ListMetadata(ctx, vaultID)
		if err != nil {
			return err
		}
		links, err := r.d.Database.NoteIndex().ListLinks(ctx, vaultID)
		if err != nil {
			return err
		}
		payload, err := BuildGraphPayload(BuildGraphPayloadInput{
			Files: files, MetadataRows: meta, Links: links,
			LatestRevision: vault.LatestRevision, IndexedRevision: indexedRevision,
		}).MarshalJSON()
		if err != nil {
			return err
		}
		return r.d.Database.GraphCache().Upsert(ctx, db.GraphCacheEntry{
			VaultID:         vaultID,
			Revision:        vault.LatestRevision,
			IndexedRevision: indexedRevision,
			ETag:            GraphETag(vault.LatestRevision, indexedRevision),
			PayloadJSON:     string(payload),
			UpdatedAt:       r.d.Clock.Now(),
		})
	}()
	if err != nil {
		_ = r.d.Database.GraphCache().DeleteByVault(context.WithoutCancel(ctx), vaultID)
	}
}

// decodeUTF8 mimics TextDecoder/Response.text(): strips one leading BOM and
// replaces each maximal invalid subpart with a single U+FFFD.
func decodeUTF8(b []byte) string {
	b = bytes.TrimPrefix(b, []byte{0xEF, 0xBB, 0xBF})
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	sb.Grow(len(b))
	for i := 0; i < len(b); {
		if r, size := utf8.DecodeRune(b[i:]); r != utf8.RuneError || size != 1 {
			sb.Write(b[i : i+size])
			i += size
			continue
		}
		sb.WriteString("�")
		i += invalidSubpartLen(b[i:])
	}
	return sb.String()
}

// invalidSubpartLen is the length of the maximal subpart of an ill-formed
// sequence starting at b[0] (WHATWG UTF-8 decoder behaviour).
func invalidSubpartLen(b []byte) int {
	lo, hi := byte(0x80), byte(0xBF)
	var need int
	switch c := b[0]; {
	case c >= 0xC2 && c <= 0xDF:
		need = 1
	case c >= 0xE0 && c <= 0xEF:
		need = 2
		if c == 0xE0 {
			lo = 0xA0
		} else if c == 0xED {
			hi = 0x9F
		}
	case c >= 0xF0 && c <= 0xF4:
		need = 3
		if c == 0xF0 {
			lo = 0x90
		} else if c == 0xF4 {
			hi = 0x8F
		}
	default:
		return 1
	}
	n := 1
	for ; need > 0 && n < len(b); need-- {
		if b[n] < lo || b[n] > hi {
			break
		}
		lo, hi = 0x80, 0xBF
		n++
	}
	return n
}

func (r *runtimeIndex) readMarkdown(ctx context.Context, hash string) (string, error) {
	blob, err := r.d.BlobStore.Get(ctx, hash)
	if errors.Is(err, blobstore.ErrNotFound) {
		return "", fmt.Errorf("Missing Markdown blob %s", hash)
	}
	if err != nil {
		return "", err
	}
	defer blob.Body.Close()
	data, err := io.ReadAll(blob.Body)
	if err != nil {
		return "", err
	}
	return decodeUTF8(data), nil
}

func (r *runtimeIndex) IndexVault(ctx context.Context, vaultID string, revision int64) error {
	err := r.indexVault(ctx, vaultID, revision)
	if err == nil {
		return nil
	}
	// Never serve a graph built from a superseded or failed index revision.
	clean := context.WithoutCancel(ctx)
	_ = r.d.Database.GraphCache().DeleteByVault(clean, vaultID)
	msg := err.Error()
	if u := utf16.Encode([]rune(msg)); len(u) > 1000 {
		msg = string(utf16.Decode(u[:1000]))
	}
	prev := revision - 1
	if prev < 0 {
		prev = 0
	}
	if serr := r.d.Database.NoteIndex().SetState(clean, vm.VaultIndexState{VaultID: vaultID, IndexedRevision: prev, LastError: &msg}); serr != nil {
		return serr
	}
	return err
}

func (r *runtimeIndex) indexVault(ctx context.Context, vaultID string, revision int64) error {
	files, err := r.d.Database.VaultFiles().ListByVault(ctx, vaultID)
	if err != nil {
		return err
	}
	// Parse note by note and keep only the derived rows, not the parsed AST
	// or the raw text, so peak memory is one note plus the rows.
	index := linkresolver.CreateVaultPathIndex(pathEntries(files))
	indexedAt := r.d.Clock.Now()
	currentMarkdown := map[string]bool{}
	var metadata []vm.NoteMetadata
	linksBySource := map[string][]vm.NoteLink{}
	for _, file := range files {
		if file.Kind != vm.KindMarkdown {
			continue
		}
		currentMarkdown[file.FileID] = true
		text, err := r.readMarkdown(ctx, file.BlobHash)
		if err != nil {
			return err
		}
		rows := BuildNoteRows(vaultID, file, markdown.ParseNote(text), index, indexedAt, r.d.IDs.Generate)
		metadata = append(metadata, rows.Metadata)
		linksBySource[file.FileID] = rows.Links
	}
	err = r.d.Database.Transaction(ctx, func(tx db.TransactionRepositories) error {
		ni := tx.NoteIndex()
		existing, err := ni.ListMetadata(ctx, vaultID)
		if err != nil {
			return err
		}
		for _, m := range existing {
			if !currentMarkdown[m.FileID] {
				if err := ni.DeleteMetadata(ctx, m.FileID); err != nil {
					return err
				}
			}
		}
		for _, m := range metadata {
			if err := ni.UpsertMetadata(ctx, m); err != nil {
				return err
			}
			links := linksBySource[m.FileID]
			if links == nil {
				links = []vm.NoteLink{}
			}
			if err := ni.ReplaceLinksForSource(ctx, vaultID, m.FileID, links); err != nil {
				return err
			}
		}
		return ni.SetState(ctx, vm.VaultIndexState{VaultID: vaultID, IndexedRevision: revision})
	})
	if err != nil {
		return err
	}
	r.refreshGraphCache(ctx, vaultID, revision)
	return nil
}

func (r *runtimeIndex) RenderMarkdown(ctx context.Context, in RenderMarkdownInput) (any, error) {
	files, err := r.d.Database.VaultFiles().ListByVault(ctx, in.VaultID)
	if err != nil {
		return nil, err
	}
	var source *vm.CurrentVaultFile
	for i := range files {
		if files[i].FileID == in.FileID {
			source = &files[i]
			break
		}
	}
	if source == nil {
		return nil, errors.New("Markdown source file is not current")
	}
	vaultIndex := linkresolver.CreateVaultPathIndex(pathEntries(files))
	return markdown.RenderMarkdown(markdown.RenderOptions{
		Markdown:   in.Markdown,
		SourcePath: source.Path,
		VaultIndex: vaultIndex,
		ResolveLink: func(sourcePath, linkPath string) markdown.RenderTarget {
			res := linkresolver.ResolveLink(sourcePath, linkPath, vaultIndex)
			return markdown.RenderTarget{TargetFileID: res.TargetFileID, TargetPath: res.TargetPath, Unresolved: res.Unresolved, Ambiguous: res.Ambiguous, TargetKind: res.TargetKind}
		},
		AttachmentURL: func(targetFileID string) string {
			return "/api/v1/vaults/" + encodeURIComponent(in.VaultID) + "/attachments/" + encodeURIComponent(targetFileID)
		},
	})
}

// encodeURIComponent matches JS: unreserved set A-Za-z0-9 - _ . ! ~ * ' ( ).
func encodeURIComponent(s string) string {
	return strings.NewReplacer("+", "%20", "%21", "!", "%27", "'", "%28", "(", "%29", ")", "%2A", "*", "%7E", "~").Replace(url.QueryEscape(strings.ToValidUTF8(s, "�")))
}

func (r *runtimeIndex) Search(ctx context.Context, in SearchInput) ([]any, error) {
	q := jstext.Lower(jstext.Trim(in.Query))
	if q == "" {
		return []any{}, nil
	}
	files, err := r.d.Database.VaultFiles().ListByVault(ctx, in.VaultID)
	if err != nil {
		return nil, err
	}
	rows, err := r.d.Database.NoteIndex().ListMetadata(ctx, in.VaultID)
	if err != nil {
		return nil, err
	}
	titles := make(map[string]*string, len(rows))
	for _, m := range rows {
		titles[m.FileID] = m.Title
	}
	out := []any{}
	for _, f := range files {
		t := titles[f.FileID]
		if strings.Contains(jstext.Lower(f.Path), q) || (t != nil && strings.Contains(jstext.Lower(*t), q)) {
			out = append(out, SearchResult{CurrentVaultFile: f, Title: t})
		}
	}
	if in.Limit >= 0 && len(out) > in.Limit {
		out = out[:in.Limit]
	}
	return out, nil
}
