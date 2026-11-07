package auth

import (
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
)

func TestHashAndVerify(t *testing.T) {
	h := ScryptPasswordHasher{}
	a, _ := h.Hash("correct horse battery staple")
	b, _ := h.Hash("correct horse battery staple")
	if a == b || strings.Contains(a, "correct horse") {
		t.Fatal("hash must be salted and not contain password")
	}
	if !h.Verify("correct horse battery staple", a) || h.Verify("wrong password", a) || h.Verify("anything", "malformed") {
		t.Fatal("verify mismatch")
	}
	for _, bad := range []string{"scrypt$1$8$1$AA$AA", "scrypt$16384$8$1$$AA", "scrypt$16384$8$1$AA$AA", "x$16384$8$1$AA$AA", "scrypt$x$8$1$AA$AA"} {
		if h.Verify("p", bad) {
			t.Fatalf("accepted %q", bad)
		}
	}
}

func TestTokens(t *testing.T) {
	tok, _ := CreateOpaqueToken("test")
	if !regexp.MustCompile(`^test_[A-Za-z0-9_-]+$`).MatchString(tok) {
		t.Fatal(tok)
	}
	if !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(HashOpaqueToken(tok)) || HashOpaqueToken(tok) != HashOpaqueToken(tok) {
		t.Fatal("hash")
	}
	if d, _ := CreateOpaqueToken(""); !strings.HasPrefix(d, "tph_") {
		t.Fatal(d)
	}
	if !ConstantTimeSecretEqual("same", "same") || ConstantTimeSecretEqual("same", "different") {
		t.Fatal("ct")
	}
}

func TestCookies(t *testing.T) {
	c := SessionCookie("secret", SessionCookieOptions{})
	for _, w := range []string{"HttpOnly", "SameSite=Lax", "Secure"} {
		if !strings.Contains(c, w) {
			t.Fatal(c)
		}
	}
	if !strings.Contains(ClearSessionCookie(SessionCookieOptions{}), "Max-Age=0") {
		t.Fatal("clear")
	}
	if got := ParseCookies("a=b%20c; bad; =x; d=%zz; e=f=g")["a"]; got != "b c" {
		t.Fatal(got)
	}
}

type vectors struct {
	Scrypt  []struct{ Password, Encoded string } `json:"scrypt"`
	Tokens  []struct{ Token, Hash string }       `json:"tokens"`
	Cookies []struct {
		Token, Cookie string
	} `json:"cookies"`
}

func TestNodeVectors(t *testing.T) {
	raw, err := os.ReadFile("../testdata/auth-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vectors
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.Scrypt) == 0 || len(v.Tokens) == 0 || len(v.Cookies) == 0 {
		t.Fatal("empty vectors")
	}
	h := ScryptPasswordHasher{}
	for _, s := range v.Scrypt {
		if !h.Verify(s.Password, s.Encoded) || h.Verify(s.Password+"x", s.Encoded) {
			t.Fatalf("scrypt vector %q", s.Password)
		}
	}
	for _, k := range v.Tokens {
		if HashOpaqueToken(k.Token) != k.Hash {
			t.Fatalf("token %q", k.Token)
		}
	}
	for _, c := range v.Cookies {
		if got := SessionCookie(c.Token, SessionCookieOptions{}); got != c.Cookie {
			t.Fatalf("cookie %q != %q", got, c.Cookie)
		}
	}
}
