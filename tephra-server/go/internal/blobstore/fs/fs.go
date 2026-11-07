// Package fs is the filesystem blob store (port of packages/blob-store/filesystem).
// Layout: <root>/<hash[0:2]>/<hash[2:4]>/<hash>, identical to the Node implementation.
package fs

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	iofs "io/fs"
	"os"
	"path/filepath"
	"regexp"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
)

var hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

// Store implements blobstore.Store on a local directory.
type Store struct {
	root string
}

var _ blobstore.Store = (*Store)(nil)

// New returns a Store rooted at root (created lazily on first Put).
func New(root string) (*Store, error) {
	if root == "" {
		return nil, errors.New("rootDirectory must not be empty")
	}
	return &Store{root: root}, nil
}

// Root returns the root directory.
func (s *Store) Root() string { return s.root }

func (s *Store) dir(hash string) string { return filepath.Join(s.root, hash[0:2], hash[2:4]) }

func (s *Store) path(hash string) (string, error) {
	if !hashPattern.MatchString(hash) {
		return "", blobstore.ErrInvalidHash
	}
	return filepath.Join(s.dir(hash), hash), nil
}

func (s *Store) Has(_ context.Context, hash string) (bool, error) {
	p, err := s.path(hash)
	if err != nil {
		return false, err
	}
	info, err := os.Lstat(p)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return false, nil
		}
		return false, err
	}
	return info.Mode().IsRegular(), nil
}

// Put streams in.Body to a temp file, verifying size and SHA-256, then renames atomically.
func (s *Store) Put(ctx context.Context, in blobstore.PutInput) (err error) {
	dest, err := s.path(in.Hash)
	if err != nil {
		return err
	}
	if in.Size < 0 {
		return blobstore.ErrInvalidSize
	}
	existing, lerr := os.Lstat(dest)
	if lerr == nil {
		if !existing.Mode().IsRegular() || existing.Size() != in.Size {
			return blobstore.ErrExistingMismatch
		}
		return nil
	} else if !errors.Is(lerr, iofs.ErrNotExist) {
		return lerr
	}
	if in.Body == nil {
		return errors.New("blob body is required")
	}

	dir := s.dir(in.Hash)
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return err
	}
	var rnd [16]byte
	if _, err := randRead(rnd[:]); err != nil {
		return err
	}
	tmp := filepath.Join(dir, fmt.Sprintf(".%s.%s.tmp", in.Hash, hex.EncodeToString(rnd[:])))
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	closed := false
	defer func() {
		if !closed {
			_ = f.Close()
		}
		_ = os.Remove(tmp)
	}()

	digest := sha256.New()
	// Read at most size+1 bytes so overflow is detected without unbounded consumption.
	limited := io.LimitReader(&ctxReader{ctx: ctx, r: in.Body}, in.Size+1)
	n, err := io.Copy(io.MultiWriter(f, digest), limited)
	if err != nil {
		return err
	}
	if n != in.Size {
		return blobstore.ErrSizeMismatch
	}
	if hex.EncodeToString(digest.Sum(nil)) != in.Hash {
		return blobstore.ErrHashMismatch
	}
	if err := f.Sync(); err != nil {
		return err
	}
	closed = true
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, dest); err != nil {
		cur, serr := os.Lstat(dest)
		if serr != nil || !cur.Mode().IsRegular() || cur.Size() != in.Size {
			return err
		}
	}
	return nil
}

// Get opens the blob for streaming; returns blobstore.ErrNotFound if absent or not a regular file.
func (s *Store) Get(_ context.Context, hash string) (*blobstore.ReadResult, error) {
	p, err := s.path(hash)
	if err != nil {
		return nil, err
	}
	info, err := os.Lstat(p)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return nil, blobstore.ErrNotFound
		}
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, blobstore.ErrNotFound
	}
	f, err := os.Open(p)
	if err != nil {
		if errors.Is(err, iofs.ErrNotExist) {
			return nil, blobstore.ErrNotFound
		}
		return nil, err
	}
	fi, err := f.Stat()
	if err != nil {
		_ = f.Close()
		return nil, err
	}
	return &blobstore.ReadResult{Body: f, Size: fi.Size()}, nil
}

// Delete removes the blob; missing blobs are ignored.
func (s *Store) Delete(_ context.Context, hash string) error {
	p, err := s.path(hash)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, iofs.ErrNotExist) {
		return err
	}
	return nil
}

type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c *ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}
