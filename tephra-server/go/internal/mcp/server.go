// Package mcp ports apps/api/src/mcp/{server,commit,patch}.ts: the stateless
// Streamable-HTTP MCP endpoint (JSON-RPC over POST /mcp, JSON responses only)
// with the list_vaults / search_notes / read_note / create_note / update_note
// tools.
//
// The package depends on httpx and internal/oauth only (never on internal/api)
// so that internal/api can import it from register_mcp_oauth.go.
package mcp

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/championswimmer/tephra/tephra-server/go/internal/blobstore"
	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/jstext"
	"github.com/championswimmer/tephra/tephra-server/go/internal/oauth"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
	vm "github.com/championswimmer/tephra/tephra-server/go/internal/vaultmodel"
)

var supportedVersions = []string{"2025-06-18", "2025-03-26", "2024-11-05"}

const instructions = "Tephra stores Obsidian Markdown vaults. Use search_notes to find notes, read_note to fetch one, create_note to add one, " +
	"and update_note (unified diff patch or full content) to edit. Always pass the blobHash from read_note as baseHash when editing."

// maxBodyBytes bounds the /mcp request body (the TS server has no explicit
// limit); it comfortably exceeds the largest permitted note.
const maxBodyBytes = 256 << 20

// toolError is a failure reported to the model as an isError tool result.
type toolError struct{ msg string }

func (e *toolError) Error() string { return e.msg }

func toolErr(msg string) error { return &toolError{msg} }

func findTool(name string) *toolSpec {
	for i := range tools {
		if tools[i].name == name {
			return &tools[i]
		}
	}
	return nil
}

// objectPrototype are the names `name in tools` is true for in JavaScript
// (inherited from Object.prototype); calling them ends in "Internal error.".
var objectPrototype = map[string]bool{
	"constructor": true, "__defineGetter__": true, "__defineSetter__": true, "hasOwnProperty": true,
	"__lookupGetter__": true, "__lookupSetter__": true, "isPrototypeOf": true, "propertyIsEnumerable": true,
	"toString": true, "valueOf": true, "__proto__": true, "toLocaleString": true,
}

type vaultSummary struct {
	ID             string `json:"id"`
	Name           string `json:"name"`
	LatestRevision int64  `json:"latestRevision"`
}

type fileMeta struct {
	Path     string `json:"path"`
	FileID   string `json:"fileId"`
	BlobHash string `json:"blobHash"`
	Size     int64  `json:"size"`
	Mtime    int64  `json:"mtime"`
}

func metaOf(f vm.CurrentVaultFile) fileMeta {
	return fileMeta{f.Path, f.FileID, f.BlobHash, f.Size, f.Mtime}
}

type readResult struct {
	fileMeta
	Revision int64  `json:"revision"`
	Content  string `json:"content"`
}

type writeResult struct {
	Status   string `json:"status"`
	Revision int64  `json:"revision"`
	fileMeta
}

func resolveVault(ctx context.Context, d httpx.Dependencies, p *httpx.Principal, requested *string, scope vm.ApiTokenScope) (*vm.Vault, error) {
	var vault *vm.Vault
	var err error
	switch {
	case requested != nil:
		vault, err = httpx.FindVaultByIDOrName(ctx, d.Database.Vaults(), *requested)
	case p.Kind == httpx.PrincipalToken:
		if p.Token.VaultID != nil {
			vault, err = d.Database.Vaults().FindByID(ctx, *p.Token.VaultID)
		}
	default:
		var owned []vm.Vault
		owned, err = d.Database.Vaults().ListByOwner(ctx, p.User.ID)
		if err == nil {
			if len(owned) != 1 {
				return nil, toolErr("Several vaults exist; pass the `vault` argument (see list_vaults).")
			}
			vault = &owned[0]
		}
	}
	if err != nil {
		return nil, err
	}
	if vault == nil || !httpx.CanAccessVault(p, vault, scope) {
		// Same message for missing and forbidden so vault existence is not leaked.
		return nil, toolErr("Vault not found or access denied (check token vault and scopes).")
	}
	return vault, nil
}

func findNote(ctx context.Context, d httpx.Dependencies, vault *vm.Vault, rawPath string) (*vm.CurrentVaultFile, error) {
	path := jstext.NFC(rawPath)
	files := d.Database.VaultFiles()
	found, err := files.FindByPath(ctx, vault.ID, path)
	if err != nil {
		return nil, err
	}
	if found == nil {
		folded, err := files.FindByPathFold(ctx, vault.ID, jstext.Lower(path))
		if err != nil {
			return nil, err
		}
		if len(folded) > 1 {
			return nil, toolErr(`Path "` + rawPath + `" is ambiguous (case variants exist).`)
		}
		if len(folded) == 1 {
			found = &folded[0]
		}
	}
	if found == nil {
		return nil, toolErr(`Note "` + rawPath + `" was not found.`)
	}
	if found.Kind != vm.KindMarkdown {
		return nil, toolErr(`"` + found.Path + `" is not a Markdown note.`)
	}
	return found, nil
}

