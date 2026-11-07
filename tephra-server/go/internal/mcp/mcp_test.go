package mcp_test

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"testing"

	"github.com/championswimmer/tephra/tephra-server/go/internal/api"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/mcp"
	"github.com/championswimmer/tephra/tephra-server/go/internal/testutil"
)

func newApp(d httpx.Dependencies) http.Handler { return api.NewApp(d) }

type obj = map[string]any

func rpcBody(method string, params any, id any) string {
	m := obj{"jsonrpc": "2.0", "method": method}
	if id != nil {
		m["id"] = id
	}
	if params != nil {
		m["params"] = params
	}
	b, _ := json.Marshal(m)
	return string(b)
}

func post(s *testutil.Session, token *string, body string) testutil.Response {
	h := testutil.Headers{"content-type": "application/json"}
	if token != nil {
		h["authorization"] = "Bearer " + *token
	}
	return testutil.DoJSON(s.App, "POST", "/mcp", h, body)
}

func rpc(s *testutil.Session, token *string, method string, params any, id any) testutil.Response {
	return post(s, token, rpcBody(method, params, id))
}

func parse(t *testing.T, r testutil.Response) obj {
	t.Helper()
	var v obj
	testutil.JSON(t, r, &v)
	return v
}

type toolResult struct {
	IsError           *bool `json:"isError"`
	Content           []struct{ Text string }
	StructuredContent obj `json:"structuredContent"`
}

func call(t *testing.T, s *testutil.Session, token, name string, args obj) toolResult {
	t.Helper()
	r := rpc(s, &token, "tools/call", obj{"name": name, "arguments": args}, 1)
	if r.Status != 200 {
		t.Fatalf("tools/call status %d: %s", r.Status, r.Text())
	}
	var body struct {
		Result toolResult `json:"result"`
	}
	testutil.JSON(t, r, &body)
	return body.Result
}

func (r toolResult) isError() bool { return r.IsError != nil && *r.IsError }

func scopedToken(t *testing.T, s *testutil.Session, scopes ...string) string {
	t.Helper()
	b, _ := json.Marshal(obj{"name": "mcp", "scopes": scopes})
	r := testutil.Do(s.App, "POST", "/api/v1/vaults/"+s.VaultID+"/tokens", s.BrowserHeaders, b)
	var v struct{ Value string }
	testutil.JSON(t, r, &v)
	return v.Value
}

func TestRequiresBearerAndRefusesCookieSessions(t *testing.T) {
	s := testutil.Setup(t, newApp)
	if got := rpc(s, nil, "ping", nil, 1).Status; got != 401 {
		t.Fatalf("no token: %d", got)
	}
	cookie := testutil.DoJSON(s.App, "POST", "/mcp", testutil.Headers{
		"cookie": s.BrowserHeaders["cookie"], "content-type": "application/json",
	}, `{"jsonrpc":"2.0","id":1,"method":"ping"}`)
	if cookie.Status != 401 {
		t.Fatalf("cookie: %d", cookie.Status)
	}
	bogus := "bogus"
	if got := rpc(s, &bogus, "ping", nil, 1).Status; got != 401 {
		t.Fatalf("bogus: %d", got)
	}
	get := testutil.Do(s.App, "GET", "/mcp", nil, nil)
	if get.Status != 405 || get.Header.Get("Allow") != "POST" || get.Text() != `{"error":"Use POST with a JSON-RPC body."}` {
		t.Fatalf("GET /mcp: %d %v %s", get.Status, get.Header, get.Text())
	}
	del := testutil.Do(s.App, "DELETE", "/mcp", nil, nil)
	if del.Status != 405 || del.Header.Get("Allow") != "POST" || del.Text() != "" {
		t.Fatalf("DELETE /mcp: %d %v %q", del.Status, del.Header, del.Text())
	}
}

func TestUnauthorizedBodiesAndChallenge(t *testing.T) {
	s := testutil.Setup(t, newApp)
	missing := rpc(s, nil, "ping", nil, 1)
	if missing.Text() != `{"error":"A Bearer API token is required."}` {
		t.Fatalf("body %s", missing.Text())
	}
	want := `Bearer realm="tephra", resource_metadata="http://example.com/.well-known/oauth-protected-resource"`
	if got := missing.Header.Get("WWW-Authenticate"); got != want {
		t.Fatalf("challenge %q", got)
	}
	bogus := "bogus"
	bad := rpc(s, &bogus, "ping", nil, 1)
	if bad.Text() != `{"error":"Authentication is required."}` || bad.Header.Get("WWW-Authenticate") != want {
		t.Fatalf("bogus: %s %v", bad.Text(), bad.Header)
	}
}

