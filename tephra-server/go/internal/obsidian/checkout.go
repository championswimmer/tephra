package obsidian

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"hash/fnv"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

func visibleVaultPath(p string) bool {
	if !protocol.IsCanonicalVaultPath(p) {
		return false
	}
	for _, part := range strings.Split(p, "/") {
		if strings.HasPrefix(part, ".") {
			return false
		}
	}
	return true
}

func syncFailed() error { return NativeFailure(protocol.CodeObsidianSyncFailed) }

// safeDirectory requires a real directory (never a symlink).
func safeDirectory(p string) error {
	info, err := os.Lstat(p)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return syncFailed()
	}
	return nil
}

func hasPrefixDir(p, dir string) bool { return strings.HasPrefix(p, dir+string(filepath.Separator)) }

// confinedPath refuses symlinks at every component, including the checkout
// root, and never lets a path leave it.
func confinedPath(root, p string, createParents bool) (string, error) {
	if !visibleVaultPath(p) {
		return "", httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidPath, "A visible canonical vault path is required.")
	}
	if err := safeDirectory(root); err != nil {
		return "", err
	}
	actualRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		return "", err
	}
	current := root
	parts := strings.Split(p, "/")
	for _, part := range parts[:len(parts)-1] {
		current = filepath.Join(current, part)
		if createParents {
			if err := os.Mkdir(current, 0o700); err != nil && !errors.Is(err, fs.ErrExist) {
				return "", err
			}
		}
		if err := safeDirectory(current); err != nil {
			return "", err
		}
		real, err := filepath.EvalSymlinks(current)
		if err != nil {
			return "", err
		}
		if !hasPrefixDir(real, actualRoot) {
			return "", syncFailed()
		}
	}
	absRoot, err := filepath.Abs(root)
	if err != nil {
		return "", err
	}
	destination := filepath.Join(append([]string{absRoot}, parts...)...)
	if !hasPrefixDir(destination, filepath.Clean(absRoot)) {
		return "", syncFailed()
	}
	info, err := os.Lstat(destination)
	if err == nil {
		if !info.Mode().IsRegular() {
			return "", syncFailed()
		}
	} else if !errors.Is(err, fs.ErrNotExist) {
		return "", err
	}
	return destination, nil
}

// ScannedFile is a stable, hashed checkout entry. Bodies are never retained.
type ScannedFile struct {
	Path  string
	Size  int64
	Mtime int64
	Hash  string
}

// hashStableFile streams the file through SHA-256 and verifies it did not
// change (size, mtime, inode) while being read.
func hashStableFile(root, p string, maxBytes int64) (ScannedFile, error) {
	destination, err := confinedPath(root, p, false)
	if err != nil {
		return ScannedFile{}, err
	}
	f, err := os.OpenFile(destination, os.O_RDONLY|oNoFollow, 0)
	if err != nil {
		return ScannedFile{}, err
	}
	defer f.Close()
	before, err := f.Stat()
	if err != nil {
		return ScannedFile{}, err
	}
	if !before.Mode().IsRegular() || before.Size() > maxBytes {
		return ScannedFile{}, syncFailed()
	}
	h := sha256.New()
	// Bounded read even if another writer grows the file between stat and read.
	if n, err := io.CopyN(h, f, before.Size()); err != nil || n != before.Size() {
		return ScannedFile{}, syncFailed()
	}
	after, err := f.Stat()
	if err != nil {
		return ScannedFile{}, err
	}
	current, err := os.Lstat(destination)
	if err != nil {
		return ScannedFile{}, err
	}
	if before.Size() != after.Size() || !before.ModTime().Equal(after.ModTime()) ||
		!os.SameFile(after, current) || current.Mode()&os.ModeSymlink != 0 {
		return ScannedFile{}, syncFailed()
	}
	mtime := after.ModTime().UnixMilli()
	if mtime < 0 {
		mtime = 0
	}
	return ScannedFile{Path: p, Size: after.Size(), Mtime: mtime, Hash: hex.EncodeToString(h.Sum(nil))}, nil
}

func visitCheckout(ctx context.Context, root string, maxBytes int64, visit func(ScannedFile) error) error {
	var walk func(directory, prefix string) error
	walk = func(directory, prefix string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := safeDirectory(directory); err != nil {
			return err
		}
		entries, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), ".") {
				continue
			}
			p := prefix + entry.Name()
			if !visibleVaultPath(p) || entry.Type()&os.ModeSymlink != 0 {
				return syncFailed()
			}
			switch {
			case entry.IsDir():
				if err := walk(filepath.Join(directory, entry.Name()), p+"/"); err != nil {
					return err
				}
			case entry.Type().IsRegular():
				file, err := hashStableFile(root, p, maxBytes)
				if err != nil {
					return err
				}
				if err := visit(file); err != nil {
					return err
				}
			default:
				return syncFailed()
			}
		}
		return nil
	}
	return walk(root, "")
}

