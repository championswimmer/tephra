package markdown

import (
	"bytes"
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
)

// Frontmatter is an insertion-ordered map of parsed YAML-ish values. Values are
// bool, nil, float64, string or []any. JSON output follows JavaScript object key
// order (array-index keys ascending first, then insertion order).
type Frontmatter struct {
	keys   []string
	values map[string]any
}

// Len returns the number of keys.
func (f Frontmatter) Len() int { return len(f.keys) }

// Get returns the value for key.
func (f Frontmatter) Get(key string) (any, bool) {
	v, ok := f.values[key]
	return v, ok
}

// Keys returns the keys in JavaScript property order.
func (f Frontmatter) Keys() []string {
	out := append([]string(nil), f.keys...)
	var idx, rest []string
	for _, k := range out {
		if isArrayIndex(k) {
			idx = append(idx, k)
		} else {
			rest = append(rest, k)
		}
	}
	sort.Slice(idx, func(i, j int) bool {
		a, _ := strconv.ParseUint(idx[i], 10, 64)
		b, _ := strconv.ParseUint(idx[j], 10, 64)
		return a < b
	})
	return append(idx, rest...)
}

// Map returns a copy of the values as a plain map.
func (f Frontmatter) Map() map[string]any {
	out := make(map[string]any, len(f.values))
	for k, v := range f.values {
		out[k] = v
	}
	return out
}

func isArrayIndex(k string) bool {
	if k == "" || len(k) > 10 || (len(k) > 1 && k[0] == '0') {
		return false
	}
	for i := 0; i < len(k); i++ {
		if k[i] < '0' || k[i] > '9' {
			return false
		}
	}
	n, _ := strconv.ParseUint(k, 10, 64)
	return n < 4294967295
}

func (f *Frontmatter) set(key string, value any) {
	if key == "__proto__" { // sets the prototype in JS; never an own property
		return
	}
	if f.values == nil {
		f.values = map[string]any{}
	}
	if _, ok := f.values[key]; !ok {
		f.keys = append(f.keys, key)
	}
	f.values[key] = value
}

// MarshalJSON emits an object with JavaScript key ordering and no HTML escaping.
func (f Frontmatter) MarshalJSON() ([]byte, error) {
	var buf bytes.Buffer
	buf.WriteByte('{')
	for i, k := range f.Keys() {
		if i > 0 {
			buf.WriteByte(',')
		}
		if err := encodeJSON(&buf, k); err != nil {
			return nil, err
		}
		buf.WriteByte(':')
		if err := encodeValue(&buf, f.values[k]); err != nil {
			return nil, err
		}
	}
	buf.WriteByte('}')
	return buf.Bytes(), nil
}

func encodeJSON(buf *bytes.Buffer, v any) error {
	enc := json.NewEncoder(buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return err
	}
	buf.Truncate(buf.Len() - 1) // trailing newline
	return nil
}

func encodeValue(buf *bytes.Buffer, v any) error {
	switch t := v.(type) {
	case float64:
		if math.IsInf(t, 0) || math.IsNaN(t) {
			buf.WriteString("null")
			return nil
		}
		return encodeJSON(buf, t)
	case []any:
		buf.WriteByte('[')
		for i, item := range t {
			if i > 0 {
				buf.WriteByte(',')
			}
			if err := encodeValue(buf, item); err != nil {
				return err
			}
		}
		buf.WriteByte(']')
		return nil
	}
	return encodeJSON(buf, v)
}

var numberRe = regexp.MustCompile(`^-?(?:\d+|\d*\.\d+)$`)

func parseScalar(value string) any {
	trimmed := jstext.Trim(value)
	switch trimmed {
	case "true":
		return true
	case "false":
		return false
	case "null", "~":
		return nil
	}
	if numberRe.MatchString(trimmed) {
		n, _ := strconv.ParseFloat(trimmed, 64)
		if n == 0 {
			n = 0 // -0 serialises as 0 in JS
		}
		return n
	}
	if len(trimmed) >= 1 && ((trimmed[0] == '"' && trimmed[len(trimmed)-1] == '"') || (trimmed[0] == '\'' && trimmed[len(trimmed)-1] == '\'')) {
		if len(trimmed) < 2 {
			return ""
		}
		return trimmed[1 : len(trimmed)-1]
	}
	if len(trimmed) >= 2 && trimmed[0] == '[' && trimmed[len(trimmed)-1] == ']' {
		out := []any{}
		for _, part := range strings.Split(trimmed[1:len(trimmed)-1], ",") {
			v := parseScalar(part)
			if s, ok := v.(string); ok && s == "" {
				continue
			}
			out = append(out, v)
		}
		return out
	}
	return trimmed
}

// splitLines is markdown.split(/\r?\n/).
func splitLines(s string) []string {
	parts := strings.Split(s, "\n")
	for i := 0; i < len(parts)-1; i++ {
		parts[i] = strings.TrimSuffix(parts[i], "\r")
	}
	return parts
}

var (
	fmListRe = regexp.MustCompile(`^` + sp + `*-` + sp + `+(` + dot + `+)$`)
	fmPairRe = regexp.MustCompile(`^([\w.-]+):(?:` + sp + `*(` + dot + `*))?$`)
)

func readFrontmatter(markdown string) (fm Frontmatter, body string, offset int) {
	if !strings.HasPrefix(markdown, "---\n") && !strings.HasPrefix(markdown, "---\r\n") {
		return Frontmatter{}, markdown, 0
	}
	lines := splitLines(markdown)
	end := -1
	for i := 1; i < len(lines); i++ {
		if lines[i] == "---" || lines[i] == "..." {
			end = i
			break
		}
	}
	if end < 0 {
		return Frontmatter{}, markdown, 0
	}
	hasActive := false
	activeList := ""
	for _, line := range lines[1:end] {
		if m := fmListRe.FindStringSubmatch(line); m != nil && hasActive {
			if list, ok := fm.values[activeList].([]any); ok {
				fm.values[activeList] = append(list, parseScalar(m[1]))
			}
			continue
		}
		m := fmPairRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		key, value := m[1], m[2]
		if value == "" {
			fm.set(key, []any{})
			activeList, hasActive = key, true
		} else {
			fm.set(key, parseScalar(value))
			hasActive = false
		}
	}
	return fm, strings.Join(lines[end+1:], "\n"), end + 1
}