// decodeUTF8 is Response.text(): a leading BOM is dropped and each invalid
// byte becomes U+FFFD.
func decodeUTF8(b []byte) string {
	b = bytes.TrimPrefix(b, []byte("\xef\xbb\xbf"))
	if utf8.Valid(b) {
		return string(b)
	}
	var sb strings.Builder
	for len(b) > 0 {
		r, n := utf8.DecodeRune(b)
		if r == utf8.RuneError && n == 1 {
			sb.WriteString("�")
		} else {
			sb.Write(b[:n])
		}
		b = b[n:]
	}
	return sb.String()
}

func readText(ctx context.Context, d httpx.Dependencies, f *vm.CurrentVaultFile) (string, error) {
	blob, err := d.BlobStore.Get(ctx, f.BlobHash)
	if errors.Is(err, blobstore.ErrNotFound) {
		return "", toolErr("Note content is missing from the blob store.")
	}
	if err != nil {
		return "", err
	}
	defer blob.Body.Close()
	data, err := io.ReadAll(blob.Body)
	if err != nil {
		return "", err
	}
	return decodeUTF8(data), nil
}

func hasMDExtension(path string) bool {
	return len(path) >= 3 && strings.EqualFold(path[len(path)-3:], ".md")
}

func callTool(ctx context.Context, d httpx.Dependencies, p *httpx.Principal, spec *toolSpec, rawArgs any) (any, error) {
	args, issues := parseToolArgs(spec.name, rawArgs)
	if len(issues) > 0 {
		return nil, toolErr(invalidArgumentsMessage(issues))
	}

	if spec.name == "list_vaults" {
		var vaults []*vm.Vault
		if p.Kind == httpx.PrincipalToken {
			if p.Token.VaultID != nil {
				v, err := d.Database.Vaults().FindByID(ctx, *p.Token.VaultID)
				if err != nil {
					return nil, err
				}
				vaults = append(vaults, v)
			}
		} else {
			owned, err := d.Database.Vaults().ListByOwner(ctx, p.User.ID)
			if err != nil {
				return nil, err
			}
			for i := range owned {
				vaults = append(vaults, &owned[i])
			}
		}
		out := []vaultSummary{}
		for _, v := range vaults {
			if v != nil && httpx.CanAccessVault(p, v, spec.scope) {
				out = append(out, vaultSummary{v.ID, v.Name, v.LatestRevision})
			}
		}
		return struct {
			Vaults []vaultSummary `json:"vaults"`
		}{out}, nil
	}
	vault, err := resolveVault(ctx, d, p, args.vault, spec.scope)
	if err != nil {
		return nil, err
	}

	switch spec.name {
	case "search_notes":
		limit := 20
		if args.limit != nil {
			limit = *args.limit
		}
		results, err := httpx.SearchVault(ctx, d, vault.ID, *args.query, limit)
		if err != nil {
			return nil, err
		}
		return struct {
			Revision int64 `json:"revision"`
			Results  []any `json:"results"`
		}{vault.LatestRevision, results}, nil
	case "read_note":
		file, err := findNote(ctx, d, vault, *args.path)
		if err != nil {
			return nil, err
		}
		content, err := readText(ctx, d, file)
		if err != nil {
			return nil, err
		}
		return readResult{metaOf(*file), vault.LatestRevision, content}, nil
	case "create_note":
		path := jstext.NFC(*args.path)
		if !protocol.IsCanonicalVaultPath(path) || !hasMDExtension(path) {
			return nil, toolErr(`path must be a canonical vault-relative path ending in ".md".`)
		}
		result, err := commitNote(ctx, d, *vault, p.User.ID, httpx.NotePlan{Kind: "create", Path: path}, *args.content)
		if err != nil {
			return nil, err
		}
		switch result.Status {
		case "exists":
			return nil, toolErr(`A file already exists at "` + result.Current.Path + `". Use update_note to edit it.`)
		case "conflict":
			return nil, toolErr("Unexpected conflict.")
		}
		return writeResult{result.Status, result.Revision, metaOf(*result.File)}, nil
	default: // update_note
		if (args.patch == nil) == (args.content == nil) {
			return nil, toolErr("Provide exactly one of `patch` or `content`.")
		}
		if args.content != nil && args.baseHash == nil {
			return nil, toolErr("`baseHash` (from read_note) is required when replacing full `content`.")
		}
		file, err := findNote(ctx, d, vault, *args.path)
		if err != nil {
			return nil, err
		}
		if args.baseHash != nil && *args.baseHash != file.BlobHash {
			return nil, toolErr("Edit conflict: the note changed since it was read (current blobHash " + file.BlobHash + "). Re-read it and retry.")
		}
		var text string
		if args.content != nil {
			text = *args.content
		}
		if args.patch != nil {
			current, err := readText(ctx, d, file)
			if err != nil {
				return nil, err
			}
			text, err = ApplyUnifiedDiff(current, *args.patch)
			if err != nil {
				var pe *PatchError
				if errors.As(err, &pe) {
					return nil, toolErr(pe.Message)
				}
				return nil, err
			}
		}
		result, err := commitNote(ctx, d, *vault, p.User.ID, httpx.NotePlan{Kind: "update", FileID: file.FileID, BaseHash: file.BlobHash}, text)
		if err != nil {
			return nil, err
		}
		switch result.Status {
		case "conflict":
			return nil, toolErr("Edit conflict: the note changed while saving. Re-read it and retry.")
		case "exists":
			return nil, toolErr("Unexpected path clash.")
		}
		return writeResult{result.Status, result.Revision, metaOf(*result.File)}, nil
	}
}