func TestInitializePingNotificationsToolsList(t *testing.T) {
	s := testutil.Setup(t, newApp)
	tok := s.Token
	init := rpc(s, &tok, "initialize", obj{"protocolVersion": "2025-03-26"}, 1)
	if !strings.HasPrefix(init.Text(), `{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-03-26","capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"tephra","version":"0.1.0"},"instructions":"Tephra stores`) {
		t.Fatalf("initialize: %s", init.Text())
	}
	fallback := rpc(s, &tok, "initialize", obj{"protocolVersion": "1999-01-01"}, "x")
	if !strings.Contains(fallback.Text(), `"id":"x","result":{"protocolVersion":"2025-06-18"`) {
		t.Fatalf("fallback: %s", fallback.Text())
	}
	if got := rpc(s, &tok, "notifications/initialized", nil, nil).Status; got != 202 {
		t.Fatalf("notification: %d", got)
	}
	if got := rpc(s, &tok, "notifications/whatever", nil, 5).Status; got != 202 {
		t.Fatalf("notification with id: %d", got)
	}
	if got := rpc(s, &tok, "unknown/notification", nil, nil).Status; got != 202 {
		t.Fatalf("unknown notification: %d", got)
	}
	if got := rpc(s, &tok, "ping", nil, 7).Text(); got != `{"jsonrpc":"2.0","id":7,"result":{}}` {
		t.Fatalf("ping: %s", got)
	}

	list := parse(t, rpc(s, &tok, "tools/list", nil, 1))
	var names []string
	for _, tl := range list["result"].(obj)["tools"].([]any) {
		names = append(names, tl.(obj)["name"].(string))
	}
	order := append([]string(nil), names...)
	sort.Strings(names)
	want := []string{"create_note", "list_vaults", "read_note", "search_notes", "update_note"}
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("tools: %v", names)
	}
	if !reflect.DeepEqual(order, []string{"list_vaults", "search_notes", "read_note", "create_note", "update_note"}) {
		t.Fatalf("tool order: %v", order)
	}
	unknown := parse(t, rpc(s, &tok, "nope", nil, 1))
	if unknown["error"].(obj)["code"].(float64) != -32601 || unknown["error"].(obj)["message"] != "Method not found: nope" {
		t.Fatalf("unknown: %v", unknown)
	}
}

func TestToolSchemasMatchZod(t *testing.T) {
	s := testutil.Setup(t, newApp)
	tok := s.Token
	text := rpc(s, &tok, "tools/list", nil, 1).Text()
	for _, frag := range []string{
		`{"name":"list_vaults","description":"List the vaults this credential can access.","inputSchema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{},"additionalProperties":false}}`,
		`"inputSchema":{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","properties":{"vault":{"description":"Vault id or name. Optional when the API token is bound to a single vault.","type":"string"},"query":{"type":"string","minLength":1,"maxLength":200,"description":"Text to look for in note paths/titles."},"limit":{"description":"Max results (default 20).","type":"integer","minimum":1,"maximum":100}},"required":["query"],"additionalProperties":false}`,
		`"required":["path","content"],"additionalProperties":false}`,
		`"patch":{"description":"Unified diff to apply to the current note.","type":"string","minLength":1}`,
	} {
		if !strings.Contains(text, frag) {
			t.Fatalf("missing %s in %s", frag, text)
		}
	}
}

