package vaultmodel

import (
	"fmt"
	"reflect"
	"sort"
	"testing"
)

type seqIDs struct{ n int }

func (s *seqIDs) Generate() string { s.n++; return fmt.Sprintf("version_%d", s.n) }

var current = CurrentVaultFile{FileID: "file_1", VaultID: "vault_1", Path: "A.md", BlobHash: "old", Size: 3, Mtime: 10, Kind: KindMarkdown, UpdatedRevision: 1}
var incoming = IncomingVaultFile{FileID: "file_1", Path: "A.md", BlobHash: "old", Size: 3, Mtime: 10, Kind: KindMarkdown}

func diff(prev []CurrentVaultFile, next []IncomingVaultFile) RevisionDiff {
	return DiffRevision(DiffRevisionInput{VaultID: "vault_1", Revision: 2, CreatedAt: 100, Current: prev, Incoming: next, IDs: &seqIDs{}})
}

func types(r RevisionDiff) []string {
	out := []string{}
	for _, v := range r.Versions {
		out = append(out, string(v.ChangeType))
	}
	return out
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %#v want %#v", got, want)
	}
}

func TestDetectsCreate(t *testing.T) {
	r := diff(nil, []IncomingVaultFile{incoming})
	eq(t, types(r), []string{"create"})
	eq(t, r.CreatedFileIDs, []string{"file_1"})
}

func TestDetectsModify(t *testing.T) {
	n := incoming
	n.BlobHash, n.Size = "new", 4
	eq(t, types(diff([]CurrentVaultFile{current}, []IncomingVaultFile{n})), []string{"modify"})
}

func TestDetectsRename(t *testing.T) {
	n := incoming
	n.Path = "Folder/A.md"
	r := diff([]CurrentVaultFile{current}, []IncomingVaultFile{n})
	if len(r.Versions) != 1 {
		t.Fatal(r.Versions)
	}
	v := r.Versions[0]
	if v.FileID != "file_1" || v.Path != "Folder/A.md" || v.ChangeType != ChangeRename || *v.BlobHash != "old" {
		t.Fatalf("%+v", v)
	}
}

func TestRenameAndModify(t *testing.T) {
	n := incoming
	n.Path, n.BlobHash = "B.md", "new"
	eq(t, types(diff([]CurrentVaultFile{current}, []IncomingVaultFile{n})), []string{"rename", "modify"})
}

func TestDeleteTombstone(t *testing.T) {
	r := diff([]CurrentVaultFile{current}, nil)
	v := r.Versions[0]
	if v.FileID != "file_1" || v.Path != "A.md" || v.ChangeType != ChangeDelete || v.BlobHash != nil || v.Size != nil || v.Mtime != nil {
		t.Fatalf("%+v", v)
	}
	if v.Revision != 2 || v.CreatedAt != 100 || v.VaultID != "vault_1" || v.ID != "version_1" {
		t.Fatalf("%+v", v)
	}
}

func TestNoOp(t *testing.T) {
	if !diff([]CurrentVaultFile{current}, []IncomingVaultFile{incoming}).IsNoOp {
		t.Fatal("unchanged should be no-op")
	}
	n := incoming
	n.Mtime = 11
	if !diff([]CurrentVaultFile{current}, []IncomingVaultFile{n}).IsNoOp {
		t.Fatal("mtime-only should be no-op")
	}
}

func TestWholesaleIDChange(t *testing.T) {
	c1 := current
	c1.BlobHash = "hash-a"
	c2 := CurrentVaultFile{FileID: "file_2", VaultID: "vault_1", Path: "B.md", BlobHash: "hash-b", Size: 5, Mtime: 10, Kind: KindMarkdown, UpdatedRevision: 1}
	before := []CurrentVaultFile{c1, c2}
	after := []IncomingVaultFile{
		{FileID: "file_new_1", Path: "A.md", BlobHash: "hash-a", Size: 3, Mtime: 10, Kind: KindMarkdown},
		{FileID: "file_new_2", Path: "B.md", BlobHash: "hash-b", Size: 5, Mtime: 10, Kind: KindMarkdown},
	}
	r := diff(before, after)
	if r.IsNoOp {
		t.Fatal("should not be no-op")
	}
	sort.Strings(r.DeletedFileIDs)
	sort.Strings(r.CreatedFileIDs)
	eq(t, r.DeletedFileIDs, []string{"file_1", "file_2"})
	eq(t, r.CreatedFileIDs, []string{"file_new_1", "file_new_2"})
	eq(t, r.ModifiedFileIDs, []string{})
	eq(t, r.RenamedFileIDs, []string{})
	ts := types(r)
	sort.Strings(ts)
	eq(t, ts, []string{"create", "create", "delete", "delete"})
	known := map[string]bool{"hash-a": true, "hash-b": true}
	for _, v := range r.Versions {
		if v.ChangeType == ChangeDelete {
			if v.BlobHash != nil {
				t.Fatal("delete has blob")
			}
		} else if !known[*v.BlobHash] {
			t.Fatalf("new blob %s", *v.BlobHash)
		}
	}
}

func TestEffectiveSyncMode(t *testing.T) {
	if (Vault{}).EffectiveSyncMode() != SyncModeTephra || (Vault{SyncMode: SyncModeObsidian}).EffectiveSyncMode() != SyncModeObsidian {
		t.Fatal("sync mode default")
	}
}
