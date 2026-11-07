package api

import (
	"context"
	"io"
	"net/http"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func init() { Register(RegisterSyncRoutes) }

func parsePlanBody(r *http.Request) (protocol.SyncBody, error) {
	data, err := httpx.ReadJSONBytes(r)
	if err != nil {
		return protocol.SyncBody{}, err
	}
	if _, err := httpx.ParseJSON(data); err != nil {
		return protocol.SyncBody{}, err
	}
	return protocol.ParseSyncPlanBody(data)
}

// kickIndex starts indexing in the background (TS: `void indexVault().catch`).
func kickIndex(d Dependencies, vaultID string, revision int64) {
	if idx := d.Indexer(); idx != nil {
		go func() {
			// A crashing indexer must never take the API down (Node swallows it with .catch).
			defer func() { _ = recover() }()
			_ = idx.IndexVault(context.Background(), vaultID, revision)
		}()
	}
}

// RegisterSyncRoutes registers sync/plan, PUT blobs/{hash} and sync/commit.
func RegisterSyncRoutes(mux *http.ServeMux, d Dependencies) {
	mux.Handle("POST /api/v1/vaults/{vaultId}/sync/plan", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		body, err := parsePlanBody(r)
		if err != nil {
			return err
		}
		lf := httpx.LogFields(r)
		lf.Set("device_id", body.DeviceID)
		lf.Set("manifest_hash", body.ManifestHash)
		lf.Set("changed_file_count", len(body.Files))
		if err := verifyManifest(body.Files, body.ManifestHash); err != nil {
			return err
		}
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultUpload)
		if err != nil {
			return err
		}
		ctx := r.Context()
		lf.Set("vault_id", vault.ID)
		pv, mv := syncProtocolFields()
		existing, err := d.Database.VaultRevisions().FindByManifestHash(ctx, vault.ID, body.ManifestHash)
		if err != nil {
			return err
		}
		if existing != nil {
			lf.Set("revision", existing.Revision)
			httpx.WriteJSON(w, http.StatusOK, protocol.SyncPlanResponse{Status: "up-to-date", LatestRevision: existing.Revision,
				MissingBlobs: []protocol.MissingBlob{}, ProtocolVersion: pv, MinimumPluginVersion: mv})
			return nil
		}
		hashes := make([]string, len(body.Files))
		for i, f := range body.Files {
			hashes[i] = f.Hash
		}
		found, err := d.Database.Blobs().FindByHashes(ctx, hashes)
		if err != nil {
			return err
		}
		meta := map[string]int64{}
		for _, b := range found {
			meta[b.Hash] = b.Size
		}
		missing := []protocol.MissingBlob{}
		for _, f := range uniqueByHash(body.Files) {
			size, ok := meta[f.Hash]
			has := false
			if ok && size == f.Size {
				if has, err = d.BlobStore.Has(ctx, f.Hash); err != nil {
					return err
				}
			}
			if !ok || size != f.Size || !has {
				missing = append(missing, protocol.MissingBlob{Hash: f.Hash, Size: f.Size})
			}
		}
		lf.Set("revision", vault.LatestRevision)
		httpx.WriteJSON(w, http.StatusOK, protocol.SyncPlanResponse{Status: "upload-required", LatestRevision: vault.LatestRevision,
			MissingBlobs: missing, ProtocolVersion: pv, MinimumPluginVersion: mv})
		return nil
	}))

	mux.Handle("PUT /api/v1/vaults/{vaultId}/blobs/{hash}", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultUpload)
		if err != nil {
			return err
		}
		lf := httpx.LogFields(r)
		lf.Set("vault_id", vault.ID)
		hash := r.PathValue("hash")
		if !protocol.IsSHA256Hex(hash) {
			return httpx.Validation("Invalid SHA-256 hash.")
		}
		limitBytes := d.BlobLimit()
		declared, ok := declaredSize(r, "X-Tephra-Blob-Size")
		if !ok || declared < 0 {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "A valid blob size is required.")
		}
		if declared > limitBytes {
			return httpx.Fail(http.StatusRequestEntityTooLarge, protocol.CodeBlobTooLarge, "Blob exceeds the configured size limit.")
		}
		body := io.Reader(http.NoBody)
		if r.Body != nil {
			body = r.Body
		}
		vr := newVerifyReader(body, declared)
		stored, err := httpx.StoreBlobIfAbsent(r.Context(), d, hash, vr, declared, r.Header.Get("Content-Type"))
		if err != nil {
			// The body is verified before any storage decision, as in the
			// buffered implementation: drain what is left and check it first.
			if derr := vr.finish(); derr == nil {
				if verr := verifyUpload(vr, hash, declared); verr != nil {
					return verr
				}
			}
			return blobMismatch(err)
		}
		if err := vr.finish(); err != nil {
			return err
		}
		if err := verifyUpload(vr, hash, declared); err != nil {
			return err
		}
		n := 0
		if stored {
			n = 1
		}
		lf.Set("uploaded_blob_count", n)
		httpx.WriteJSON(w, http.StatusOK, protocol.BlobUploadResponse{Hash: hash, Stored: stored})
		return nil
	}))

	mux.Handle("POST /api/v1/vaults/{vaultId}/sync/commit", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		body, err := parsePlanBody(r)
		if err != nil {
			return err
		}
		ctx := r.Context()
		// Resolve the vault id before the transaction so plugin clients bound
		// to the internal id keep working while web URLs carry the name.
		idOrName := httpx.VaultIDParam(r)
		if idOrName == "" {
			return httpx.Validation("Too small: expected string to have >=1 characters")
		}
		resolved, err := httpx.FindVaultByIDOrName(ctx, d.Database.Vaults(), idOrName)
		if err != nil {
			return err
		}
		if resolved == nil {
			return httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "Vault was not found.")
		}
		vaultID := resolved.ID
		lf := httpx.LogFields(r)
		lf.Set("vault_id", vaultID)
		lf.Set("device_id", body.DeviceID)
		lf.Set("manifest_hash", body.ManifestHash)
		lf.Set("changed_file_count", len(body.Files))
		if err := verifyManifest(body.Files, body.ManifestHash); err != nil {
			return err
		}
		principal := httpx.PrincipalFrom(r)
		type commitResult struct {
			status   string
			revision int64
		}
		res, err := db.InTransaction(ctx, d.Database, func(tx db.TransactionRepositories) (commitResult, error) {
			if err := tx.LockVault(ctx, vaultID); err != nil {
				return commitResult{}, err
			}
			vault, err := tx.Vaults().FindByID(ctx, vaultID)
			if err != nil {
				return commitResult{}, err
			}
			if vault == nil {
				return commitResult{}, httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "Vault was not found.")
			}
			if err := httpx.RequireTephraSync(*vault); err != nil {
				return commitResult{}, err
			}
			if principal == nil || principal.Kind != httpx.PrincipalToken {
				return commitResult{}, httpx.Fail(http.StatusForbidden, protocol.CodeVaultAccessDenied, "An upload token is required.")
			}
			token, err := tx.ApiTokens().FindByID(ctx, principal.Token.ID)
			if err != nil {
				return commitResult{}, err
			}
			if token == nil || !httpx.TokenIsActive(token, d.Clock.Now()) || token.VaultID == nil || *token.VaultID != vaultID || !hasScope(token.Scopes, vm.ScopeVaultUpload) {
				return commitResult{}, httpx.Fail(http.StatusForbidden, protocol.CodeVaultAccessDenied, "Upload token cannot access this vault.")
			}
			existing, err := tx.VaultRevisions().FindByManifestHash(ctx, vaultID, body.ManifestHash)
			if err != nil {
				return commitResult{}, err
			}
			if existing != nil {
				now := d.Clock.Now()
				t := *token
				t.LastUsedAt = &now
				if err := tx.ApiTokens().Update(ctx, t); err != nil {
					return commitResult{}, err
				}
				return commitResult{"up-to-date", existing.Revision}, nil
			}
			if err := requireBlobs(ctx, tx.Blobs(), d.BlobStore, body.Files); err != nil {
				return commitResult{}, err
			}
			now := d.Clock.Now()
			device, err := tx.Devices().FindByID(ctx, body.DeviceID)
			if err != nil {
				return commitResult{}, err
			}
			if device == nil {
				if err := tx.Devices().Insert(ctx, vm.Device{ID: body.DeviceID, UserID: token.UserID, Name: body.DeviceID, CreatedAt: now, LastSeenAt: now}); err != nil {
					return commitResult{}, err
				}
			} else {
				if device.UserID != token.UserID {
					return commitResult{}, httpx.Fail(http.StatusForbidden, protocol.CodeVaultAccessDenied, "Device belongs to another user.")
				}
				dv := *device
				dv.LastSeenAt = now
				if err := tx.Devices().Update(ctx, dv); err != nil {
					return commitResult{}, err
				}
			}
			current, err := tx.VaultFiles().ListByVault(ctx, vaultID)
			if err != nil {
				return commitResult{}, err
			}
			revision := vault.LatestRevision + 1
			incoming := make([]vm.IncomingVaultFile, len(body.Files))
			incomingIDs := make(map[string]struct{}, len(body.Files))
			for i, f := range body.Files {
				incoming[i] = vm.IncomingVaultFile{FileID: f.FileID, Path: f.Path, BlobHash: f.Hash, Size: f.Size, Mtime: f.Mtime, MimeType: f.MimeType, Kind: vm.VaultFileKind(f.Kind)}
				incomingIDs[f.FileID] = struct{}{}
			}
			diff := vm.DiffRevision(vm.DiffRevisionInput{VaultID: vaultID, Revision: revision, CreatedAt: now, Current: current, Incoming: incoming, IDs: d.IDs})
			if err := tx.VaultRevisions().Insert(ctx, vm.VaultRevision{VaultID: vaultID, Revision: revision, ManifestHash: body.ManifestHash, DeviceID: body.DeviceID, CreatedAt: now}); err != nil {
				return commitResult{}, err
			}
			if len(diff.Versions) > 0 {
				if err := tx.FileVersions().InsertMany(ctx, diff.Versions); err != nil {
					return commitResult{}, err
				}
			}
			for _, f := range current {
				if _, keep := incomingIDs[f.FileID]; !keep {
					if err := tx.VaultFiles().Delete(ctx, vaultID, f.FileID); err != nil {
						return commitResult{}, err
					}
				}
			}
			for _, f := range body.Files {
				if err := tx.VaultFiles().Upsert(ctx, vm.CurrentVaultFile{FileID: f.FileID, VaultID: vaultID, Path: f.Path, BlobHash: f.Hash,
					Size: f.Size, Mtime: f.Mtime, MimeType: f.MimeType, Kind: vm.VaultFileKind(f.Kind), UpdatedRevision: revision}); err != nil {
					return commitResult{}, err
				}
			}
			nv := *vault
			nv.LatestRevision = revision
			nv.UpdatedAt = now
			if err := tx.Vaults().Update(ctx, nv); err != nil {
				return commitResult{}, err
			}
			t := *token
			t.LastUsedAt = &now
			if err := tx.ApiTokens().Update(ctx, t); err != nil {
				return commitResult{}, err
			}
			return commitResult{"committed", revision}, nil
		})
		if err != nil {
			return err
		}
		if res.status == "committed" {
			kickIndex(d, vaultID, res.revision)
		}
		lf.Set("revision", res.revision)
		pv, mv := syncProtocolFields()
		httpx.WriteJSON(w, http.StatusOK, protocol.SyncCommitResponse{Status: res.status, Revision: res.revision, ProtocolVersion: pv, MinimumPluginVersion: mv})
		return nil
	}))
}

// verifyUpload checks the fully-read upload against the declared size/hash.
func verifyUpload(vr *verifyReader, hash string, declared int64) error {
	if vr.n != declared {
		return blobMismatch(blobstore.ErrSizeMismatch)
	}
	if vr.sum() != hash {
		return blobMismatch(blobstore.ErrHashMismatch)
	}
	return nil
}