func TestCreateSearchReadEditWithOneRevisionPerWrite(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ctx := context.Background()
	writer := scopedToken(t, s, "vault:read-metadata", "vault:write")
	created := call(t, s, writer, "create_note", obj{"path": "Projects/Plan.md", "content": "# Plan\n\none\ntwo\nthree\n"})
	if created.isError() || created.StructuredContent["status"] != "committed" || created.StructuredContent["revision"].(float64) != 1 ||
		created.StructuredContent["path"] != "Projects/Plan.md" {
		t.Fatalf("created: %+v", created)
	}
	if got := created.Content[0].Text; !strings.HasPrefix(got, `{"status":"committed","revision":1,"path":"Projects/Plan.md","fileId":"`) {
		t.Fatalf("text/key order: %s", got)
	}

	if !call(t, s, writer, "create_note", obj{"path": "projects/plan.md", "content": "x"}).isError() {
		t.Fatal("case-insensitive duplicate must fail")
	}
	if !call(t, s, writer, "create_note", obj{"path": "../x.md", "content": "x"}).isError() {
		t.Fatal("traversal must fail")
	}
	if !call(t, s, writer, "create_note", obj{"path": "x.txt", "content": "x"}).isError() {
		t.Fatal("non-md must fail")
	}

	found := call(t, s, writer, "search_notes", obj{"query": "plan"})
	if len(found.StructuredContent["results"].([]any)) != 1 {
		t.Fatalf("search: %+v", found)
	}

	read := call(t, s, writer, "read_note", obj{"path": "Projects/Plan.md"})
	if read.StructuredContent["content"] != "# Plan\n\none\ntwo\nthree\n" {
		t.Fatalf("read: %+v", read)
	}
	hash := read.StructuredContent["blobHash"].(string)

	patched := call(t, s, writer, "update_note", obj{
		"path": "Projects/Plan.md", "baseHash": hash,
		"patch": "--- a/Plan.md\n+++ b/Plan.md\n@@ -3,3 +3,3 @@\n one\n-two\n+TWO\n three\n",
	})
	if patched.StructuredContent["status"] != "committed" || patched.StructuredContent["revision"].(float64) != 2 {
		t.Fatalf("patched: %+v", patched)
	}
	after := call(t, s, writer, "read_note", obj{"path": "Projects/Plan.md"})
	if after.StructuredContent["content"] != "# Plan\n\none\nTWO\nthree\n" {
		t.Fatalf("after: %+v", after)
	}

	// Stale baseHash is a conflict; nothing is written.
	stale := call(t, s, writer, "update_note", obj{"path": "Projects/Plan.md", "baseHash": hash, "content": "clobber"})
	if !stale.isError() || !strings.Contains(stale.Content[0].Text, "conflict") {
		t.Fatalf("stale: %+v", stale)
	}
	// Full replacement requires baseHash.
	if !call(t, s, writer, "update_note", obj{"path": "Projects/Plan.md", "content": "x"}).isError() {
		t.Fatal("content without baseHash must fail")
	}
	full := call(t, s, writer, "update_note", obj{"path": "Projects/Plan.md", "baseHash": after.StructuredContent["blobHash"], "content": "brand new"})
	if full.StructuredContent["status"] != "committed" || full.StructuredContent["revision"].(float64) != 3 {
		t.Fatalf("full: %+v", full)
	}

	// A patch that does not match is rejected without a revision.
	bad := call(t, s, writer, "update_note", obj{"path": "Projects/Plan.md", "patch": "@@ -1,1 +1,1 @@\n-not there\n+x\n"})
	if !bad.isError() {
		t.Fatal("bad patch must fail")
	}
	v, _ := s.DB.Vaults().FindByID(ctx, s.VaultID)
	if v.LatestRevision != 3 {
		t.Fatalf("latest revision %d", v.LatestRevision)
	}
	rows, _ := s.DB.FileVersions().ListByRevision(ctx, s.VaultID, 3)
	if len(rows) != 1 || rows[0].ChangeType != "modify" {
		t.Fatalf("rows: %+v", rows)
	}
	rev, _ := s.DB.VaultRevisions().Find(ctx, s.VaultID, 3)
	if rev == nil || rev.DeviceID != "mcp:"+v.OwnerUserID || len(rev.ManifestHash) != 64 {
		t.Fatalf("revision row: %+v", rev)
	}
	dev, _ := s.DB.Devices().FindByID(ctx, "mcp:"+v.OwnerUserID)
	if dev == nil || dev.Name != "Tephra MCP" || dev.Platform == nil || *dev.Platform != "mcp" {
		t.Fatalf("device: %+v", dev)
	}
}

func TestUpToDateEditCreatesNoRevision(t *testing.T) {
	s := testutil.Setup(t, newApp)
	w := scopedToken(t, s, "vault:read-metadata", "vault:write")
	call(t, s, w, "create_note", obj{"path": "A.md", "content": "same"})
	read := call(t, s, w, "read_note", obj{"path": "a.md"}) // case-folded lookup
	res := call(t, s, w, "update_note", obj{"path": "A.md", "baseHash": read.StructuredContent["blobHash"], "content": "same"})
	if res.StructuredContent["status"] != "up-to-date" || res.StructuredContent["revision"].(float64) != 1 {
		t.Fatalf("res: %+v", res)
	}
}

