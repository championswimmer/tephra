package api

import (
	"io"
	"net/http"
	"strings"
	"unicode/utf8"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func init() { Register(RegisterWebEditRoutes) }

// parseIfMatch parses the If-Match precondition of the web content write: the
// base blob hash, bare, `<hash>` or quoted. Missing/malformed is a 400, never
// an unconditional overwrite.
func parseIfMatch(r *http.Request) (string, error) {
	vs := r.Header.Values("If-Match")
	if len(vs) == 0 {
		return "", httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "An If-Match header with the base content hash is required.")
	}
	value := jstext.Trim(strings.Join(vs, ", "))
	if strings.HasPrefix(value, "<") && strings.HasSuffix(value, ">") {
		value = jstext.Trim(value[1 : len(value)-1])
	}
	if len(value) >= 2 && strings.HasPrefix(value, `"`) && strings.HasSuffix(value, `"`) {
		value = value[1 : len(value)-1]
	}
	if !protocol.IsSHA256Hex(value) {
		return "", httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "If-Match must be a SHA-256 hash of the base content.")
	}
	return value, nil
}

func conflictBody(blobHash string, size, mtime, revision int64) protocol.EditConflictResponse {
	return protocol.EditConflictResponse{
		Error:   protocol.ApiError{Code: protocol.CodeEditConflict, Message: "The file changed since it was loaded."},
		Current: protocol.EditConflictCurrent{BlobHash: blobHash, Size: size, Mtime: mtime, Revision: revision},
	}
}

