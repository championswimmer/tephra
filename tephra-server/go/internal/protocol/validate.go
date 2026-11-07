package protocol

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"sort"
	"strconv"
	"strings"
)

// Issue is a single validation failure (like a zod issue).
type Issue struct {
	Path    string `json:"path"`
	Message string `json:"message"`
}

// ValidationError is returned by every Parse*/Validate* function when the
// input would be rejected by the corresponding zod schema.
type ValidationError struct {
	Issues []Issue
}

func (e *ValidationError) Error() string {
	parts := make([]string, 0, len(e.Issues))
	for _, i := range e.Issues {
		if i.Path == "" {
			parts = append(parts, i.Message)
		} else {
			parts = append(parts, i.Path+": "+i.Message)
		}
	}
	return strings.Join(parts, "; ")
}

// checker accumulates issues.
type checker struct{ issues []Issue }

func (c *checker) add(path, format string, args ...any) {
	c.issues = append(c.issues, Issue{Path: path, Message: fmt.Sprintf(format, args...)})
}

func (c *checker) err() error {
	if len(c.issues) == 0 {
		return nil
	}
	return &ValidationError{Issues: c.issues}
}

func join(path, key string) string {
	if path == "" {
		return key
	}
	return path + "." + key
}

func idx(path string, i int) string { return fmt.Sprintf("%s[%d]", path, i) }

// decodeJSON parses data like JSON.parse: standard grammar, numbers kept as
// json.Number, trailing data rejected. Strings holding unpaired UTF-16
// surrogate escapes (which Go would silently turn into U+FFFD, but which the
// TS path check rejects) fail the whole document.
func decodeJSON(data []byte) (any, error) {
	if hasLoneSurrogateEscape(data) {
		return nil, &ValidationError{Issues: []Issue{{Message: "JSON contains an unpaired surrogate escape."}}}
	}
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, &ValidationError{Issues: []Issue{{Message: "Invalid JSON."}}}
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, &ValidationError{Issues: []Issue{{Message: "Invalid JSON."}}}
	}
	return v, nil
}

func hex4(b []byte) (int, bool) {
	if len(b) < 4 {
		return 0, false
	}
	n := 0
	for i := 0; i < 4; i++ {
		c := b[i]
		var d int
		switch {
		case c >= '0' && c <= '9':
			d = int(c - '0')
		case c >= 'a' && c <= 'f':
			d = int(c-'a') + 10
		case c >= 'A' && c <= 'F':
			d = int(c-'A') + 10
		default:
			return 0, false
		}
		n = n<<4 | d
	}
	return n, true
}

func hasLoneSurrogateEscape(data []byte) bool {
	inStr := false
	for i := 0; i < len(data); i++ {
		c := data[i]
		if !inStr {
			if c == '"' {
				inStr = true
			}
			continue
		}
		if c == '"' {
			inStr = false
			continue
		}
		if c != '\\' {
			continue
		}
		i++
		if i >= len(data) || data[i] != 'u' {
			continue
		}
		cu, ok := hex4(data[i+1:])
		if !ok {
			return false // invalid JSON; the decoder reports it
		}
		i += 4
		switch {
		case cu >= 0xd800 && cu <= 0xdbff:
			if i+6 < len(data) && data[i+1] == '\\' && data[i+2] == 'u' {
				if lo, ok := hex4(data[i+3:]); ok && lo >= 0xdc00 && lo <= 0xdfff {
					i += 6
					continue
				}
			}
			return true
		case cu >= 0xdc00 && cu <= 0xdfff:
			return true
		}
	}
	return false
}

// obj asserts v is a JSON object and (strict) that it only has the allowed keys.
func (c *checker) obj(v any, path string, allowed ...string) map[string]any {
	m, ok := v.(map[string]any)
	if !ok {
		c.add(path, "Expected object.")
		return nil
	}
	set := make(map[string]struct{}, len(allowed))
	for _, k := range allowed {
		set[k] = struct{}{}
	}
	var unknown []string
	for k := range m {
		if _, ok := set[k]; !ok {
			unknown = append(unknown, k)
		}
	}
	sort.Strings(unknown)
	for _, k := range unknown {
		c.add(path, "Unrecognized key: %q.", k)
	}
	return m
}

