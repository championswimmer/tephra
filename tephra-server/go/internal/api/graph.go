package api

import (
	"net/http"
	"strconv"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/indexer"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func init() { Register(RegisterGraphRoutes) }

// writeRawJSON writes an already-serialised JSON document.
func writeRawJSON(w http.ResponseWriter, status int, payload []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

// RegisterGraphRoutes registers GET /vaults/{vaultId}/graph (payload v2 with a
// weak ETag keyed by vault revision + index revision).
func RegisterGraphRoutes(mux *http.ServeMux, d Dependencies) {
	mux.Handle("GET /api/v1/vaults/{vaultId}/graph", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultReadMetadata)
		if err != nil {
			return err
		}
		ctx := r.Context()
		state, err := d.Database.NoteIndex().GetState(ctx, vault.ID)
		if err != nil {
			return err
		}
		var indexed int64
		if state != nil {
			indexed = state.IndexedRevision
		}
		etag := `W/"` + strconv.FormatInt(vault.LatestRevision, 10) + "-" + strconv.FormatInt(indexed, 10) + `-graph-v3"`
		w.Header().Set("ETag", etag)
		if r.Header.Get("If-None-Match") == etag {
			w.WriteHeader(http.StatusNotModified)
			return nil
		}
		cached, err := d.Database.GraphCache().Find(ctx, vault.ID)
		if err != nil {
			return err
		}
		if cached != nil && cached.ETag == etag && cached.Revision == vault.LatestRevision && cached.IndexedRevision == indexed {
			writeRawJSON(w, http.StatusOK, []byte(cached.PayloadJSON))
			return nil
		}
		nodes := d.Database.NoteIndex()
		files, err := d.Database.VaultFiles().ListByVault(ctx, vault.ID)
		if err != nil {
			return err
		}
		metadata, err := nodes.ListMetadata(ctx, vault.ID)
		if err != nil {
			return err
		}
		links, err := nodes.ListLinks(ctx, vault.ID)
		if err != nil {
			return err
		}
		payload, err := indexer.BuildGraphPayload(indexer.BuildGraphPayloadInput{Files: files, MetadataRows: metadata, Links: links,
			LatestRevision: vault.LatestRevision, IndexedRevision: indexed}).MarshalJSON()
		if err != nil {
			return err
		}
		if err := d.Database.GraphCache().Upsert(ctx, db.GraphCacheEntry{VaultID: vault.ID, Revision: vault.LatestRevision,
			IndexedRevision: indexed, ETag: etag, PayloadJSON: string(payload), UpdatedAt: d.Clock.Now()}); err != nil {
			return err
		}
		writeRawJSON(w, http.StatusOK, payload)
		return nil
	}))
}
