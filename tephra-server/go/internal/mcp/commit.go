package mcp

import (
	"context"
	"net/http"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

const markdownBlobMime = "text/markdown; charset=utf-8"

// commitNote commits one Markdown note as exactly one vault revision,
// mirroring the web edit path (server-computed hash, vault lock,
// DiffRevision ledger row). It is a self-contained port of mcp/commit.ts.
func commitNote(ctx context.Context, d httpx.Dependencies, vault vm.Vault, userID string, plan httpx.NotePlan, text string) (httpx.NoteCommitResult, error) {
	if vault.SyncMode == vm.SyncModeObsidian {
		svc, err := httpx.RequireObsidianService(d)
		if err != nil {
			return httpx.NoteCommitResult{}, err
		}
		return svc.WriteNote(ctx, vault, plan, text)
	}
	data := []byte(text)
	if int64(len(data)) > d.BlobLimit() {
		return httpx.NoteCommitResult{}, httpx.Fail(http.StatusRequestEntityTooLarge, protocol.CodeBlobTooLarge, "Content exceeds the configured size limit.")
	}
	hash := protocol.SHA256Hex(data)
	if plan.Kind == "update" {
		pre, err := d.Database.VaultFiles().FindByID(ctx, vault.ID, plan.FileID)
		if err != nil {
			return httpx.NoteCommitResult{}, err
		}
		if pre != nil && pre.BlobHash == hash && pre.BlobHash == plan.BaseHash {
			return httpx.NoteCommitResult{Status: "up-to-date", Revision: vault.LatestRevision, File: pre}, nil
		}
	}
	if _, err := httpx.StoreBlobIfAbsent(ctx, d, hash, strings.NewReader(text), int64(len(data)), markdownBlobMime); err != nil {
		return httpx.NoteCommitResult{}, err
	}

	result, err := db.InTransaction(ctx, d.Database, func(repos db.TransactionRepositories) (httpx.NoteCommitResult, error) {
		if err := repos.LockVault(ctx, vault.ID); err != nil {
			return httpx.NoteCommitResult{}, err
		}
		fresh, err := repos.Vaults().FindByID(ctx, vault.ID)
		if err != nil {
			return httpx.NoteCommitResult{}, err
		}
		if fresh == nil {
			return httpx.NoteCommitResult{}, httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "Vault was not found.")
		}
		files, err := repos.VaultFiles().ListByVault(ctx, vault.ID)
		if err != nil {
			return httpx.NoteCommitResult{}, err
		}
		now := d.Clock.Now()
		var target vm.CurrentVaultFile
		if plan.Kind == "create" {
			lower := jstext.Lower(plan.Path)
			for i := range files {
				if jstext.Lower(files[i].Path) == lower {
					clash := files[i]
					return httpx.NoteCommitResult{Status: "exists", Current: &clash}, nil
				}
			}
			mime := "text/markdown"
			target = vm.CurrentVaultFile{
				FileID: d.IDs.Generate(), VaultID: vault.ID, Path: plan.Path, BlobHash: hash,
				Size: int64(len(data)), Mtime: now, MimeType: &mime, Kind: vm.KindMarkdown,
				UpdatedRevision: fresh.LatestRevision + 1,
			}
		} else {
			var current *vm.CurrentVaultFile
			for i := range files {
				if files[i].FileID == plan.FileID {
					current = &files[i]
					break
				}
			}
			if current == nil {
				return httpx.NoteCommitResult{}, httpx.Fail(http.StatusNotFound, protocol.CodeVaultNotFound, "File was not found.")
			}
			if current.BlobHash != plan.BaseHash {
				return httpx.NoteCommitResult{Status: "conflict", Current: current}, nil
			}
			target = *current
			target.BlobHash = hash
			target.Size = int64(len(data))
			target.Mtime = max(now, current.Mtime+1)
			target.UpdatedRevision = fresh.LatestRevision + 1
		}
		revision := fresh.LatestRevision + 1
		deviceID := "mcp:" + userID
		dev, err := repos.Devices().FindByID(ctx, deviceID)
		if err != nil {
			return httpx.NoteCommitResult{}, err
		}
		if dev == nil {
			platform := "mcp"
			if err := repos.Devices().Insert(ctx, vm.Device{
				ID: deviceID, UserID: userID, Name: "Tephra MCP", Platform: &platform, CreatedAt: now, LastSeenAt: now,
			}); err != nil {
				return httpx.NoteCommitResult{}, err
			}
		}
		toEntry := func(f vm.CurrentVaultFile) vm.IncomingVaultFile {
			return vm.IncomingVaultFile{FileID: f.FileID, Path: f.Path, BlobHash: f.BlobHash, Size: f.Size, Mtime: f.Mtime, MimeType: f.MimeType, Kind: f.Kind}
		}
		incoming := make([]vm.IncomingVaultFile, 0, len(files)+1)
		for _, f := range files {
			if f.FileID != target.FileID {
				incoming = append(incoming, toEntry(f))
			}
		}
		incoming = append(incoming, toEntry(target))
		diff := vm.DiffRevision(vm.DiffRevisionInput{
			VaultID: vault.ID, Revision: revision, CreatedAt: now, Current: files, Incoming: incoming, IDs: d.IDs,
		})
		entries := make([]protocol.SyncManifestEntry, len(incoming))
		for i, f := range incoming {
			entries[i] = protocol.SyncManifestEntry{FileID: f.FileID, Path: f.Path, Hash: f.BlobHash, Size: f.Size, Mtime: f.Mtime, MimeType: f.MimeType, Kind: string(f.Kind)}
		}
		manifestHash, err := protocol.HashManifest(entries)
		if err != nil {
			return httpx.NoteCommitResult{}, err
		}
		if err := repos.VaultRevisions().Insert(ctx, vm.VaultRevision{
			VaultID: vault.ID, Revision: revision, ManifestHash: manifestHash, DeviceID: deviceID, CreatedAt: now,
		}); err != nil {
			return httpx.NoteCommitResult{}, err
		}
		if len(diff.Versions) > 0 {
			if err := repos.FileVersions().InsertMany(ctx, diff.Versions); err != nil {
				return httpx.NoteCommitResult{}, err
			}
		}
		if err := repos.VaultFiles().Upsert(ctx, target); err != nil {
			return httpx.NoteCommitResult{}, err
		}
		updated := *fresh
		updated.LatestRevision = revision
		updated.UpdatedAt = now
		if err := repos.Vaults().Update(ctx, updated); err != nil {
			return httpx.NoteCommitResult{}, err
		}
		return httpx.NoteCommitResult{Status: "committed", Revision: revision, File: &target}, nil
	})
	if err != nil {
		return httpx.NoteCommitResult{}, err
	}

	if result.Status == "committed" {
		_ = d.Database.GraphCache().DeleteByVault(ctx, vault.ID)
		if idx := d.Indexer(); idx != nil {
			go func(rev int64) {
				// A crashing indexer must never take the API down.
				defer func() { _ = recover() }()
				_ = idx.IndexVault(context.WithoutCancel(ctx), vault.ID, rev)
			}(result.Revision)
		}
	}
	return result, nil
}