// ScanCheckout lists and hashes the visible files of a checkout.
func ScanCheckout(ctx context.Context, root string, maxBytes int64) ([]ScannedFile, error) {
	var out []ScannedFile
	err := visitCheckout(ctx, root, maxBytes, func(f ScannedFile) error {
		out = append(out, f)
		return nil
	})
	return out, err
}

// checkoutFingerprint is a cheap change detector (names, sizes, mtimes, modes
// of visible entries; no file is read). It replaces fs.watch, which Go's
// standard library lacks.
func checkoutFingerprint(ctx context.Context, root string) (uint64, error) {
	h := fnv.New64a()
	var buf [24]byte
	put := func(vals ...int64) {
		for i, v := range vals {
			for b := 0; b < 8; b++ {
				buf[i*8+b] = byte(v >> (8 * b))
			}
		}
		_, _ = h.Write(buf[:len(vals)*8])
	}
	var walk func(dir string) error
	walk = func(dir string) error {
		if err := ctx.Err(); err != nil {
			return err
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		for _, e := range entries {
			if strings.HasPrefix(e.Name(), ".") {
				continue
			}
			info, err := e.Info()
			if err != nil {
				return err
			}
			_, _ = h.Write([]byte(e.Name()))
			put(info.Size(), info.ModTime().UnixNano(), int64(info.Mode()))
			if e.IsDir() {
				if err := walk(filepath.Join(dir, e.Name())); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := walk(root); err != nil {
		return 0, err
	}
	return h.Sum64(), nil
}

var attachmentMimes = map[string]string{
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
	"svg": "image/svg+xml", "pdf": "application/pdf", "mp3": "audio/mpeg", "wav": "audio/wav",
	"mp4": "video/mp4", "webm": "video/webm",
}

func attachmentMime(p string) string {
	i := strings.LastIndex(p, ".")
	if i >= 0 {
		if t, ok := attachmentMimes[strings.ToLower(p[i+1:])]; ok {
			return t
		}
	}
	return "application/octet-stream"
}

func isMarkdownPath(p string) bool { return strings.HasSuffix(strings.ToLower(p), ".md") }

// storeCheckoutBlob streams the (re-verified) file into the blob store when it
// is not already known. The store itself re-hashes the bytes, so a file that
// changes between hashing and storing is rejected, never stored under a wrong
// hash.
func storeCheckoutBlob(ctx context.Context, d httpx.Dependencies, root string, f ScannedFile, mime string) error {
	existing, err := d.Database.Blobs().FindByHash(ctx, f.Hash)
	if err != nil {
		return err
	}
	if existing != nil {
		has, err := d.BlobStore.Has(ctx, f.Hash)
		if err != nil {
			return err
		}
		if existing.Size == f.Size && has {
			return nil
		}
	}
	destination, err := confinedPath(root, f.Path, false)
	if err != nil {
		return err
	}
	file, err := os.OpenFile(destination, os.O_RDONLY|oNoFollow, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != f.Size {
		return syncFailed()
	}
	_, err = httpx.StoreBlobIfAbsent(ctx, d, f.Hash, io.LimitReader(file, f.Size), f.Size, mime)
	if errors.Is(err, blobstore.ErrHashMismatch) || errors.Is(err, blobstore.ErrSizeMismatch) {
		return syncFailed()
	}
	return err
}

// ImportCheckout scans the whole checkout before any ledger change, stores
// new blobs (immutable writes may safely be orphaned on failure), and commits
// one revision if anything differs. It returns the vault's latest revision.
func ImportCheckout(ctx context.Context, d httpx.Dependencies, vault vm.Vault, paths VaultPaths) (int64, error) {
	list, err := d.Database.VaultFiles().ListByVault(ctx, vault.ID)
	if err != nil {
		return 0, err
	}
	previous := make(map[string]vm.CurrentVaultFile, len(list))
	for _, f := range list {
		previous[f.Path] = f
	}
	list = nil
	var incoming []vm.IncomingVaultFile
	// Only one file is open and hashed at a time; bodies are streamed.
	err = visitCheckout(ctx, paths.Vault, d.BlobLimit(), func(entry ScannedFile) error {
		old, hadOld := previous[entry.Path]
		kind := vm.KindAttachment
		mime := attachmentMime(entry.Path)
		if isMarkdownPath(entry.Path) {
			kind, mime = vm.KindMarkdown, "text/markdown"
		}
		if err := storeCheckoutBlob(ctx, d, paths.Vault, entry, mime); err != nil {
			return err
		}
		fileID := ""
		mtime := entry.Mtime
		if hadOld {
			fileID = old.FileID
			if old.BlobHash == entry.Hash {
				mtime = old.Mtime
			}
		} else {
			fileID = d.IDs.Generate()
		}
		m := mime
		incoming = append(incoming, vm.IncomingVaultFile{FileID: fileID, Path: entry.Path, BlobHash: entry.Hash,
			Size: entry.Size, Mtime: mtime, Kind: kind, MimeType: &m})
		return nil
	})
	if err != nil {
		return 0, err
	}
	type result struct {
		revision int64
		changed  bool
	}
	res, err := db.InTransaction(ctx, d.Database, func(repos db.TransactionRepositories) (result, error) {
		if err := repos.LockVault(ctx, vault.ID); err != nil {
			return result{}, err
		}
		fresh, err := repos.Vaults().FindByID(ctx, vault.ID)
		if err != nil {
			return result{}, err
		}
		if fresh == nil || fresh.SyncMode != vm.SyncModeObsidian {
			return result{}, syncFailed()
		}
		current, err := repos.VaultFiles().ListByVault(ctx, vault.ID)
		if err != nil {
			return result{}, err
		}
		next := fresh.LatestRevision + 1
		now := d.Clock.Now()
		diff := vm.DiffRevision(vm.DiffRevisionInput{VaultID: vault.ID, Revision: next, CreatedAt: now,
			Current: current, Incoming: incoming, IDs: d.IDs})
		if diff.IsNoOp {
			return result{fresh.LatestRevision, false}, nil
		}
		deviceID := "obsidian:" + vault.ID
		device, err := repos.Devices().FindByID(ctx, deviceID)
		if err != nil {
			return result{}, err
		}
		if device == nil {
			platform := "obsidian-headless"
			if err := repos.Devices().Insert(ctx, vm.Device{ID: deviceID, UserID: fresh.OwnerUserID,
				Name: "Obsidian Sync", Platform: &platform, CreatedAt: now, LastSeenAt: now}); err != nil {
				return result{}, err
			}
		}
		entries := make([]protocol.SyncManifestEntry, len(incoming))
		for i, f := range incoming {
			entries[i] = protocol.SyncManifestEntry{FileID: f.FileID, Path: f.Path, Hash: f.BlobHash,
				Size: f.Size, Mtime: f.Mtime, MimeType: f.MimeType, Kind: string(f.Kind)}
		}
		manifestHash, err := protocol.HashManifest(entries)
		if err != nil {
			return result{}, err
		}
		if err := repos.VaultRevisions().Insert(ctx, vm.VaultRevision{VaultID: vault.ID, Revision: next,
			ManifestHash: manifestHash, DeviceID: deviceID, CreatedAt: now}); err != nil {
			return result{}, err
		}
		if err := repos.FileVersions().InsertMany(ctx, diff.Versions); err != nil {
			return result{}, err
		}
		ids := make(map[string]struct{}, len(incoming))
		for _, f := range incoming {
			ids[f.FileID] = struct{}{}
		}
		for _, f := range current {
			if _, ok := ids[f.FileID]; !ok {
				if err := repos.VaultFiles().Delete(ctx, vault.ID, f.FileID); err != nil {
					return result{}, err
				}
			}
		}
		for _, f := range incoming {
			if err := repos.VaultFiles().Upsert(ctx, vm.CurrentVaultFile{FileID: f.FileID, VaultID: vault.ID,
				Path: f.Path, BlobHash: f.BlobHash, Size: f.Size, Mtime: f.Mtime, MimeType: f.MimeType,
				Kind: f.Kind, UpdatedRevision: next}); err != nil {
				return result{}, err
			}
		}
		fresh.LatestRevision = next
		fresh.UpdatedAt = now
		if err := repos.Vaults().Update(ctx, *fresh); err != nil {
			return result{}, err
		}
		return result{next, true}, nil
	})
	if err != nil {
		return 0, err
	}
	if res.changed {
		if err := d.Database.GraphCache().DeleteByVault(ctx, vault.ID); err != nil {
			return 0, err
		}
	}
	state, err := d.Database.NoteIndex().GetState(ctx, vault.ID)
	if err != nil {
		return 0, err
	}
	if state == nil || state.IndexedRevision != res.revision {
		if indexer, ok := d.IndexService.(httpx.VaultIndexer); ok {
			if err := indexer.IndexVault(ctx, vault.ID, res.revision); err != nil {
				return 0, err
			}
		}
	}
	return res.revision, nil
}

// AtomicNoteWrite writes bytes into the checkout via a private temp file in
// the same persistent filesystem, fsyncs, then renames over the destination.
func AtomicNoteWrite(paths VaultPaths, p string, data []byte) error {
	destination, err := confinedPath(paths.Vault, p, true)
	if err != nil {
		return err
	}
	if err := safeDirectory(paths.Tmp); err != nil {
		return err
	}
	temporary := filepath.Join(paths.Tmp, randomHex(16))
	f, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	defer os.Remove(temporary)
	_, werr := f.Write(data)
	if werr == nil {
		werr = f.Sync()
	}
	cerr := f.Close()
	if werr != nil {
		return werr
	}
	if cerr != nil {
		return cerr
	}
	if _, err := confinedPath(paths.Vault, p, false); err != nil {
		return err
	}
	if err := os.Rename(temporary, destination); err != nil {
		return err
	}
	return syncDir(filepath.Dir(destination))
}
