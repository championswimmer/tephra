// Package protocol ports tephra-server/packages/protocol: wire DTOs, their
// validation (equivalent to the zod schemas), the canonical manifest JSON and
// manifest hash, error codes and version negotiation. It is browser-safe in
// spirit (no I/O) and must stay byte-compatible with the TS implementation.
package protocol

import (
	"strings"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

// MaxSafeInteger is JavaScript's Number.MAX_SAFE_INTEGER; every protocol
// integer is bounded by it.
const MaxSafeInteger int64 = 1<<53 - 1

// IsSHA256Hex reports whether s matches /^[a-f0-9]{64}$/.
func IsSHA256Hex(s string) bool {
	if len(s) != 64 {
		return false
	}
	for i := 0; i < 64; i++ {
		c := s[i]
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

// IsCanonicalVaultPath mirrors isCanonicalVaultPath: non-empty, relative, no
// backslash or NUL, NFC-normalised, valid Unicode scalar values, and no empty,
// "." or ".." segments.
func IsCanonicalVaultPath(path string) bool {
	if path == "" || strings.HasPrefix(path, "/") || strings.ContainsAny(path, "\\\x00") {
		return false
	}
	if !utf8.ValidString(path) || !norm.NFC.IsNormalString(path) {
		return false
	}
	for _, seg := range strings.Split(path, "/") {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
	}
	return true
}

// utf16Len returns the JavaScript string length (UTF-16 code units) of s.
func utf16Len(s string) int {
	n := 0
	for _, r := range s {
		if r > 0xffff {
			n += 2
		} else {
			n++
		}
	}
	return n
}

// validInt reports whether n is a non-negative safe integer.
func validNonNegInt(n int64) bool { return n >= 0 && n <= MaxSafeInteger }

// validPositiveInt reports whether n is a positive safe integer.
func validPositiveInt(n int64) bool { return n > 0 && n <= MaxSafeInteger }
