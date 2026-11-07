package fs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	iofs "io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"testing/iotest"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
)

var ctx = context.Background()

func sum(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }

func newStore(t *testing.T) (string, *Store) {
	t.Helper()
	root := t.TempDir()
	s, err := New(root)
	if err != nil {
		t.Fatal(err)
	}
	return root, s
}

func filesBelow(t *testing.T, p string) []string {
	t.Helper()
	var out []string
	_ = filepath.WalkDir(p, func(path string, d iofs.DirEntry, err error) error {
		if err == nil && !d.IsDir() {
			out = append(out, d.Name())
		}
		return nil
	})
	return out
}

func readAll(t *testing.T, s *Store, h string) []byte {
	t.Helper()
	r, err := s.Get(ctx, h)
	if err != nil {
		t.Fatal(err)
	}
	defer r.Body.Close()
	b, _ := io.ReadAll(r.Body)
	if r.Size != int64(len(b)) {
		t.Fatalf("size %d != %d", r.Size, len(b))
	}
	return b
}

func TestStreamedWriteAndRead(t *testing.T) {
	root, s := newStore(t)
	data := []byte("streamed content")
	h := sum(data)
	body := io.MultiReader(strings.NewReader("streamed "), strings.NewReader("content"))
	if err := s.Put(ctx, blobstore.PutInput{Hash: h, Body: body, Size: int64(len(data))}); err != nil {
		t.Fatal(err)
	}
	if ok, _ := s.Has(ctx, h); !ok {
		t.Fatal("has")
	}
	if !bytes.Equal(readAll(t, s, h), data) {
		t.Fatal("content")
	}
	got := filesBelow(t, filepath.Join(root, h[:2], h[2:4]))
	if len(got) != 1 || got[0] != h {
		t.Fatal(got)
	}
}

func TestIdempotent(t *testing.T) {
	_, s := newStore(t)
	data := []byte("same")
	h := sum(data)
	_ = s.Put(ctx, blobstore.PutInput{Hash: h, Body: bytes.NewReader(data), Size: 4})
	if err := s.Put(ctx, blobstore.PutInput{Hash: h, Body: bytes.NewReader([]byte{0, 0, 0, 0}), Size: 4}); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(readAll(t, s, h), data) {
		t.Fatal("overwritten")
	}
	if err := s.Put(ctx, blobstore.PutInput{Hash: h, Body: bytes.NewReader(data), Size: 5}); !errors.Is(err, blobstore.ErrExistingMismatch) {
		t.Fatal(err)
	}
}

func TestMismatchesLeaveNoFiles(t *testing.T) {
	root, s := newStore(t)
	data := []byte("content")
	wrong := strings.Repeat("0", 64)
	if err := s.Put(ctx, blobstore.PutInput{Hash: wrong, Body: bytes.NewReader(data), Size: 7}); !errors.Is(err, blobstore.ErrHashMismatch) {
		t.Fatal(err)
	}
	if ok, _ := s.Has(ctx, wrong); ok || len(filesBelow(t, root)) != 0 {
		t.Fatal("leftover")
	}
	h := sum(data)
	for _, size := range []int64{8, 6} {
		if err := s.Put(ctx, blobstore.PutInput{Hash: h, Body: bytes.NewReader(data), Size: size}); !errors.Is(err, blobstore.ErrSizeMismatch) {
			t.Fatal(size, err)
		}
	}
	if ok, _ := s.Has(ctx, h); ok || len(filesBelow(t, root)) != 0 {
		t.Fatal("leftover")
	}
}

func TestInterruptedStream(t *testing.T) {
	root, s := newStore(t)
	h := sum([]byte("partial-complete-value"))
	body := io.MultiReader(strings.NewReader("partial"), iotest.ErrReader(errors.New("input failed")))
	err := s.Put(ctx, blobstore.PutInput{Hash: h, Body: body, Size: 22})
	if err == nil || !strings.Contains(err.Error(), "input failed") {
		t.Fatal(err)
	}
	if ok, _ := s.Has(ctx, h); ok || len(filesBelow(t, root)) != 0 {
		t.Fatal("leftover")
	}
}

func TestCancelledContext(t *testing.T) {
	root, s := newStore(t)
	c, cancel := context.WithCancel(ctx)
	cancel()
	d := []byte("x")
	if err := s.Put(c, blobstore.PutInput{Hash: sum(d), Body: bytes.NewReader(d), Size: 1}); err == nil {
		t.Fatal("expected error")
	}
	if len(filesBelow(t, root)) != 0 {
		t.Fatal("leftover")
	}
}

