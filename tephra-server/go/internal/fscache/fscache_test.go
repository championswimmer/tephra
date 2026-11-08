package fscache

import (
	"os"
	"path/filepath"
	"testing"
)

func TestDropIsSafeAndLeavesContentIntact(t *testing.T) {
	p := filepath.Join(t.TempDir(), "f")
	if err := os.WriteFile(p, []byte("hello"), 0o600); err != nil {
		t.Fatal(err)
	}
	f, err := os.Open(p)
	if err != nil {
		t.Fatal(err)
	}
	Drop(f)
	Drop(nil)
	buf := make([]byte, 5)
	if _, err := f.Read(buf); err != nil || string(buf) != "hello" {
		t.Fatalf("read after Drop = %q, %v", buf, err)
	}
	_ = f.Close()
	Drop(f) // closed file: must not panic
}
