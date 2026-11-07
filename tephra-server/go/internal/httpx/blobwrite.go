package httpx

import (
	"context"
	"io"
	"net/http"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

// StoreBlobIfAbsent is the shared blob-store-and-record path: the store hashes
// the received bytes itself (never trusting a client digest). Errors from the
// store (blobstore.ErrHashMismatch, ErrSizeMismatch, ...) are returned as-is
// for the caller to map. Returns stored=false when the blob already existed.
func StoreBlobIfAbsent(ctx context.Context, d Dependencies, hash string, body io.Reader, size int64, mimeType string) (stored bool, err error) {
	existing, err := d.Database.Blobs().FindByHash(ctx, hash)
	if err != nil {
		return false, err
	}
	if existing != nil {
		has, err := d.BlobStore.Has(ctx, hash)
		if err != nil {
			return false, err
		}
		if existing.Size != size || !has {
			return false, Fail(http.StatusConflict, protocol.CodeCommitFailed, "Stored blob metadata is inconsistent.")
		}
		return false, nil
	}
	if err := d.BlobStore.Put(ctx, blobstore.PutInput{Hash: hash, Body: body, Size: size, MimeType: mimeType}); err != nil {
		return false, err
	}
	var mt *string
	if mimeType != "" {
		mt = &mimeType
	}
	if err := d.Database.Blobs().Insert(ctx, vm.BlobMetadata{Hash: hash, Size: size, MimeType: mt, CreatedAt: d.Clock.Now()}); err != nil {
		// A concurrent upload of identical content may have registered the
		// blob between the lookup above and this insert; the bytes were
		// verified against the hash, so that is success, not a failure.
		if raced, ferr := d.Database.Blobs().FindByHash(ctx, hash); ferr == nil && raced != nil && raced.Size == size {
			return false, nil
		}
		return false, err
	}
	return true, nil
}