func TestHashValidationAndDelete(t *testing.T) {
	_, s := newStore(t)
	for _, bad := range []string{"../secret", strings.Repeat("A", 64), strings.Repeat("a", 63), strings.Repeat("a", 64) + "/file", "", "..\x00" + strings.Repeat("a", 61)} {
		if _, err := s.Has(ctx, bad); !errors.Is(err, blobstore.ErrInvalidHash) {
			t.Fatal(bad, err)
		}
		if _, err := s.Get(ctx, bad); !errors.Is(err, blobstore.ErrInvalidHash) {
			t.Fatal(bad, err)
		}
		if err := s.Delete(ctx, bad); !errors.Is(err, blobstore.ErrInvalidHash) {
			t.Fatal(bad, err)
		}
		if err := s.Put(ctx, blobstore.PutInput{Hash: bad, Body: strings.NewReader(""), Size: 0}); !errors.Is(err, blobstore.ErrInvalidHash) {
			t.Fatal(bad, err)
		}
	}
	d := strings.Repeat("f", 64)
	if err := s.Delete(ctx, d); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Get(ctx, d); !errors.Is(err, blobstore.ErrNotFound) {
		t.Fatal(err)
	}
}

func TestSymlinkIsNotABlob(t *testing.T) {
	root, s := newStore(t)
	secret := filepath.Join(t.TempDir(), "secret")
	_ = os.WriteFile(secret, []byte("x"), 0o600)
	h := strings.Repeat("a", 64)
	_ = os.MkdirAll(filepath.Join(root, "aa", "aa"), 0o755)
	if err := os.Symlink(secret, filepath.Join(root, "aa", "aa", h)); err != nil {
		t.Skip(err)
	}
	if ok, _ := s.Has(ctx, h); ok {
		t.Fatal("has symlink")
	}
	if _, err := s.Get(ctx, h); !errors.Is(err, blobstore.ErrNotFound) {
		t.Fatal(err)
	}
}

func TestLargeStreamBoundedMemory(t *testing.T) {
	_, s := newStore(t)
	const size = 64 << 20
	hh := sha256.New()
	_, _ = io.Copy(hh, io.LimitReader(zeros{}, size))
	h := hex.EncodeToString(hh.Sum(nil))
	if err := s.Put(ctx, blobstore.PutInput{Hash: h, Body: io.LimitReader(zeros{}, size), Size: size}); err != nil {
		t.Fatal(err)
	}
	r, err := s.Get(ctx, h)
	if err != nil || r.Size != size {
		t.Fatal(err)
	}
	r.Body.Close()
}

type zeros struct{}

func (zeros) Read(p []byte) (int, error) {
	clear(p)
	return len(p), nil
}

// Reads a directory populated by the Node FilesystemBlobStore, and checks Go writes the same layout.
func TestNodeFixtureCompat(t *testing.T) {
	s, _ := New("../../testdata/blobs-fixture")
	raw, err := os.ReadFile("../../testdata/blobs-fixture-manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest []struct{ Hash, Content string }
	if err := json.Unmarshal(raw, &manifest); err != nil || len(manifest) == 0 {
		t.Fatal(err)
	}
	root, g := newStore(t)
	for _, m := range manifest {
		if ok, _ := s.Has(ctx, m.Hash); !ok {
			t.Fatalf("node blob %s missing", m.Hash)
		}
		if string(readAll(t, s, m.Hash)) != m.Content {
			t.Fatal("content")
		}
		// Go write produces the same relative path as Node's fixture.
		if err := g.Put(ctx, blobstore.PutInput{Hash: m.Hash, Body: strings.NewReader(m.Content), Size: int64(len(m.Content))}); err != nil {
			t.Fatal(err)
		}
		rel := filepath.Join(m.Hash[:2], m.Hash[2:4], m.Hash)
		a, _ := os.ReadFile(filepath.Join(root, rel))
		b, err := os.ReadFile(filepath.Join("../../testdata/blobs-fixture", rel))
		if err != nil || !bytes.Equal(a, b) {
			t.Fatal("layout/content differs", rel)
		}
		// Idempotent put onto Node-written blob.
		if err := s.Put(ctx, blobstore.PutInput{Hash: m.Hash, Body: strings.NewReader("zzz"), Size: int64(len(m.Content))}); err != nil {
			t.Fatal(err)
		}
	}
}
