package markdown

import (
	"bytes"
	"encoding/json"
	"os"
	"reflect"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/linkresolver"
)

type vectorFile struct {
	VaultFiles []linkresolver.VaultPathEntry `json:"vaultFiles"`
	Vectors    []struct {
		Markdown   string `json:"markdown"`
		SourcePath string `json:"sourcePath"`
		Mode       string `json:"mode"`
		Expected   struct {
			OK    json.RawMessage `json:"ok"`
			Error string          `json:"error"`
		} `json:"expected"`
	} `json:"vectors"`
}

// topLevelKeys returns the key order of a JSON object.
func topLevelKeys(t *testing.T, raw []byte) []string {
	t.Helper()
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		t.Fatalf("not an object: %s", raw)
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			t.Fatal(err)
		}
		keys = append(keys, tok.(string))
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			t.Fatal(err)
		}
	}
	return keys
}

func subObject(t *testing.T, raw []byte, key string) []byte {
	t.Helper()
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatal(err)
	}
	return m[key]
}

// TestTypeScriptVectors compares ParseNote/RenderMarkdown with outputs
// generated from packages/markdown (see internal/testdata/gen-markdown-vectors.mjs).
func TestTypeScriptVectors(t *testing.T) {
	raw, err := os.ReadFile("../testdata/markdown-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vf vectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatal(err)
	}
	if len(vf.Vectors) < 1000 {
		t.Fatalf("too few vectors: %d", len(vf.Vectors))
	}
	index := linkresolver.CreateVaultPathIndex(vf.VaultFiles)
	failures := 0
	fail := func(i int, format string, args ...any) {
		failures++
		if failures <= 8 {
			t.Errorf("vector %d (%q, mode %s): "+format, append([]any{i, vf.Vectors[i].Markdown, vf.Vectors[i].Mode}, args...)...)
		}
	}
	for i, v := range vf.Vectors {
		opts := RenderOptions{Markdown: v.Markdown, SourcePath: v.SourcePath}
		if v.Mode == "index" {
			opts.VaultIndex = index
			opts.AttachmentURL = func(id string) string { return "/files/" + id + "?x=1&y=<2>" }
		}
		note, err := RenderMarkdown(opts)
		if v.Expected.Error != "" {
			if err == nil {
				fail(i, "expected error %s, got none", v.Expected.Error)
			}
			continue
		}
		if err != nil {
			fail(i, "unexpected error %v", err)
			continue
		}
		got, err := json.Marshal(note)
		if err != nil {
			t.Fatal(err)
		}
		var want, have any
		if err := json.Unmarshal(v.Expected.OK, &want); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(got, &have); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(want, have) {
			fail(i, "mismatch\n got %s\nwant %s", got, v.Expected.OK)
			continue
		}
		wantKeys := topLevelKeys(t, subObject(t, v.Expected.OK, "frontmatter"))
		if gotKeys := topLevelKeys(t, subObject(t, got, "frontmatter")); !reflect.DeepEqual(wantKeys, gotKeys) && len(wantKeys)+len(gotKeys) > 0 {
			fail(i, "frontmatter key order %v != %v", gotKeys, wantKeys)
		}
		if !reflect.DeepEqual(topLevelKeys(t, v.Expected.OK), topLevelKeys(t, got)) {
			fail(i, "result key order differs")
		}
	}
	if failures > 8 {
		t.Errorf("%d more failures", failures-8)
	}
}
