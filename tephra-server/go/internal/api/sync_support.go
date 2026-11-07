package api

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"hash"
	"io"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
)

// syncProtocolFields returns the protocolVersion / minimumPluginVersion pair
// every sync response carries.
func syncProtocolFields() (protocolVersion, minimumPluginVersion *string) {
	return strPtr(protocol.ProtocolVersion), strPtr(protocol.MinimumPluginVersion)
}

// verifyManifest rejects a manifest whose canonical hash differs from the
// declared one (400 INVALID_MANIFEST).
func verifyManifest(files []protocol.SyncManifestEntry, manifestHash string) error {
	h, err := protocol.HashManifest(files)
	if err != nil {
		return err
	}
	if h != manifestHash {
		return httpx.Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Manifest hash does not match its canonical contents.")
	}
	return nil
}

// uniqueByHash mirrors `new Map(files.map(f => [f.hash, f])).values()`: first
// insertion order, last value wins.
func uniqueByHash(files []protocol.SyncManifestEntry) []protocol.SyncManifestEntry {
	pos := map[string]int{}
	var out []protocol.SyncManifestEntry
	for _, f := range files {
		if i, ok := pos[f.Hash]; ok {
			out[i] = f
			continue
		}
		pos[f.Hash] = len(out)
		out = append(out, f)
	}
	return out
}

// requireBlobs fails with 409 BLOB_MISSING unless every referenced blob has
// metadata of the right size and exists in the blob store.
func requireBlobs(ctx context.Context, blobs db.BlobRepository, store blobstore.Store, files []protocol.SyncManifestEntry) error {
	unique := uniqueByHash(files)
	hashes := make([]string, len(unique))
	for i, f := range unique {
		hashes[i] = f.Hash
	}
	found, err := blobs.FindByHashes(ctx, hashes)
	if err != nil {
		return err
	}
	meta := map[string]int64{}
	for _, b := range found {
		meta[b.Hash] = b.Size
	}
	for _, f := range unique {
		size, ok := meta[f.Hash]
		has := false
		if ok && size == f.Size {
			if has, err = store.Has(ctx, f.Hash); err != nil {
				return err
			}
		}
		if !ok || size != f.Size || !has {
			return httpx.Fail(http.StatusConflict, protocol.CodeBlobMissing, fmt.Sprintf("Required blob %s is missing or has the wrong size.", f.Hash))
		}
	}
	return nil
}

var (
	jsDecimalRE = regexp.MustCompile(`^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$`)
	jsRadixRE   = regexp.MustCompile(`^0(?:[xX][0-9a-fA-F]+|[oO][0-7]+|[bB][01]+)$`)
)

// jsNumber mimics JS Number(string): ok is false for NaN.
func jsNumber(s string) (float64, bool) {
	s = jstext.Trim(s)
	switch {
	case s == "":
		return 0, true
	case jsDecimalRE.MatchString(s):
		f, err := strconv.ParseFloat(s, 64)
		if err != nil && !math.IsInf(f, 0) {
			return 0, false
		}
		return f, true
	case jsRadixRE.MatchString(s):
		base := map[byte]int{'x': 16, 'X': 16, 'o': 8, 'O': 8, 'b': 2, 'B': 2}[s[1]]
		f := 0.0
		for _, c := range s[2:] {
			d, _ := strconv.ParseInt(string(c), base, 32)
			f = f*float64(base) + float64(d)
		}
		return f, true
	case s == "Infinity" || s == "+Infinity":
		return math.Inf(1), true
	case s == "-Infinity":
		return math.Inf(-1), true
	}
	return 0, false
}

// jsSafeInteger converts a JS number to int64 when Number.isSafeInteger.
func jsSafeInteger(f float64, ok bool) (int64, bool) {
	if !ok || f != math.Trunc(f) || math.Abs(f) > 9007199254740991 {
		return 0, false
	}
	return int64(f), true
}

