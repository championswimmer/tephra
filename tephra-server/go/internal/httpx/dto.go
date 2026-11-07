package httpx

import (
	"context"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// FileDTO is the public file shape (dto.ts fileDto).
type FileDTO struct {
	FileID   string           `json:"fileId"`
	Path     string           `json:"path"`
	BlobHash string           `json:"blobHash"`
	Size     int64            `json:"size"`
	Mtime    int64            `json:"mtime"`
	MimeType *string          `json:"mimeType,omitempty"`
	Kind     vm.VaultFileKind `json:"kind"`
}

// NewFileDTO converts a current vault file.
func NewFileDTO(f vm.CurrentVaultFile) FileDTO {
	return FileDTO{FileID: f.FileID, Path: f.Path, BlobHash: f.BlobHash, Size: f.Size, Mtime: f.Mtime, MimeType: f.MimeType, Kind: f.Kind}
}

// SearchVault is the shared note search used by REST search and MCP search_notes.
func SearchVault(ctx context.Context, d Dependencies, vaultID, query string, limit int) ([]any, error) {
	if s := d.Searcher(); s != nil {
		return s.Search(ctx, SearchInput{VaultID: vaultID, Query: query, Limit: limit})
	}
	needle := jstext.Lower(query)
	files, err := d.Database.VaultFiles().ListByVault(ctx, vaultID)
	if err != nil {
		return nil, err
	}
	out := []any{}
	for _, f := range files {
		if len(out) >= limit {
			break
		}
		if strings.Contains(jstext.Lower(f.Path), needle) {
			out = append(out, NewFileDTO(f))
		}
	}
	return out, nil
}
