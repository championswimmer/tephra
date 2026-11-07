package httpx

import (
	"encoding/json"
	"math"
	"regexp"
	"sort"
	"strings"
	"unicode/utf16"

	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
)

// Schema is a tiny zod-like validator over ParseJSON output. Failures are
// collected and returned by Err as a *protocol.ValidationError (HTTP 400).
type Schema struct{ issues []protocol.Issue }

// Add records a failure.
func (s *Schema) Add(path, msg string) {
	s.issues = append(s.issues, protocol.Issue{Path: path, Message: msg})
}

// Err returns nil if no issue was recorded.
func (s *Schema) Err() error {
	if len(s.issues) == 0 {
		return nil
	}
	return &protocol.ValidationError{Issues: s.issues}
}

// StrictObject checks v is a JSON object with only the allowed keys.
func (s *Schema) StrictObject(v any, allowed ...string) map[string]any {
	m, ok := v.(map[string]any)
	if !ok {
		s.Add("", "Invalid input: expected object.")
		return nil
	}
	var extra []string
	for k := range m {
		found := false
		for _, a := range allowed {
			if a == k {
				found = true
			}
		}
		if !found {
			extra = append(extra, k)
		}
	}
	sort.Strings(extra)
	for _, k := range extra {
		s.Add(k, "Unrecognized key: \""+k+"\"")
	}
	return m
}

// UTF16Len is JS string .length.
func UTF16Len(s string) int { return len(utf16.Encode([]rune(s))) }

// String reads an optional/required string with JS-length bounds (max<0: none).
// If trim is set the value is trimmed (JS trim) before the checks. present is
// false when the key is absent (no issue recorded when !required).
func (s *Schema) String(m map[string]any, key string, required, trim bool, min, max int) (val string, present bool) {
	raw, ok := m[key]
	if !ok {
		if required {
			s.Add(key, "Invalid input: expected string, received undefined")
		}
		return "", false
	}
	str, isStr := raw.(string)
	if !isStr {
		s.Add(key, "Invalid input: expected string")
		return "", true
	}
	if trim {
		str = jstext.Trim(str)
	}
	n := UTF16Len(str)
	if n < min {
		s.Add(key, "Too small: string is too short.")
	}
	if max >= 0 && n > max {
		s.Add(key, "Too big: string is too long.")
	}
	return str, true
}

var emailRE = regexp.MustCompile(`^([A-Za-z0-9_'+\-.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`)

// IsEmail is zod 4's z.email() regex (its lookaheads done by hand).
func IsEmail(s string) bool {
	return !strings.HasPrefix(s, ".") && !strings.Contains(s, "..") && emailRE.MatchString(s)
}

// Email reads a required z.email().max(maxLen) string.
func (s *Schema) Email(m map[string]any, key string, maxLen int) string {
	v, ok := s.String(m, key, true, false, 0, maxLen)
	if ok && !IsEmail(v) {
		s.Add(key, "Invalid email address")
	}
	return v
}

// SafePositiveInt reads z.number().int().positive().safe() from a json.Number.
func (s *Schema) SafePositiveInt(path string, raw any) (int64, bool) {
	n, ok := raw.(json.Number)
	if !ok {
		s.Add(path, "Invalid input: expected number")
		return 0, false
	}
	f, err := n.Float64()
	if err != nil || math.IsInf(f, 0) || math.IsNaN(f) || f != math.Trunc(f) {
		s.Add(path, "Invalid input: expected int")
		return 0, false
	}
	if f <= 0 {
		s.Add(path, "Too small: expected number to be >0")
		return 0, false
	}
	if f > 9007199254740991 {
		s.Add(path, "Too big: expected number to be safe")
		return 0, false
	}
	return int64(f), true
}