// --- JSON-RPC ---------------------------------------------------------------

type rpcErrorBody struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

type rpcErrorReply struct {
	JSONRPC string       `json:"jsonrpc"`
	ID      any          `json:"id"`
	Error   rpcErrorBody `json:"error"`
}

type rpcResultReply struct {
	JSONRPC string `json:"jsonrpc"`
	ID      any    `json:"id"`
	Result  any    `json:"result"`
}

type textContent struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

type toolResult struct {
	Content           []textContent `json:"content"`
	StructuredContent any           `json:"structuredContent,omitempty"`
	IsError           bool          `json:"isError,omitempty"`
}

func rpcError(id any, code int, message string) rpcErrorReply {
	return rpcErrorReply{"2.0", id, rpcErrorBody{code, message}}
}

// jsString is String(value) for a decoded JSON value.
func jsString(v any, present bool) string {
	if !present {
		return "undefined"
	}
	switch t := v.(type) {
	case nil:
		return "null"
	case string:
		return t
	case bool:
		return strconv.FormatBool(t)
	case json.Number:
		if f, err := t.Float64(); err == nil {
			return strconv.FormatFloat(f, 'f', -1, 64)
		}
		return t.String()
	case []any:
		parts := make([]string, len(t))
		for i, e := range t {
			if e != nil {
				parts[i] = jsString(e, true)
			}
		}
		return strings.Join(parts, ",")
	}
	return "[object Object]"
}

func (h *handler) callToolResult(ctx context.Context, name string, rawArgs any) any {
	internal := toolResult{Content: []textContent{{"text", "Internal error."}}, IsError: true}
	spec := findTool(name)
	if spec == nil { // prototype property: the TS code throws a TypeError
		slog.Error("Unhandled MCP tool error", "error", "unsupported tool "+name)
		return internal
	}
	result, err := callTool(ctx, h.d, h.p, spec, rawArgs)
	if err != nil {
		var te *toolError
		var af *httpx.ApiFailure
		switch {
		case errors.As(err, &te):
			return toolResult{Content: []textContent{{"text", te.msg}}, IsError: true}
		case errors.As(err, &af):
			return toolResult{Content: []textContent{{"text", af.Message}}, IsError: true}
		}
		slog.Error("Unhandled MCP tool error", "error", err.Error())
		return internal
	}
	text, merr := httpx.MarshalJSON(result)
	if merr != nil {
		slog.Error("Unhandled MCP tool error", "error", merr.Error())
		return internal
	}
	return toolResult{Content: []textContent{{"text", string(text)}}, StructuredContent: result}
}

type handler struct {
	d httpx.Dependencies
	p *httpx.Principal
}

type toolListEntry struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	InputSchema json.RawMessage `json:"inputSchema"`
}

