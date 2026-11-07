package api

import (
	"errors"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/indexer"
	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func init() { Register(RegisterFileRoutes) }

var forceDownloadRE = regexp.MustCompile(`(?i)^(?:text/html|application/xhtml\+xml|image/svg\+xml)(?:;|$)`)

// resolveBody is the resolve response (TS key order: match, requestedPath,
// canonicalPath, file, then extras).
type resolveBody struct {
	Match           string        `json:"match"`
	RequestedPath   string        `json:"requestedPath"`
	CanonicalPath   string        `json:"canonicalPath"`
	File            httpx.FileDTO `json:"file"`
	MovedFromPath   *string       `json:"movedFromPath,omitempty"`
	MovedAtRevision *int64        `json:"movedAtRevision,omitempty"`
}

type filesBody struct {
	Revision int64           `json:"revision"`
	Files    []httpx.FileDTO `json:"files"`
}

type searchBody struct {
	Revision int64 `json:"revision"`
	Results  []any `json:"results"`
}

type ambiguousBody struct {
	Error      protocol.ApiError `json:"error"`
	Candidates []httpx.FileDTO   `json:"candidates"`
}

func fileDTOs(files []vm.CurrentVaultFile) []httpx.FileDTO {
	out := make([]httpx.FileDTO, len(files))
	for i, f := range files {
		out[i] = httpx.NewFileDTO(f)
	}
	return out
}

// RegisterFileRoutes registers files, tree, search, resolve, file, raw
// content, rendered, links and backlinks.
func RegisterFileRoutes(mux *http.ServeMux, d Dependencies) {
	const base = "GET /api/v1/vaults/{vaultId}/"

	listFiles := httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return err
		}
		files, err := d.Database.VaultFiles().ListByVault(r.Context(), vault.ID)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, filesBody{vault.LatestRevision, fileDTOs(files)})
		return nil
	})
	mux.Handle(base+"files", listFiles)
	mux.Handle(base+"tree", listFiles)

	mux.Handle(base+"search", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return err
		}
		q := r.URL.Query()
		query := jstext.Trim(q.Get("q"))
		if n := httpx.UTF16Len(query); !q.Has("q") || n < 1 || n > 200 {
			return httpx.Validation("Invalid search query.")
		}
		limit := 50.0
		if q.Has("limit") {
			if n, ok := jsNumber(q.Get("limit")); ok && n != 0 {
				limit = n
			}
		}
		limit = math.Min(limit, 100)
		results, err := httpx.SearchVault(r.Context(), d, vault.ID, query, int(limit))
		if err != nil {
			return err
		}
		if results == nil {
			results = []any{}
		}
		httpx.WriteJSON(w, http.StatusOK, searchBody{vault.LatestRevision, results})
		return nil
	}))

	findFile := func(r *http.Request) (*vm.CurrentVaultFile, error) {
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return nil, err
		}
		file, err := d.Database.VaultFiles().FindByID(r.Context(), vault.ID, r.PathValue("fileId"))
		if err != nil {
			return nil, err
		}
		if file == nil {
			return nil, httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "File was not found.")
		}
		return file, nil
	}

	mux.Handle(base+"resolve", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return err
		}
		ctx := r.Context()
		requested := r.URL.Query().Get("path")
		if requested == "" {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidPath, "A path query parameter is required.")
		}
		normalized := jstext.NFC(requested)
		if !protocol.IsCanonicalVaultPath(normalized) {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidPath, "Path must be a canonical vault-relative path.")
		}
		lf := httpx.LogFields(r)
		respond := func(match string, file vm.CurrentVaultFile, extra func(*resolveBody)) error {
			lf.Set("path_resolved", true)
			lf.Set("resolve_match", match)
			body := resolveBody{Match: match, RequestedPath: requested, CanonicalPath: file.Path, File: httpx.NewFileDTO(file)}
			if extra != nil {
				extra(&body)
			}
			httpx.WriteJSON(w, http.StatusOK, body)
			return nil
		}
		files := d.Database.VaultFiles()
		if requested != normalized {
			exact, err := files.FindByPath(ctx, vault.ID, requested)
			if err != nil {
				return err
			}
			if exact != nil {
				return respond("exact", *exact, nil)
			}
		}
		current, err := files.FindByPath(ctx, vault.ID, normalized)
		if err != nil {
			return err
		}
		if current != nil {
			match := "normalized"
			if requested == normalized {
				match = "exact"
			}
			return respond(match, *current, nil)
		}
		folded, err := files.FindByPathFold(ctx, vault.ID, jstext.Lower(normalized))
		if err != nil {
			return err
		}
		if len(folded) == 1 {
			return respond("case", folded[0], nil)
		}
		if len(folded) > 1 {
			lf.Set("path_resolved", true)
			lf.Set("resolve_match", "ambiguous")
			httpx.WriteJSON(w, http.StatusConflict, ambiguousBody{
				Error:      protocol.ApiError{Code: protocol.CodeAmbiguousPath, Message: "Multiple files match this path."},
				Candidates: fileDTOs(folded),
			})
			return nil
		}
		historic, err := d.Database.FileVersions().FindLatestByPath(ctx, vault.ID, normalized)
		if err != nil {
			return err
		}
		if historic != nil {
			file, err := files.FindByID(ctx, vault.ID, historic.FileID)
			if err != nil {
				return err
			}
			if file != nil {
				if file.Path == normalized {
					return respond("exact", *file, nil)
				}
				return respond("historic", *file, func(b *resolveBody) {
					b.MovedFromPath = strPtr(historic.Path)
					rev := historic.Revision
					b.MovedAtRevision = &rev
				})
			}
			lf.Set("path_resolved", true)
			lf.Set("resolve_match", "deleted")
			httpx.WriteJSON(w, http.StatusGone, protocol.ApiErrorResponse{Error: protocol.ApiError{Code: protocol.CodeFileDeleted, Message: "File was deleted."}})
			return nil
		}
		return httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "File was not found.")
	}))

	mux.Handle(base+"files/{fileId}", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		file, err := findFile(r)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"file": httpx.NewFileDTO(*file)})
		return nil
	}))

	rawContent := httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		file, err := findFile(r)
		if err != nil {
			return err
		}
		blob, err := d.BlobStore.Get(r.Context(), file.BlobHash)
		if errors.Is(err, blobstore.ErrNotFound) {
			return httpx.Fail(http.StatusNotFound, protocol.CodeBlobMissing, "File content is missing.")
		}
		if err != nil {
			return err
		}
		defer blob.Body.Close()
		contentType := "application/octet-stream"
		if file.MimeType != nil {
			contentType = *file.MimeType
		} else if file.Kind == vm.KindMarkdown {
			contentType = "text/markdown; charset=utf-8"
		}
		h := w.Header()
		h.Set("Content-Type", contentType)
		h.Set("Content-Length", strconv.FormatInt(blob.Size, 10))
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("Content-Security-Policy", "sandbox")
		if forceDownloadRE.MatchString(contentType) {
			name := file.Path[strings.LastIndex(file.Path, "/")+1:]
			h.Set("Content-Disposition", `attachment; filename="`+indexer.EncodeURIComponent(name)+`"`)
		}
		w.WriteHeader(http.StatusOK)
		if r.Method != http.MethodHead {
			_, _ = io.Copy(w, blob.Body)
		}
		return nil
	})
	mux.Handle(base+"files/{fileId}/content", rawContent)
	mux.Handle(base+"files/{fileId}/raw", rawContent)
	mux.Handle(base+"attachments/{fileId}", rawContent)

	mux.Handle(base+"files/{fileId}/rendered", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		file, err := findFile(r)
		if err != nil {
			return err
		}
		if file.Kind != vm.KindMarkdown {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Only Markdown files can be rendered.")
		}
		renderer := d.Renderer()
		if renderer == nil {
			return httpx.Fail(http.StatusServiceUnavailable, protocol.CodeIndexPending, "Markdown rendering is not available.")
		}
		blob, err := d.BlobStore.Get(r.Context(), file.BlobHash)
		if errors.Is(err, blobstore.ErrNotFound) {
			return httpx.Fail(http.StatusNotFound, protocol.CodeBlobMissing, "File content is missing.")
		}
		if err != nil {
			return err
		}
		data, err := io.ReadAll(blob.Body)
		blob.Body.Close()
		if err != nil {
			return err
		}
		out, err := renderer.RenderMarkdown(r.Context(), httpx.RenderMarkdownInput{VaultID: file.VaultID, FileID: file.FileID, Markdown: indexer.DecodeUTF8(data)})
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, out)
		return nil
	}))

	mux.Handle(base+"files/{fileId}/links", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		file, err := findFile(r)
		if err != nil {
			return err
		}
		links, err := d.Database.NoteIndex().ListLinksBySource(r.Context(), file.VaultID, file.FileID)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"links": links})
		return nil
	}))
	mux.Handle(base+"files/{fileId}/backlinks", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		file, err := findFile(r)
		if err != nil {
			return err
		}
		links, err := d.Database.NoteIndex().ListLinksByTarget(r.Context(), file.VaultID, file.FileID)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"links": links})
		return nil
	}))
	mux.Handle(base+"links", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return err
		}
		links, err := d.Database.NoteIndex().ListLinks(r.Context(), vault.ID)
		if err != nil {
			return err
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]any{"links": links})
		return nil
	}))
}
