package sqlite

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/db"
)

// TestOpensNodeCreatedFixture opens a database created by the TS adapter
// (testdata/gen-fixture.mjs; user_version 7) and checks that every table reads
// back identically to what the TS implementation returned.
func TestOpensNodeCreatedFixture(t *testing.T) {
	dir := t.TempDir()
	raw, err := os.ReadFile(filepath.Join("testdata", "fixture.db"))
	must(t, err)
	path := filepath.Join(dir, "tephra.db")
	must(t, os.WriteFile(path, raw, 0o600))
	d, err := Open(path)
	must(t, err)
	defer d.Close()

	var expected map[string]json.RawMessage
	exp, err := os.ReadFile(filepath.Join("testdata", "fixture.expected.json"))
	must(t, err)
	must(t, json.Unmarshal(exp, &expected))

	check := func(key string, got any) {
		t.Helper()
		b, err := json.Marshal(got)
		must(t, err)
		var g, w any
		must(t, json.Unmarshal(b, &g))
		must(t, json.Unmarshal(expected[key], &w))
		if !reflect.DeepEqual(g, w) {
			t.Errorf("%s mismatch\n got: %s\nwant: %s", key, b, expected[key])
		}
	}
	h := func(c string) string { return string(append([]byte(nil), []byte(hash(c))...)) }

	u1, _ := d.Users().FindByEmail(ctx, "one@example.com")
	u2, _ := d.Users().FindByEmail(ctx, "two@example.com")
	check("users", []any{u1, u2})
	n, err := d.Users().Count(ctx)
	must(t, err)
	check("userCount", n)
	check("session", mustVal(d.Sessions().FindByID(ctx, "session-1")))
	check("vaults", mustVal(d.Vaults().ListByOwner(ctx, "user-1")))
	check("devices", mustVal(d.Devices().ListByUser(ctx, "user-1")))
	toks := mustVal(d.ApiTokens().ListByVault(ctx, "vault-1"))
	global := mustVal(d.ApiTokens().FindByTokenHash(ctx, "hash-2"))
	check("tokens", append(append([]any{}, anySlice(toks)...), global))
	check("blobs", mustVal(d.Blobs().FindByHashes(ctx, []string{h("c"), h("a"), h("b"), "missing"})))
	check("files", mustVal(d.VaultFiles().ListByVault(ctx, "vault-1")))
	check("fileFold", mustVal(d.VaultFiles().FindByPathFold(ctx, "vault-1", "notes/ünï.md")))
	check("revisions", mustVal(d.VaultRevisions().List(ctx, "vault-1")))
	check("latestByManifest", mustVal(d.VaultRevisions().FindByManifestHash(ctx, "vault-1", "m1")))
	check("versions", mustVal(d.FileVersions().ListSince(ctx, "vault-1", 0, 100)))
	check("metadata", mustVal(d.NoteIndex().ListMetadata(ctx, "vault-1")))
	check("links", mustVal(d.NoteIndex().ListLinks(ctx, "vault-1")))
	check("state", mustVal(d.NoteIndex().GetState(ctx, "vault-1")))
	check("graph", mustVal(d.GraphCache().Find(ctx, "vault-1")))
	check("obsidian", mustVal(d.ObsidianSync().List(ctx)))
	code, err := d.OAuthCodes().Consume(ctx, "code-1")
	must(t, err)
	check("oauthCode", code)

	var _ db.OAuthCode
	// A write on the migrated-in-place database works (WAL conversion included).
	must(t, d.Sessions().Delete(ctx, "session-1"))
}

func mustVal[T any](v T, err error) T {
	if err != nil {
		panic(err)
	}
	return v
}

func anySlice[T any](in []T) []any {
	out := make([]any, len(in))
	for i, v := range in {
		out[i] = v
	}
	return out
}