func TestEnforcesTokenScopes(t *testing.T) {
	s := testutil.Setup(t, newApp)
	ctx := context.Background()
	readOnly := scopedToken(t, s, "vault:read-metadata")
	denied := call(t, s, readOnly, "create_note", obj{"path": "A.md", "content": "x"})
	if !denied.isError() || denied.Content[0].Text != "Vault not found or access denied (check token vault and scopes)." {
		t.Fatalf("denied: %+v", denied)
	}
	files, _ := s.DB.VaultFiles().ListByVault(ctx, s.VaultID)
	if len(files) != 0 {
		t.Fatalf("files written: %+v", files)
	}
	uploadOnly := scopedToken(t, s, "vault:upload")
	if !call(t, s, uploadOnly, "search_notes", obj{"query": "a"}).isError() {
		t.Fatal("upload-only token must not search")
	}
}

func TestInvalidArgumentsAndToolErrors(t *testing.T) {
	s := testutil.Setup(t, newApp)
	tok := s.Token
	cases := []struct {
		name string
		args obj
		want string
	}{
		{"search_notes", obj{}, "Invalid arguments: query: Invalid input: expected string, received undefined"},
		{"search_notes", obj{"query": "  "}, "Invalid arguments: query: Too small: expected string to have >=1 characters"},
		{"search_notes", obj{"query": "a", "limit": 0.5}, "Invalid arguments: limit: Invalid input: expected int, received number"},
		{"search_notes", obj{"query": "a", "limit": 1e20}, "Invalid arguments: limit: Too big: expected int to be <=9007199254740991; limit: Too big: expected number to be <=100"},
		{"read_note", obj{"path": ""}, "Invalid arguments: path: Too small: expected string to have >=1 characters"},
		{"create_note", obj{"path": "a.md"}, "Invalid arguments: content: Invalid input: expected string, received undefined"},
		{"read_note", obj{"path": "Nope.md"}, `Note "Nope.md" was not found.`},
		{"update_note", obj{"path": "a.md"}, "Provide exactly one of `patch` or `content`."},
		{"update_note", obj{"path": "a.md", "patch": "x", "content": "y"}, "Provide exactly one of `patch` or `content`."},
		{"update_note", obj{"path": "a.md", "content": "y"}, "`baseHash` (from read_note) is required when replacing full `content`."},
	}
	writer := scopedToken(t, s, "vault:read-metadata", "vault:write")
	for _, c := range cases {
		res := call(t, s, writer, c.name, c.args)
		if !res.isError() || res.Content[0].Text != c.want {
			t.Errorf("%s %v: got %+v want %q", c.name, c.args, res, c.want)
		}
	}
	// arguments omitted / not an object
	r := rpc(s, &tok, "tools/call", obj{"name": "read_note"}, 1)
	if !strings.Contains(r.Text(), "Invalid arguments: path: Invalid input: expected string, received undefined") {
		t.Fatalf("omitted args: %s", r.Text())
	}
	r = rpc(s, &tok, "tools/call", obj{"name": "read_note", "arguments": "str"}, 1)
	if !strings.Contains(r.Text(), "Invalid arguments: arguments: Invalid input: expected object, received string") {
		t.Fatalf("string args: %s", r.Text())
	}
}