// RegisterWebEditRoutes registers PUT /vaults/{vaultId}/files/{fileId}/content:
// one saved markdown file becomes one server revision in the same ledger
// plugin commits use, with optimistic concurrency via If-Match.
func RegisterWebEditRoutes(mux *http.ServeMux, d Dependencies) {
	mux.Handle("PUT /api/v1/vaults/{vaultId}/files/{fileId}/content", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		vault, err := httpx.OwnedVault(r, d, vm.ScopeVaultWrite)
		if err != nil {
			return err
		}
		ctx := r.Context()
		fileID := r.PathValue("fileId")
		// Pre-lock read is validation only; the authoritative read happens
		// inside the transaction after lockVault.
		preLock, err := d.Database.VaultFiles().FindByID(ctx, vault.ID, fileID)
		if err != nil {
			return err
		}
		if preLock == nil {
			return httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "File was not found.")
		}
		if preLock.Kind != vm.KindMarkdown {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Only Markdown files can be edited from the web.")
		}
		ifMatch, err := parseIfMatch(r)
		if err != nil {
			return err
		}
		limitBytes := d.BlobLimit()
		declared, ok := declaredSize(r, "X-Tephra-Content-Size")
		if !ok || declared < 0 {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "A valid content size is required.")
		}
		if declared > limitBytes {
			return httpx.Fail(http.StatusRequestEntityTooLarge, protocol.CodeBlobTooLarge, "Content exceeds the configured size limit.")
		}
		var src io.Reader = http.NoBody
		if r.Body != nil {
			src = r.Body
		}
		sp, err := newSpool(src, declared)
		if err != nil {
			return err
		}
		defer sp.close()
		if sp.size != declared {
			return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Uploaded size does not match the declared size.")
		}
		if vault.SyncMode == vm.SyncModeObsidian {
			data, err := sp.bytes()
			if err != nil {
				return err
			}
			if !utf8.Valid(data) {
				return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Markdown content must be UTF-8.")
			}
			svc, err := httpx.RequireObsidianService(d)
			if err != nil {
				return err
			}
			result, err := svc.WriteNote(ctx, *vault, httpx.NotePlan{Kind: "update", FileID: fileID, BaseHash: ifMatch}, string(data))
			if err != nil {
				return err
			}
			if result.Status == "conflict" || result.Status == "exists" {
				c := result.Current
				httpx.WriteJSON(w, http.StatusConflict, conflictBody(c.BlobHash, c.Size, c.Mtime, c.UpdatedRevision))
				return nil
			}
			httpx.WriteJSON(w, http.StatusOK, protocol.SaveContentResponse{Status: result.Status, Revision: result.Revision,
				BlobHash: result.File.BlobHash, Size: result.File.Size, Mtime: result.File.Mtime})
			return nil
		}
		// Server-computed digest: never trust a client digest.
		hash := sp.sum
		lf := httpx.LogFields(r)
		lf.Set("vault_id", vault.ID)
		lf.Set("file_id", fileID)
		lf.Set("blob_hash", hash)
		lf.Set("content_bytes", sp.size)
		// Byte-identical save: nothing to commit regardless of what the client sent.
		if hash == preLock.BlobHash {
			lf.Set("revision", vault.LatestRevision)
			httpx.WriteJSON(w, http.StatusOK, protocol.SaveContentResponse{Status: "up-to-date", Revision: vault.LatestRevision,
				BlobHash: hash, Size: preLock.Size, Mtime: preLock.Mtime})
			return nil
		}
		body, err := sp.reader()
		if err != nil {
			return err
		}
		if _, err := httpx.StoreBlobIfAbsent(ctx, d, hash, body, sp.size, r.Header.Get("Content-Type")); err != nil {
			return blobMismatch(err)
		}
		principal := httpx.PrincipalFrom(r)
		type editResult struct {
			conflict *protocol.EditConflictResponse
			revision int64
			size     int64
			mtime    int64
		}
		res, err := db.InTransaction(ctx, d.Database, func(tx db.TransactionRepositories) (editResult, error) {
			if err := tx.LockVault(ctx, vault.ID); err != nil {
				return editResult{}, err
			}
			fresh, err := tx.Vaults().FindByID(ctx, vault.ID)
			if err != nil {
				return editResult{}, err
			}
			if fresh == nil {
				return editResult{}, httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "Vault was not found.")
			}
			current, err := tx.VaultFiles().FindByID(ctx, vault.ID, fileID)
			if err != nil {
				return editResult{}, err
			}
			if current == nil {
				return editResult{}, httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "File was not found.")
			}
			if current.Kind != vm.KindMarkdown {
				return editResult{}, httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Only Markdown files can be edited from the web.")
			}
			if current.BlobHash != ifMatch {
				c := conflictBody(current.BlobHash, current.Size, current.Mtime, current.UpdatedRevision)
				return editResult{conflict: &c}, nil
			}
			now := d.Clock.Now()
			// A web edit must strictly post-date the content it was based on
			// so the timestamp conflict rule cannot be inverted by a lagging clock.
			mtime := max(now, current.Mtime+1)
			// Synthetic web device (device_id is NOT NULL), inserted
			// idempotently on the first web write per user.
			deviceID := "web:" + principal.User.ID
			dev, err := tx.Devices().FindByID(ctx, deviceID)
			if err != nil {
				return editResult{}, err
			}
			if dev == nil {
				if err := tx.Devices().Insert(ctx, vm.Device{ID: deviceID, UserID: principal.User.ID, Name: "Tephra Web", Platform: strPtr("web"), CreatedAt: now, LastSeenAt: now}); err != nil {
					return editResult{}, err
				}
			}
			files, err := tx.VaultFiles().ListByVault(ctx, vault.ID)
			if err != nil {
				return editResult{}, err
			}
			revision := fresh.LatestRevision + 1
			incoming := make([]vm.IncomingVaultFile, len(files))
			manifest := make([]protocol.SyncManifestEntry, len(files))
			for i, e := range files {
				in := vm.IncomingVaultFile{FileID: e.FileID, Path: e.Path, BlobHash: e.BlobHash, Size: e.Size, Mtime: e.Mtime, MimeType: e.MimeType, Kind: e.Kind}
				if e.FileID == fileID {
					in.BlobHash, in.Size, in.Mtime = hash, sp.size, mtime
				}
				incoming[i] = in
				manifest[i] = protocol.SyncManifestEntry{FileID: in.FileID, Path: in.Path, Hash: in.BlobHash, Size: in.Size, Mtime: in.Mtime, MimeType: in.MimeType, Kind: string(in.Kind)}
			}
			// The ledger row comes from the same diff path as a plugin commit.
			diff := vm.DiffRevision(vm.DiffRevisionInput{VaultID: vault.ID, Revision: revision, CreatedAt: now, Current: files, Incoming: incoming, IDs: d.IDs})
			manifestHash, err := protocol.HashManifest(manifest)
			if err != nil {
				return editResult{}, err
			}
			if err := tx.VaultRevisions().Insert(ctx, vm.VaultRevision{VaultID: vault.ID, Revision: revision, ManifestHash: manifestHash, DeviceID: deviceID, CreatedAt: now}); err != nil {
				return editResult{}, err
			}
			if len(diff.Versions) > 0 {
				if err := tx.FileVersions().InsertMany(ctx, diff.Versions); err != nil {
					return editResult{}, err
				}
			}
			if err := tx.VaultFiles().Upsert(ctx, vm.CurrentVaultFile{FileID: fileID, VaultID: vault.ID, Path: current.Path, BlobHash: hash,
				Size: sp.size, Mtime: mtime, MimeType: current.MimeType, Kind: current.Kind, UpdatedRevision: revision}); err != nil {
				return editResult{}, err
			}
			nv := *fresh
			nv.LatestRevision = revision
			nv.UpdatedAt = now
			if err := tx.Vaults().Update(ctx, nv); err != nil {
				return editResult{}, err
			}
			return editResult{revision: revision, size: sp.size, mtime: mtime}, nil
		})
		if err != nil {
			return err
		}
		if res.conflict != nil {
			lf.Set("revision", res.conflict.Current.Revision)
			httpx.WriteJSON(w, http.StatusConflict, res.conflict)
			return nil
		}
		// Same post-commit behaviour as a plugin commit: drop the materialised
		// graph row (so no stale revision is served) and trigger indexing.
		_ = d.Database.GraphCache().DeleteByVault(ctx, vault.ID)
		kickIndex(d, vault.ID, res.revision)
		lf.Set("revision", res.revision)
		httpx.WriteJSON(w, http.StatusOK, protocol.SaveContentResponse{Status: "committed", Revision: res.revision, BlobHash: hash, Size: res.size, Mtime: res.mtime})
		return nil
	}))
}
