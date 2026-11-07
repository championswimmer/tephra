package api_test

import (
	"context"
	"encoding/json"
	"fmt"
	"regexp"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
)

var hash64 = regexp.MustCompile(`^[a-f0-9]{64}$`)

func getChanges(s *testutil.Session, query string) testutil.Response {
	return getAs(s, s.Token, "/api/v1/vaults/"+s.VaultID+"/changes"+query)
}

// changesOK validates the response with the protocol parser and requires status ok.
func changesOK(t *testing.T, r testutil.Response) protocol.ChangesOK {
	t.Helper()
	if r.Status != 200 {
		t.Fatalf("changes: %d %s", r.Status, r.Text())
	}
	parsed, err := protocol.ParseChangesResponse(r.Body)
	if err != nil {
		t.Fatalf("schema: %v: %s", err, r.Text())
	}
	ok, isOK := parsed.(protocol.ChangesOK)
	if !isOK {
		t.Fatalf("expected ok, got %s", r.Text())
	}
	return ok
}

func putContent(s *testutil.Session, auth testutil.Headers, fileID, text, ifMatch string, extra testutil.Headers) testutil.Response {
	h := testutil.Headers{}
	for k, v := range auth {
		h[k] = v
	}
	h["x-tephra-content-size"] = fmt.Sprint(len(text))
	h["content-type"] = "text/markdown; charset=utf-8"
	if ifMatch != "" {
		h["if-match"] = ifMatch
	}
	for k, v := range extra {
		h[k] = v
	}
	return testutil.Do(s.App, "PUT", "/api/v1/vaults/"+s.VaultID+"/files/"+fileID+"/content", h, []byte(text))
}

func TestChangesEmitsCreateEntriesWithMarkdownVsAttachmentKinds(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{
		{"note-1", "Note.md", "hello", "markdown"},
		{"img-1", "assets/img.png", "png-bytes", "attachment"},
		{"plain-1", "LICENSE", "terms", "attachment"},
	}, commitOpts{})
	body := changesOK(t, getChanges(s, "?sinceRevision=0"))
	if body.FromRevision != 0 || body.ToRevision != 1 || body.LatestRevision != 1 || body.Truncated || len(body.Changes) != 3 {
		t.Fatalf("body = %+v", body)
	}
	byID := map[string]protocol.ChangeEntry{}
	for _, c := range body.Changes {
		byID[c.FileID] = c
	}
	for id, want := range map[string][2]string{"note-1": {"Note.md", "markdown"}, "img-1": {"assets/img.png", "attachment"}, "plain-1": {"LICENSE", "attachment"}} {
		c := byID[id]
		if c.ChangeType != "create" || c.Path != want[0] || c.Kind != want[1] || c.Revision != 1 || c.BlobHash == nil || !hash64.MatchString(*c.BlobHash) {
			t.Fatalf("%s = %+v", id, c)
		}
	}
}

func TestChangesEmitsModifyEntriesForWebEdits(t *testing.T) {
	s := testutil.Setup(t, newApp)
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "v1", "markdown"}}, commitOpts{})
	edited := putContent(s, s.BrowserHeaders, "note-1", "v2", seeded[0].Hash, nil)
	if edited.Status != 200 {
		t.Fatalf("edit: %d %s", edited.Status, edited.Text())
	}
	editedHash := decode[struct{ BlobHash string }](t, edited).BlobHash
	body := changesOK(t, getChanges(s, "?sinceRevision=1"))
	if body.FromRevision != 1 || body.ToRevision != 2 || body.LatestRevision != 2 || len(body.Changes) != 1 {
		t.Fatalf("body = %+v", body)
	}
	c := body.Changes[0]
	if c.FileID != "note-1" || c.ChangeType != "modify" || c.Path != "Note.md" || *c.BlobHash != editedHash || c.Kind != "markdown" || c.Revision != 2 {
		t.Fatalf("entry = %+v", c)
	}
}

func TestChangesCollapsesRenamePlusModifyIntoOneRenameEntryWithPreviousPath(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"note-1", "Old.md", "v1", "markdown"}}, commitOpts{})
	commitSeeds(t, s, []seed{{"note-1", "New.md", "v2", "markdown"}}, commitOpts{deviceID: "device-1"})
	body := changesOK(t, getChanges(s, "?sinceRevision=1"))
	if len(body.Changes) != 1 {
		t.Fatalf("changes = %+v", body.Changes)
	}
	c := body.Changes[0]
	if c.FileID != "note-1" || c.ChangeType != "rename" || c.Path != "New.md" || c.PreviousPath == nil || *c.PreviousPath != "Old.md" ||
		c.Kind != "markdown" || c.Revision != 2 || c.BlobHash == nil || !hash64.MatchString(*c.BlobHash) {
		t.Fatalf("entry = %+v", c)
	}
}

