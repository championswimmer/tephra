package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"sort"
	"strconv"
	"strings"
)

// SyncManifestEntry is one file in a sync manifest. MimeType nil means absent.
type SyncManifestEntry struct {
	FileID   string  `json:"fileId"`
	Path     string  `json:"path"`
	Hash     string  `json:"hash"`
	Size     int64   `json:"size"`
	Mtime    int64   `json:"mtime"`
	MimeType *string `json:"mimeType,omitempty"`
	Kind     string  `json:"kind"` // "markdown" | "attachment"
}

func (c *checker) checkEntry(path string, e SyncManifestEntry) {
	c.checkIdentifier(join(path, "fileId"), e.FileID)
	c.checkPath(join(path, "path"), e.Path)
	c.checkSHA(join(path, "hash"), e.Hash)
	c.checkNonNeg(join(path, "size"), e.Size)
	c.checkNonNeg(join(path, "mtime"), e.Mtime)
	if e.MimeType != nil && *e.MimeType == "" {
		c.add(join(path, "mimeType"), "String must contain at least 1 character.")
	}
	c.checkKind(join(path, "kind"), e.Kind)
}

// checkManifest runs the unordered-manifest refinements: entry validity and
// duplicate paths / file IDs. With sorted=true it also requires code-point
// path order (syncManifestSchema vs the unordered schema).
func (c *checker) checkManifest(path string, files []SyncManifestEntry, sorted bool) {
	paths := make(map[string]struct{}, len(files))
	ids := make(map[string]struct{}, len(files))
	for i, f := range files {
		p := idx(path, i)
		c.checkEntry(p, f)
		if _, dup := paths[f.Path]; dup {
			c.add(join(p, "path"), "Duplicate manifest path.")
		}
		if _, dup := ids[f.FileID]; dup {
			c.add(join(p, "fileId"), "Duplicate manifest file ID.")
		}
		paths[f.Path] = struct{}{}
		ids[f.FileID] = struct{}{}
	}
	if sorted {
		for i := 1; i < len(files); i++ {
			if compareCodePoints(files[i-1].Path, files[i].Path) > 0 {
				c.add(join(idx(path, i), "path"), "Manifest paths must be sorted.")
			}
		}
	}
}

// compareCodePoints orders strings by Unicode code point. For valid UTF-8
// that equals byte order.
func compareCodePoints(a, b string) int { return strings.Compare(a, b) }

func (c *checker) entryFromAny(v any, path string) SyncManifestEntry {
	var e SyncManifestEntry
	m := c.obj(v, path, "fileId", "path", "hash", "size", "mtime", "mimeType", "kind")
	if m == nil {
		return e
	}
	e.FileID, _ = c.str(m, "fileId", path, true, 1, 0)
	e.Path, _ = c.str(m, "path", path, true, 0, 0)
	e.Hash, _ = c.str(m, "hash", path, true, 0, 0)
	e.Size, _ = c.safeInt(m, "size", path, true, false)
	e.Mtime, _ = c.safeInt(m, "mtime", path, true, false)
	if s, ok := c.str(m, "mimeType", path, false, 1, 0); ok {
		e.MimeType = &s
	}
	e.Kind, _ = c.enum(m, "kind", path, true, "markdown", "attachment")
	return e
}

func (c *checker) manifestFromAny(v any, path string) []SyncManifestEntry {
	a, ok := v.([]any)
	if !ok {
		c.add(path, "Expected array.")
		return nil
	}
	out := make([]SyncManifestEntry, 0, len(a))
	for i, item := range a {
		out = append(out, c.entryFromAny(item, idx(path, i)))
	}
	return out
}

// ParseSyncManifest validates a JSON manifest (syncManifestSchema: sorted, no duplicates).
func ParseSyncManifest(data []byte) ([]SyncManifestEntry, error) {
	v, err := decodeJSON(data)
	if err != nil {
		return nil, err
	}
	var c checker
	files := c.manifestFromAny(v, "")
	if len(c.issues) == 0 {
		c.checkManifest("", files, true)
	}
	if err := c.err(); err != nil {
		return nil, err
	}
	return files, nil
}

// ValidateManifest validates typed entries against syncManifestSchema
// (sorted=true) or the unordered schema (sorted=false).
func ValidateManifest(files []SyncManifestEntry, sorted bool) error {
	var c checker
	c.checkManifest("", files, sorted)
	return c.err()
}

// jsonString reproduces JSON.stringify for a string: only `"`, `\`, and
// control characters are escaped (\b \f \n \r \t short forms, otherwise
// lowercase \u00xx). Unlike encoding/json, <, >, & and U+2028/9 are literal.
func jsonString(sb *strings.Builder, s string) {
	const hexDigits = "0123456789abcdef"
	sb.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			sb.WriteString(`\"`)
		case '\\':
			sb.WriteString(`\\`)
		case '\b':
			sb.WriteString(`\b`)
		case '\f':
			sb.WriteString(`\f`)
		case '\n':
			sb.WriteString(`\n`)
		case '\r':
			sb.WriteString(`\r`)
		case '\t':
			sb.WriteString(`\t`)
		default:
			if r < 0x20 {
				sb.WriteString(`\u00`)
				sb.WriteByte(hexDigits[r>>4])
				sb.WriteByte(hexDigits[r&0xf])
			} else {
				sb.WriteRune(r)
			}
		}
	}
	sb.WriteByte('"')
}

// CanonicalManifestJSON returns the canonical manifest JSON: entries sorted by
// code-point path with an explicit key order. It validates the (unordered)
// input first and errors on invalid or duplicate entries, like the TS parse.
func CanonicalManifestJSON(input []SyncManifestEntry) (string, error) {
	if err := ValidateManifest(input, false); err != nil {
		return "", err
	}
	sorted := append([]SyncManifestEntry(nil), input...)
	sort.SliceStable(sorted, func(i, j int) bool { return compareCodePoints(sorted[i].Path, sorted[j].Path) < 0 })
	var sb strings.Builder
	sb.WriteByte('[')
	for i, f := range sorted {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(`{"fileId":`)
		jsonString(&sb, f.FileID)
		sb.WriteString(`,"path":`)
		jsonString(&sb, f.Path)
		sb.WriteString(`,"hash":`)
		jsonString(&sb, f.Hash)
		sb.WriteString(`,"size":`)
		sb.WriteString(strconv.FormatInt(f.Size, 10))
		sb.WriteString(`,"mtime":`)
		sb.WriteString(strconv.FormatInt(f.Mtime, 10))
		if f.MimeType != nil {
			sb.WriteString(`,"mimeType":`)
			jsonString(&sb, *f.MimeType)
		}
		sb.WriteString(`,"kind":`)
		jsonString(&sb, f.Kind)
		sb.WriteByte('}')
	}
	sb.WriteByte(']')
	return sb.String(), nil
}

// SHA256Hex returns the lowercase hex SHA-256 digest of b.
func SHA256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// HashManifest is the SHA-256 hex of the UTF-8 canonical manifest JSON.
func HashManifest(input []SyncManifestEntry) (string, error) {
	j, err := CanonicalManifestJSON(input)
	if err != nil {
		return "", err
	}
	return SHA256Hex([]byte(j)), nil
}