// get returns (value, present). A missing required key records an issue.
func (c *checker) get(m map[string]any, key, path string, required bool) (any, bool) {
	if m == nil {
		return nil, false
	}
	v, ok := m[key]
	if !ok && required {
		c.add(join(path, key), "Required.")
	}
	return v, ok
}

func (c *checker) str(m map[string]any, key, path string, required bool, minLen, maxLen int) (string, bool) {
	v, ok := c.get(m, key, path, required)
	if !ok {
		return "", false
	}
	p := join(path, key)
	s, isStr := v.(string)
	if !isStr {
		c.add(p, "Expected string.")
		return "", false
	}
	n := utf16Len(s)
	if n < minLen || (maxLen > 0 && n > maxLen) {
		c.add(p, "String length out of range.")
	}
	return s, true
}

func (c *checker) boolean(m map[string]any, key, path string, required bool) (bool, bool) {
	v, ok := c.get(m, key, path, required)
	if !ok {
		return false, false
	}
	b, isBool := v.(bool)
	if !isBool {
		c.add(join(path, key), "Expected boolean.")
	}
	return b, true
}

func (c *checker) enum(m map[string]any, key, path string, required bool, allowed ...string) (string, bool) {
	v, ok := c.get(m, key, path, required)
	if !ok {
		return "", false
	}
	s, isStr := v.(string)
	if isStr {
		for _, a := range allowed {
			if a == s {
				return s, true
			}
		}
	}
	c.add(join(path, key), "Invalid enum value.")
	return "", true
}

func (c *checker) literal(m map[string]any, key, path, want string) {
	if v, ok := c.get(m, key, path, true); ok {
		if s, isStr := v.(string); !isStr || s != want {
			c.add(join(path, key), "Invalid literal value.")
		}
	}
}

// safeInt validates a JSON number as a safe integer; positive selects >0
// instead of >=0. It follows JS number semantics (1.0 and 1e3 are integers).
func (c *checker) safeInt(m map[string]any, key, path string, required, positive bool) (int64, bool) {
	v, ok := c.get(m, key, path, required)
	if !ok {
		return 0, false
	}
	p := join(path, key)
	n, isNum := v.(json.Number)
	if !isNum {
		c.add(p, "Expected number.")
		return 0, true
	}
	f, err := parseJSNumber(n)
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) || f != math.Trunc(f) || math.Abs(f) > float64(MaxSafeInteger) {
		c.add(p, "Expected a safe integer.")
		return 0, true
	}
	i := int64(f)
	if (positive && i <= 0) || (!positive && i < 0) {
		c.add(p, "Number out of range.")
	}
	return i, true
}

func parseJSNumber(n json.Number) (float64, error) {
	return strconv.ParseFloat(string(n), 64)
}

func (c *checker) arr(m map[string]any, key, path string, required bool) ([]any, bool) {
	v, ok := c.get(m, key, path, required)
	if !ok {
		return nil, false
	}
	a, isArr := v.([]any)
	if !isArr {
		c.add(join(path, key), "Expected array.")
		return nil, true
	}
	return a, true
}

// shared field checks reused by typed validators.

func (c *checker) checkIdentifier(path, s string) {
	if s == "" {
		c.add(path, "String must contain at least 1 character.")
	}
}

func (c *checker) checkPath(path, s string) {
	if !IsCanonicalVaultPath(s) {
		c.add(path, "Path must be a canonical vault-relative path.")
	}
}

func (c *checker) checkSHA(path, s string) {
	if !IsSHA256Hex(s) {
		c.add(path, "Expected a lowercase SHA-256 hex digest.")
	}
}

func (c *checker) checkNonNeg(path string, n int64) {
	if !validNonNegInt(n) {
		c.add(path, "Expected a non-negative safe integer.")
	}
}

func (c *checker) checkKind(path, s string) {
	if s != "markdown" && s != "attachment" {
		c.add(path, "Invalid enum value.")
	}
}