func TestChangesEmitsTombstoneDeleteEntriesWithoutBlobFields(t *testing.T) {
	s := testutil.Setup(t, newApp)
	seeded := commitSeeds(t, s, []seed{
		{"note-1", "Note.md", "hello", "markdown"},
		{"note-2", "Other.md", "world", "markdown"},
	}, commitOpts{})
	remaining := []protocol.SyncManifestEntry{seeded[1]}
	if r := commitManifest(s, s.Token, s.VaultID, "device-1", sortedBody(t, "device-1", remaining)); r.Status != 200 {
		t.Fatalf("commit: %d %s", r.Status, r.Text())
	}
	r := getChanges(s, "?sinceRevision=1")
	body := changesOK(t, r)
	if body.ToRevision != 2 || body.LatestRevision != 2 || len(body.Changes) != 1 {
		t.Fatalf("body = %+v", body)
	}
	c := body.Changes[0]
	if c.FileID != "note-1" || c.ChangeType != "delete" || c.Path != "Note.md" || c.Kind != "markdown" || c.Revision != 2 {
		t.Fatalf("entry = %+v", c)
	}
	var raw struct{ Changes []map[string]any }
	_ = json.Unmarshal(r.Body, &raw)
	for _, k := range []string{"blobHash", "size", "mtime"} {
		if _, has := raw.Changes[0][k]; has {
			t.Fatalf("tombstone must not carry %s: %s", k, r.Text())
		}
	}
}

func TestChangesPagesWithLimitAndResumesFromTheLastSeenRevision(t *testing.T) {
	s := testutil.Setup(t, newApp)
	var accumulated []seed
	for i := 1; i <= 4; i++ {
		accumulated = append(accumulated, seed{fmt.Sprintf("note-%d", i), fmt.Sprintf("Note%d.md", i), fmt.Sprintf("v%d", i), "markdown"})
		commitSeeds(t, s, accumulated, commitOpts{deviceID: "device-1"})
	}
	ids := func(b protocol.ChangesOK) string {
		var out []string
		for _, c := range b.Changes {
			out = append(out, c.FileID)
		}
		return strings.Join(out, ",")
	}
	first := changesOK(t, getChanges(s, "?sinceRevision=0&limit=2"))
	if ids(first) != "note-1,note-2" || first.FromRevision != 0 || first.ToRevision != 2 || first.LatestRevision != 4 || !first.Truncated {
		t.Fatalf("first = %+v", first)
	}
	second := changesOK(t, getChanges(s, fmt.Sprintf("?sinceRevision=%d&limit=2", first.ToRevision)))
	if ids(second) != "note-3,note-4" || second.FromRevision != 2 || second.ToRevision != 4 || second.LatestRevision != 4 || second.Truncated {
		t.Fatalf("second = %+v", second)
	}
	var revs []int64
	for _, c := range append(append([]protocol.ChangeEntry(nil), first.Changes...), second.Changes...) {
		revs = append(revs, c.Revision)
	}
	if fmt.Sprint(revs) != "[1 2 3 4]" {
		t.Fatalf("revisions = %v", revs)
	}
	// limit is capped at 500 and defaults to 200 without error.
	if r := getChanges(s, "?sinceRevision=0&limit=9999"); r.Status != 200 {
		t.Fatalf("big limit: %d", r.Status)
	}
}

func TestChangesReturnsAnEmptyOkPageWhenAlreadyAtTheLatestRevision(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"note-1", "Note.md", "hello", "markdown"}}, commitOpts{})
	r := getChanges(s, "?sinceRevision=1")
	changesOK(t, r)
	if r.Text() != `{"status":"ok","fromRevision":1,"toRevision":1,"latestRevision":1,"truncated":false,"changes":[]}` {
		t.Fatalf("body = %s", r.Text())
	}
}

func TestChangesReturnsFullResyncRequiredWhenSinceRevisionIsAheadOfLatest(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"note-1", "Note.md", "hello", "markdown"}}, commitOpts{})
	r := getChanges(s, "?sinceRevision=99")
	if r.Status != 200 || r.Text() != `{"status":"full-resync-required","latestRevision":1}` {
		t.Fatalf("body = %d %s", r.Status, r.Text())
	}
}

func TestChangesRejectsMissingOrInvalidParams(t *testing.T) {
	s := testutil.Setup(t, newApp)
	for _, q := range []string{"", "?limit=10", "?sinceRevision=abc", "?sinceRevision=-1", "?sinceRevision=0&limit=0", "?sinceRevision=1.5", "?sinceRevision=0&limit=x", "?sinceRevision="} {
		wantErr(t, getChanges(s, q), 400, "INVALID_MANIFEST", "")
	}
}

func TestChangesIsReadableWithTheDefaultPluginTokenAndTheSession(t *testing.T) {
	s := testutil.Setup(t, newApp)
	commitSeeds(t, s, []seed{{"note-1", "Note.md", "hello", "markdown"}}, commitOpts{})
	if r := getChanges(s, "?sinceRevision=0"); r.Status != 200 {
		t.Fatalf("token: %d", r.Status)
	}
	r := testutil.Do(s.App, "GET", "/api/v1/vaults/"+s.VaultID+"/changes?sinceRevision=0", testutil.Headers{"cookie": s.BrowserHeaders["cookie"]}, nil)
	if r.Status != 200 {
		t.Fatalf("session: %d", r.Status)
	}
}

func TestChangesNeverLogsNoteContentOnlyIdsAndRevisionCounts(t *testing.T) {
	s := testutil.Setup(t, newApp)
	secret := "web-edit-secret-text"
	seeded := commitSeeds(t, s, []seed{{"note-1", "Note.md", "base", "markdown"}}, commitOpts{})
	putContent(s, s.BrowserHeaders, "note-1", secret, seeded[0].Hash, nil)
	s.Logs.Reset()
	if r := getChanges(s, "?sinceRevision=0"); r.Status != 200 {
		t.Fatalf("changes: %d", r.Status)
	}
	text := s.Logs.String()
	if strings.Contains(text, secret) || !strings.Contains(text, "from_revision") || !strings.Contains(text, "change_count") {
		t.Fatalf("log = %s", text)
	}
	_ = context.Background()
}