// declaredSize reads the size an upload declares: the named header if present,
// else Content-Length (TS: Number(header) with Number(undefined) = NaN).
func declaredSize(r *http.Request, header string) (int64, bool) {
	if vs := r.Header.Values(header); len(vs) > 0 {
		return jsSafeInteger(jsNumber(strings.Join(vs, ", ")))
	}
	if vs := r.Header.Values("Content-Length"); len(vs) > 0 {
		return jsSafeInteger(jsNumber(strings.Join(vs, ", ")))
	}
	if r.ContentLength >= 0 && r.Body != nil && r.Body != http.NoBody {
		return r.ContentLength, true
	}
	return 0, false
}

// verifyReader streams a body while counting bytes (at most limit+1) and
// hashing them, so uploads are verified without ever buffering the blob.
type verifyReader struct {
	r    io.Reader
	h    hash.Hash
	n    int64
	eof  bool
	want int64
}

func newVerifyReader(r io.Reader, want int64) *verifyReader {
	return &verifyReader{r: io.LimitReader(r, want+1), h: sha256.New(), want: want}
}

func (v *verifyReader) Read(p []byte) (int, error) {
	n, err := v.r.Read(p)
	if n > 0 {
		v.h.Write(p[:n])
		v.n += int64(n)
	}
	if err == io.EOF {
		v.eof = true
	}
	return n, err
}

// finish drains whatever the consumer left unread.
func (v *verifyReader) finish() error {
	if v.eof {
		return nil
	}
	_, err := io.Copy(io.Discard, v)
	return err
}

func (v *verifyReader) sum() string { return hex.EncodeToString(v.h.Sum(nil)) }

// blobMismatch maps blob-store verification errors to wire errors.
func blobMismatch(err error) error {
	switch err {
	case blobstore.ErrSizeMismatch:
		return httpx.Fail(http.StatusBadRequest, protocol.CodeBlobHashMismatch, "Uploaded size does not match the declared size.")
	case blobstore.ErrHashMismatch:
		return httpx.Fail(http.StatusBadRequest, protocol.CodeBlobHashMismatch, "Uploaded content does not match the declared SHA-256 hash.")
	}
	return err
}

// spool receives a request body of at most `declared` bytes, hashing it as it
// arrives. Small bodies stay in memory; large ones spill to a temp file so the
// full content is never held on the heap.
type spool struct {
	mem  []byte
	file *os.File
	size int64
	sum  string
}

const spoolMemory = 1 << 20

func newSpool(src io.Reader, declared int64) (*spool, error) {
	s := &spool{}
	h := sha256.New()
	buf := make([]byte, 32*1024)
	limited := io.LimitReader(src, declared+1)
	for {
		n, err := limited.Read(buf)
		if n > 0 {
			h.Write(buf[:n])
			s.size += int64(n)
			if s.file == nil && s.size > spoolMemory {
				f, ferr := os.CreateTemp("", "tephra-spool-*")
				if ferr != nil {
					return nil, ferr
				}
				s.file = f
				if _, werr := f.Write(s.mem); werr != nil {
					s.close()
					return nil, werr
				}
				s.mem = nil
			}
			if s.file != nil {
				if _, werr := s.file.Write(buf[:n]); werr != nil {
					s.close()
					return nil, werr
				}
			} else {
				s.mem = append(s.mem, buf[:n]...)
			}
		}
		if err == io.EOF {
			break
		}
		if err != nil {
			s.close()
			return nil, err
		}
	}
	s.sum = hex.EncodeToString(h.Sum(nil))
	return s, nil
}

// reader returns a fresh reader over the spooled content.
func (s *spool) reader() (io.Reader, error) {
	if s.file == nil {
		return bytes.NewReader(s.mem), nil
	}
	return io.NewSectionReader(s.file, 0, s.size), nil
}

// bytes loads the whole content (only for small, text-bounded uses).
func (s *spool) bytes() ([]byte, error) {
	if s.file == nil {
		return s.mem, nil
	}
	return io.ReadAll(io.NewSectionReader(s.file, 0, s.size))
}

func (s *spool) close() {
	if s.file != nil {
		name := s.file.Name()
		_ = s.file.Close()
		_ = os.Remove(name)
		s.file = nil
	}
}
