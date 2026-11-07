// Package auth ports tephra-server/packages/auth: scrypt password hashing
// (wire-compatible with the Node implementation), opaque tokens and cookies.
package auth

import (
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"golang.org/x/crypto/scrypt"
)

const (
	tokenBytes     = 32
	scryptKeyLen   = 32
	scryptN        = 16384
	scryptR        = 8
	scryptP        = 1
	scryptSaltSize = 16
)

var b64 = base64.RawURLEncoding

// ScryptPasswordHasher hashes as "scrypt$N$r$p$salt$digest" (base64url, unpadded).
type ScryptPasswordHasher struct{}

// Hash returns an encoded hash of password using a fresh random salt.
func (ScryptPasswordHasher) Hash(password string) (string, error) {
	salt := make([]byte, scryptSaltSize)
	if _, err := rand.Read(salt); err != nil {
		return "", err
	}
	derived, err := scrypt.Key([]byte(password), salt, scryptN, scryptR, scryptP, scryptKeyLen)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("scrypt$%d$%d$%d$%s$%s", scryptN, scryptR, scryptP, b64.EncodeToString(salt), b64.EncodeToString(derived)), nil
}

// Verify reports whether password matches encoded. Malformed input yields false.
func (ScryptPasswordHasher) Verify(password, encoded string) bool {
	parts := strings.Split(encoded, "$")
	if len(parts) != 6 || parts[0] != "scrypt" {
		return false
	}
	n, e1 := strconv.Atoi(parts[1])
	r, e2 := strconv.Atoi(parts[2])
	p, e3 := strconv.Atoi(parts[3])
	if e1 != nil || e2 != nil || e3 != nil || n != scryptN || r != scryptR || p != scryptP || parts[4] == "" || parts[5] == "" {
		return false
	}
	salt, err := b64.DecodeString(parts[4])
	if err != nil {
		return false
	}
	expected, err := b64.DecodeString(parts[5])
	if err != nil || len(expected) != scryptKeyLen {
		return false
	}
	actual, err := scrypt.Key([]byte(password), salt, n, r, p, len(expected))
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(actual, expected) == 1
}

// CreateOpaqueToken returns prefix_<base64url(32 random bytes)>. Empty prefix means "tph".
func CreateOpaqueToken(prefix string) (string, error) {
	if prefix == "" {
		prefix = "tph"
	}
	buf := make([]byte, tokenBytes)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return prefix + "_" + b64.EncodeToString(buf), nil
}

// HashOpaqueToken returns the lowercase hex SHA-256 of token (the stored form).
func HashOpaqueToken(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// ConstantTimeSecretEqual compares two secrets in constant time (via SHA-256 digests).
func ConstantTimeSecretEqual(left, right string) bool {
	l := sha256.Sum256([]byte(left))
	r := sha256.Sum256([]byte(right))
	return subtle.ConstantTimeCompare(l[:], r[:]) == 1
}

// SessionCookieOptions mirrors the TS options. Secure defaults to true; Name to tephra_session;
// MaxAgeSeconds nil means no Max-Age attribute.
type SessionCookieOptions struct {
	Insecure      bool
	Name          string
	MaxAgeSeconds *int
}

// ParseCookies parses a Cookie header, ignoring malformed entries (later duplicates win, as in TS).
func ParseCookies(header string) map[string]string {
	result := map[string]string{}
	for _, item := range strings.Split(header, ";") {
		sep := strings.Index(item, "=")
		if sep < 1 {
			continue
		}
		name := strings.TrimSpace(item[:sep])
		value, err := url.PathUnescape(strings.TrimSpace(item[sep+1:]))
		if err != nil {
			continue
		}
		result[name] = value
	}
	return result
}

// escapeComponent mimics JS encodeURIComponent (unreserved: A-Za-z0-9 -_.!~*'()).
func escapeComponent(s string) string {
	const keep = "-_.!~*'()"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || strings.IndexByte(keep, c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}

// SessionCookie builds the Set-Cookie value for a session token.
func SessionCookie(token string, o SessionCookieOptions) string {
	name := o.Name
	if name == "" {
		name = "tephra_session"
	}
	secure := "; Secure"
	if o.Insecure {
		secure = ""
	}
	maxAge := ""
	if o.MaxAgeSeconds != nil {
		maxAge = fmt.Sprintf("; Max-Age=%d", *o.MaxAgeSeconds)
	}
	return name + "=" + escapeComponent(token) + "; Path=/; HttpOnly; SameSite=Lax" + secure + maxAge
}

// ClearSessionCookie builds a Set-Cookie value that expires the session cookie.
func ClearSessionCookie(o SessionCookieOptions) string {
	zero := 0
	o.MaxAgeSeconds = &zero
	return SessionCookie("", o)
}
