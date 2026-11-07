package jstext

import "testing"

func TestLower(t *testing.T) {
	cases := map[string]string{
		"ABC":      "abc",
		"ΑΣ":       "ας",
		"ΑΣ Β":     "ας β",
		"Σ":        "σ",
		"İstanbul": "i̇stanbul",
		"ΑΣ.Β":     "ασ.β",
	}
	for in, want := range cases {
		if got := Lower(in); got != want {
			t.Errorf("Lower(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestDecodeURIComponent(t *testing.T) {
	if got, ok := DecodeURIComponent("a%20b%C3%A9"); !ok || got != "a bé" {
		t.Errorf("got %q %v", got, ok)
	}
	for _, bad := range []string{"%", "%4", "%zz", "%C0%80", "%ED%A0%80", "%E0%A4%A"} {
		if _, ok := DecodeURIComponent(bad); ok {
			t.Errorf("%q should fail", bad)
		}
	}
}

func TestTrimAndSpace(t *testing.T) {
	if got := Trim("\U000000a0\U0000feff x \U00002028"); got != "x" {
		t.Errorf("got %q", got)
	}
}
