package linkresolver

import (
	"encoding/json"
	"os"
	"reflect"
	"testing"
)

func testIndex() *VaultPathIndex {
	return CreateVaultPathIndex([]VaultPathEntry{
		{"root-project", "Project.md", KindMarkdown},
		{"one-note", "One/Note.md", KindMarkdown},
		{"two-note", "Two/Note.md", KindMarkdown},
		{"other", "Two/Other Note.md", KindMarkdown},
		{"image", "Assets/my image.png", KindAttachment},
	})
}

func TestPrefersExactPathsAndOmittedExtension(t *testing.T) {
	idx := testIndex()
	if r := ResolveLink("One/Source.md", "Project", idx); r.Status != StatusResolved || r.TargetFileID != "root-project" {
		t.Fatalf("got %+v", r)
	}
	if r := ResolveLink("Source.md", "Two/Note.md", idx); r.Status != StatusResolved || r.TargetFileID != "two-note" {
		t.Fatalf("got %+v", r)
	}
}

func TestResolvesRelativeToSourceFolder(t *testing.T) {
	if r := ResolveLink("One/Source.md", "Note", testIndex()); r.Status != StatusResolved || r.TargetFileID != "one-note" {
		t.Fatalf("got %+v", r)
	}
}

func TestFolderProximityAndAmbiguity(t *testing.T) {
	idx := testIndex()
	if r := ResolveLink("One/Subfolder/Source.md", "Note", idx); r.Status != StatusResolved || r.TargetFileID != "one-note" {
		t.Fatalf("got %+v", r)
	}
	r := ResolveLink("Elsewhere/Source.md", "Note", idx)
	if r.Status != StatusAmbiguous || r.TargetFileID != "" || !r.Unresolved || !r.Ambiguous {
		t.Fatalf("got %+v", r)
	}
	if !reflect.DeepEqual(r.Candidates, []string{"One/Note.md", "Two/Note.md"}) {
		t.Fatalf("candidates %v", r.Candidates)
	}
}

func TestDecodesURLPathsAndPreservesSubpaths(t *testing.T) {
	idx := testIndex()
	if r := ResolveLink("One/Source.md", "Two/Other%20Note.md#Heading%20One", idx); r.TargetFileID != "other" || r.Subpath != "Heading One" {
		t.Fatalf("got %+v", r)
	}
	if r := ResolveLink("One/Source.md", "Project#%5Eblock-1", idx); r.TargetFileID != "root-project" || r.Subpath != "^block-1" {
		t.Fatalf("got %+v", r)
	}
}

func TestUnresolvedAndAttachments(t *testing.T) {
	idx := testIndex()
	if r := ResolveLink("One/Source.md", "Missing", idx); r.Status != StatusUnresolved || r.TargetFileID != "" {
		t.Fatalf("got %+v", r)
	}
	if r := ResolveLink("One/Source.md", "Assets/my%20image.png", idx); r.Status != StatusResolved || r.TargetKind != KindAttachment {
		t.Fatalf("got %+v", r)
	}
}

func TestResolvesAcrossUnicodeNormalizationForms(t *testing.T) {
	drifted := CreateVaultPathIndex([]VaultPathEntry{{"cafe", "Cafe\u0301.md", KindMarkdown}})
	if r := ResolveLink("Source.md", "Caf\u00e9", drifted); r.Status != StatusResolved || r.TargetFileID != "cafe" {
		t.Fatalf("got %+v", r)
	}
	nfc := CreateVaultPathIndex([]VaultPathEntry{{"cafe", "Caf\u00e9.md", KindMarkdown}})
	if r := ResolveLink("Source.md", "Cafe\u0301", nfc); r.Status != StatusResolved || r.TargetFileID != "cafe" {
		t.Fatalf("got %+v", r)
	}
}

type vectorFile struct {
	Indexes []struct {
		Name        string           `json:"name"`
		Files       []VaultPathEntry `json:"files"`
		SortedPaths []string         `json:"sortedPaths"`
		Cases       []struct {
			Source string          `json:"source"`
			Target string          `json:"target"`
			Result json.RawMessage `json:"result"`
		} `json:"cases"`
	} `json:"indexes"`
}

// TestTypeScriptVectors checks the Go resolver against outputs generated from
// packages/link-resolver (see internal/testdata/gen-markdown-vectors.mjs).
func TestTypeScriptVectors(t *testing.T) {
	raw, err := os.ReadFile("../testdata/linkresolver-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vf vectorFile
	if err := json.Unmarshal(raw, &vf); err != nil {
		t.Fatal(err)
	}
	if len(vf.Indexes) == 0 {
		t.Fatal("no vectors")
	}
	for _, set := range vf.Indexes {
		idx := CreateVaultPathIndex(set.Files)
		got := make([]string, len(idx.Files))
		for i, f := range idx.Files {
			got[i] = f.Path
		}
		if !reflect.DeepEqual(got, set.SortedPaths) && !(len(got) == 0 && len(set.SortedPaths) == 0) {
			t.Errorf("%s: sorted index differs\n got %q\nwant %q", set.Name, got, set.SortedPaths)
		}
		failures := 0
		for _, c := range set.Cases {
			var want, have any
			if err := json.Unmarshal(c.Result, &want); err != nil {
				t.Fatal(err)
			}
			b, err := json.Marshal(ResolveLink(c.Source, c.Target, idx))
			if err != nil {
				t.Fatal(err)
			}
			if err := json.Unmarshal(b, &have); err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(want, have) {
				failures++
				if failures <= 5 {
					t.Errorf("%s: resolve(%q, %q)\n got %s\nwant %s", set.Name, c.Source, c.Target, b, c.Result)
				}
			}
		}
		if failures > 5 {
			t.Errorf("%s: %d more failures", set.Name, failures-5)
		}
	}
}
