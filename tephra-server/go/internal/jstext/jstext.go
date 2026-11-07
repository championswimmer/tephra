// Package jstext reproduces the handful of JavaScript string semantics that the
// Markdown and link-resolution ports depend on (String.prototype.trim,
// toLowerCase, localeCompare, normalize and the regular-expression \s class).
package jstext

import (
	"strings"
	"sync"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/collate"
	"golang.org/x/text/language"
	"golang.org/x/text/unicode/norm"
)

// SpaceClass is the body of a regexp character class equal to JavaScript's \s.
const SpaceClass = `\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}`

// Dot is the JavaScript `.` (without the s flag) as an RE2 expression.
const Dot = `[^\n\r\x{2028}\x{2029}]`

// IsSpace reports whether r matches JavaScript's \s (WhiteSpace or LineTerminator).
func IsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// Trim is String.prototype.trim.
func Trim(s string) string { return strings.TrimFunc(s, IsSpace) }

// NFC is String.prototype.normalize("NFC").
func NFC(s string) string { return norm.NFC.String(s) }

var (
	collator   = collate.New(language.Und)
	collatorMu sync.Mutex // a collate.Collator keeps iterator state and is not goroutine-safe
)

// LocaleCompare approximates String.prototype.localeCompare (ICU root collation).
// It is safe for concurrent use.
func LocaleCompare(a, b string) int {
	collatorMu.Lock()
	defer collatorMu.Unlock()
	return collator.CompareString(a, b)
}

func isCased(r rune) bool {
	return unicode.IsUpper(r) || unicode.IsLower(r) || unicode.IsTitle(r) ||
		unicode.Is(unicode.Other_Lowercase, r) || unicode.Is(unicode.Other_Uppercase, r)
}

func isCaseIgnorable(r rune) bool {
	if unicode.In(r, unicode.Mn, unicode.Me, unicode.Cf, unicode.Lm, unicode.Sk) {
		return true
	}
	switch r {
	case '\'', '.', ':', 0xb7, 0x387, 0x55f, 0x5f4, 0x2018, 0x2019, 0x2024, 0x2027, 0xfe13, 0xfe52, 0xfe55, 0xff07, 0xff0e, 0xff1a:
		return true
	}
	return false
}

// Lower is String.prototype.toLowerCase / toLocaleLowerCase (en-US): full
// Unicode lowercase mapping, including U+0130 and the final-sigma rule.
func Lower(s string) string {
	ascii := true
	for i := 0; i < len(s); i++ {
		if s[i] >= utf8.RuneSelf {
			ascii = false
			break
		}
	}
	if ascii {
		return strings.ToLower(s)
	}
	runes := []rune(s)
	var b strings.Builder
	for i, r := range runes {
		switch r {
		case 0x130:
			b.WriteString("i̇")
		case 0x3a3:
			if finalSigma(runes, i) {
				b.WriteRune(0x3c2)
			} else {
				b.WriteRune(0x3c3)
			}
		default:
			b.WriteRune(unicode.ToLower(r))
		}
	}
	return b.String()
}

func finalSigma(runes []rune, i int) bool {
	before := false
	for j := i - 1; j >= 0; j-- {
		if isCaseIgnorable(runes[j]) {
			continue
		}
		before = isCased(runes[j])
		break
	}
	if !before {
		return false
	}
	for j := i + 1; j < len(runes); j++ {
		if isCaseIgnorable(runes[j]) {
			continue
		}
		return !isCased(runes[j])
	}
	return true
}

// DecodeURIComponent is decodeURIComponent; ok is false where JS would throw.
func DecodeURIComponent(s string) (string, bool) {
	if !strings.Contains(s, "%") {
		return s, true
	}
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c != '%' {
			out = append(out, c)
			continue
		}
		if i+2 >= len(s) {
			return "", false
		}
		h, l := unhex(s[i+1]), unhex(s[i+2])
		if h < 0 || l < 0 {
			return "", false
		}
		out = append(out, byte(h<<4|l))
		i += 2
	}
	if !utf8.Valid(out) {
		return "", false
	}
	return string(out), true
}

func unhex(c byte) int {
	switch {
	case c >= '0' && c <= '9':
		return int(c - '0')
	case c >= 'a' && c <= 'f':
		return int(c-'a') + 10
	case c >= 'A' && c <= 'F':
		return int(c-'A') + 10
	}
	return -1
}