// handle processes one JSON-RPC message; a nil reply means "no response"
// (notification).
func (h *handler) handle(ctx context.Context, message any) any {
	msg, isObj := message.(map[string]any)
	var id any
	if isObj {
		id = msg["id"]
	}
	if !isObj || msg["jsonrpc"] != "2.0" {
		return rpcError(id, -32600, "Invalid JSON-RPC request.")
	}
	method, isStr := msg["method"].(string)
	if !isStr {
		return rpcError(id, -32600, "Invalid JSON-RPC request.")
	}
	_, hasID := msg["id"]
	isNotification := !hasID
	params, _ := msg["params"].(map[string]any)
	ok := func(result any) any {
		if isNotification {
			return nil
		}
		return rpcResultReply{"2.0", msg["id"], result}
	}
	switch method {
	case "initialize":
		wanted, _ := params["protocolVersion"].(string)
		version := supportedVersions[0]
		for _, v := range supportedVersions {
			if v == wanted {
				version = wanted
			}
		}
		type serverInfo struct {
			Name    string `json:"name"`
			Version string `json:"version"`
		}
		type toolsCap struct {
			ListChanged bool `json:"listChanged"`
		}
		type caps struct {
			Tools toolsCap `json:"tools"`
		}
		return ok(struct {
			ProtocolVersion string     `json:"protocolVersion"`
			Capabilities    caps       `json:"capabilities"`
			ServerInfo      serverInfo `json:"serverInfo"`
			Instructions    string     `json:"instructions"`
		}{version, caps{toolsCap{false}}, serverInfo{"tephra", "0.1.0"}, instructions})
	case "ping":
		return ok(struct{}{})
	case "tools/list":
		list := make([]toolListEntry, len(tools))
		for i, t := range tools {
			list[i] = toolListEntry{t.name, t.description, json.RawMessage(t.schema)}
		}
		return ok(struct {
			Tools []toolListEntry `json:"tools"`
		}{list})
	case "tools/call":
		rawName, hasName := params["name"]
		name, nameIsStr := rawName.(string)
		if !nameIsStr || (findTool(name) == nil && !objectPrototype[name]) {
			return rpcError(id, -32602, "Unknown tool: "+jsString(rawName, hasName))
		}
		return ok(h.callToolResult(ctx, name, params["arguments"]))
	}
	if strings.HasPrefix(method, "notifications/") {
		return nil
	}
	if isNotification {
		return nil
	}
	return rpcError(id, -32601, "Method not found: "+method)
}

// Register installs GET/DELETE/POST /mcp on mux.
func Register(mux *http.ServeMux, d httpx.Dependencies) {
	mux.Handle("GET /mcp", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Allow", "POST")
		httpx.WriteJSON(w, http.StatusMethodNotAllowed, struct {
			Error string `json:"error"`
		}{"Use POST with a JSON-RPC body."})
		return nil
	}))
	mux.Handle("DELETE /mcp", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		w.Header().Set("Allow", "POST")
		w.WriteHeader(http.StatusMethodNotAllowed)
		return nil
	}))
	mux.Handle("POST /mcp", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		// Bearer API tokens only: cookie sessions are refused so the endpoint has
		// no CSRF surface. The challenge points OAuth-capable agents at the
		// authorization flow (plan 022).
		challenge, err := oauth.MCPChallenge(r, d)
		if err != nil {
			return err
		}
		unauthorized := func(msg string) error {
			w.Header().Set("WWW-Authenticate", challenge)
			httpx.WriteJSON(w, http.StatusUnauthorized, struct {
				Error string `json:"error"`
			}{msg})
			return nil
		}
		if _, ok := httpx.Bearer(r); !ok {
			return unauthorized("A Bearer API token is required.")
		}
		principal, err := httpx.Authenticate(r, d)
		if err != nil {
			var af *httpx.ApiFailure
			if errors.As(err, &af) && af.Status == http.StatusUnauthorized {
				return unauthorized(af.Message)
			}
			return err
		}
		parseError := func() error {
			httpx.WriteJSON(w, http.StatusBadRequest, rpcError(nil, -32700, "Parse error."))
			return nil
		}
		data, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
		if err != nil || len(data) > maxBodyBytes {
			return parseError()
		}
		body, perr := httpx.ParseJSON(data)
		if perr != nil {
			return parseError()
		}
		h := &handler{d, principal}
		ctx := r.Context()
		if batch, isBatch := body.([]any); isBatch {
			if len(batch) == 0 {
				httpx.WriteJSON(w, http.StatusBadRequest, rpcError(nil, -32600, "Empty batch."))
				return nil
			}
			replies := []any{}
			for _, m := range batch {
				if reply := h.handle(ctx, m); reply != nil {
					replies = append(replies, reply)
				}
			}
			if len(replies) == 0 {
				w.WriteHeader(http.StatusAccepted)
				return nil
			}
			httpx.WriteJSON(w, http.StatusOK, replies)
			return nil
		}
		reply := h.handle(ctx, body)
		if reply == nil {
			w.WriteHeader(http.StatusAccepted)
			return nil
		}
		httpx.WriteJSON(w, http.StatusOK, reply)
		return nil
	}))
}