func TestToolsCallErrorsAtRpcLevel(t *testing.T) {
	s := testutil.Setup(t, newApp)
	tok := s.Token
	for params, want := range map[string]string{
		`{"name":"nope"}`: "Unknown tool: nope",
		`{}`:              "Unknown tool: undefined",
		`{"name":null}`:   "Unknown tool: null",
		`{"name":5}`:      "Unknown tool: 5",
		`{"name":{}}`:     "Unknown tool: [object Object]",
	} {
		r := post(s, &tok, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":`+params+`}`)
		if r.Status != 200 || !strings.Contains(r.Text(), `"error":{"code":-32602,"message":"`+want+`"}`) {
			t.Errorf("%s: %d %s", params, r.Status, r.Text())
		}
	}
	// Object.prototype names are "in tools" in the TS server and end as internal errors.
	r := post(s, &tok, `{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"constructor"}}`)
	if r.Text() != `{"jsonrpc":"2.0","id":1,"result":{"content":[{"type":"text","text":"Internal error."}],"isError":true}}` {
		t.Fatalf("constructor: %s", r.Text())
	}
}

func TestBatchesAndMalformedBodies(t *testing.T) {
	s := testutil.Setup(t, newApp)
	tok := s.Token
	r := post(s, &tok, `[{"jsonrpc":"2.0","id":1,"method":"ping"},{"jsonrpc":"2.0","method":"notifications/initialized"},{"jsonrpc":"1.0","id":3,"method":"ping"},5,{"jsonrpc":"2.0","id":"k","method":"nope"}]`)
	want := `[{"jsonrpc":"2.0","id":1,"result":{}},` +
		`{"jsonrpc":"2.0","id":3,"error":{"code":-32600,"message":"Invalid JSON-RPC request."}},` +
		`{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid JSON-RPC request."}},` +
		`{"jsonrpc":"2.0","id":"k","error":{"code":-32601,"message":"Method not found: nope"}}]`
	if r.Status != 200 || r.Text() != want {
		t.Fatalf("batch: %d %s", r.Status, r.Text())
	}
	if r := post(s, &tok, `[{"jsonrpc":"2.0","method":"notifications/initialized"}]`); r.Status != 202 || r.Text() != "" {
		t.Fatalf("all-notification batch: %d %q", r.Status, r.Text())
	}
	if r := post(s, &tok, `[]`); r.Status != 400 || r.Text() != `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Empty batch."}}` {
		t.Fatalf("empty batch: %d %s", r.Status, r.Text())
	}
	if r := post(s, &tok, `{nope`); r.Status != 400 || r.Text() != `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error."}}` {
		t.Fatalf("parse error: %d %s", r.Status, r.Text())
	}
	if r := post(s, &tok, `null`); r.Status != 200 || r.Text() != `{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"Invalid JSON-RPC request."}}` {
		t.Fatalf("null body: %d %s", r.Status, r.Text())
	}
	if r := post(s, &tok, `{"jsonrpc":"2.0","id":9,"method":5}`); r.Text() != `{"jsonrpc":"2.0","id":9,"error":{"code":-32600,"message":"Invalid JSON-RPC request."}}` {
		t.Fatalf("method not string: %s", r.Text())
	}
}

func TestListVaultsAndVaultResolution(t *testing.T) {
	s := testutil.Setup(t, newApp)
	tok := s.Token
	res := call(t, s, tok, "list_vaults", obj{})
	vaults := res.StructuredContent["vaults"].([]any)
	if len(vaults) != 1 || vaults[0].(obj)["id"] != s.VaultID || vaults[0].(obj)["name"] != "Test Vault" {
		t.Fatalf("vaults: %+v", res)
	}
	if !strings.HasPrefix(res.Content[0].Text, `{"vaults":[{"id":"`+s.VaultID+`","name":"Test Vault","latestRevision":0}]}`) {
		t.Fatalf("text: %s", res.Content[0].Text)
	}
	// by name and by id
	byName := call(t, s, tok, "search_notes", obj{"vault": "Test Vault", "query": "x"})
	byID := call(t, s, tok, "search_notes", obj{"vault": s.VaultID, "query": "x"})
	if byName.isError() || byID.isError() {
		t.Fatalf("by name/id: %+v %+v", byName, byID)
	}
	if !call(t, s, tok, "search_notes", obj{"vault": "other", "query": "x"}).isError() {
		t.Fatal("unknown vault must fail")
	}
}

func TestPatchUnifiedDiffStrict(t *testing.T) {
	source := "a\nb\nc\nd\ne\n"
	ok := func(patch, want string) {
		t.Helper()
		got, err := mcp.ApplyUnifiedDiff(source, patch)
		if err != nil || got != want {
			t.Fatalf("patch %q: got %q err %v want %q", patch, got, err, want)
		}
	}
	ok("@@ -2,2 +2,3 @@\n b\n+b2\n c\n", "a\nb\nb2\nc\nd\ne\n")
	// Off-by-some line numbers still apply when context matches exactly.
	ok("@@ -9,1 +9,1 @@\n-d\n+D\n", "a\nb\nc\nD\ne\n")
	var pe *mcp.PatchError
	for patch, msg := range map[string]string{
		"@@ -1,1 +1,1 @@\n-zzz\n+y\n": "Hunk 1 does not apply: its context/removed lines were not found in the current note. Re-read the note and regenerate the patch.",
		"no hunks":                    `Patch contains no "@@ -a,b +c,d @@" hunks.`,
		"@@ -1,1 +1,1 @@\n*weird\n":   `Unrecognised patch line: "*weird"`,
	} {
		_, err := mcp.ApplyUnifiedDiff(source, patch)
		if err == nil || !errorsAs(err, &pe) || err.Error() != msg {
			t.Fatalf("patch %q: err %v want %q", patch, err, msg)
		}
	}
}

func errorsAs(err error, target **mcp.PatchError) bool {
	pe, ok := err.(*mcp.PatchError)
	if ok {
		*target = pe
	}
	return ok
}
