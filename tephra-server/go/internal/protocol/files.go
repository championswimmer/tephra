package protocol

import "encoding/json"

// VaultFileDto is a file in files/tree/resolve responses.
type VaultFileDto struct {
	FileID   string  `json:"fileId"`
	Path     string  `json:"path"`
	BlobHash string  `json:"blobHash"`
	Size     int64   `json:"size"`
	Mtime    int64   `json:"mtime"`
	MimeType *string `json:"mimeType,omitempty"`
	Kind     string  `json:"kind"`
}

type FilesResponse struct {
	Revision int64          `json:"revision"`
	Files    []VaultFileDto `json:"files"`
}

// MarshalJSON renders a nil Files slice as [].
func (r FilesResponse) MarshalJSON() ([]byte, error) {
	type alias FilesResponse
	if r.Files == nil {
		r.Files = []VaultFileDto{}
	}
	return json.Marshal(alias(r))
}

func (c *checker) fileFromAny(v any, path string) VaultFileDto {
	var f VaultFileDto
	m := c.obj(v, path, "fileId", "path", "blobHash", "size", "mtime", "mimeType", "kind")
	if m == nil {
		return f
	}
	f.FileID, _ = c.str(m, "fileId", path, true, 1, 0)
	if s, ok := c.str(m, "path", path, true, 0, 0); ok {
		c.checkPath(join(path, "path"), s)
		f.Path = s
	}
	if s, ok := c.str(m, "blobHash", path, true, 0, 0); ok {
		c.checkSHA(join(path, "blobHash"), s)
		f.BlobHash = s
	}
	f.Size, _ = c.safeInt(m, "size", path, true, false)
	f.Mtime, _ = c.safeInt(m, "mtime", path, true, false)
	if s, ok := c.str(m, "mimeType", path, false, 1, 0); ok {
		f.MimeType = &s
	}
	f.Kind, _ = c.enum(m, "kind", path, true, "markdown", "attachment")
	return f
}

// ParseFilesResponse validates a files response.
func ParseFilesResponse(data []byte) (FilesResponse, error) {
	var out FilesResponse
	v, err := decodeJSON(data)
	if err != nil {
		return out, err
	}
	var c checker
	m := c.obj(v, "", "revision", "files")
	out.Revision, _ = c.safeInt(m, "revision", "", true, false)
	out.Files = []VaultFileDto{}
	if a, ok := c.arr(m, "files", "", true); ok {
		for i, item := range a {
			out.Files = append(out.Files, c.fileFromAny(item, idx("files", i)))
		}
	}
	if err := c.err(); err != nil {
		return FilesResponse{}, err
	}
	return out, nil
}

// ResolveResponse match: "exact" | "case" | "normalized" | "historic".
type ResolveResponse struct {
	Match           string       `json:"match"`
	RequestedPath   string       `json:"requestedPath"`
	CanonicalPath   string       `json:"canonicalPath"`
	File            VaultFileDto `json:"file"`
	MovedFromPath   *string      `json:"movedFromPath,omitempty"`
	MovedAtRevision *int64       `json:"movedAtRevision,omitempty"`
}

// ParseResolveResponse validates a resolve response.
func ParseResolveResponse(data []byte) (ResolveResponse, error) {
	var out ResolveResponse
	v, err := decodeJSON(data)
	if err != nil {
		return out, err
	}
	var c checker
	m := c.obj(v, "", "match", "requestedPath", "canonicalPath", "file", "movedFromPath", "movedAtRevision")
	out.Match, _ = c.enum(m, "match", "", true, "exact", "case", "normalized", "historic")
	out.RequestedPath, _ = c.str(m, "requestedPath", "", true, 1, 0)
	if s, ok := c.str(m, "canonicalPath", "", true, 0, 0); ok {
		c.checkPath("canonicalPath", s)
		out.CanonicalPath = s
	}
	if fv, ok := c.get(m, "file", "", true); ok {
		out.File = c.fileFromAny(fv, "file")
	}
	if s, ok := c.str(m, "movedFromPath", "", false, 0, 0); ok {
		c.checkPath("movedFromPath", s)
		out.MovedFromPath = &s
	}
	if n, ok := c.safeInt(m, "movedAtRevision", "", false, true); ok {
		out.MovedAtRevision = &n
	}
	if err := c.err(); err != nil {
		return ResolveResponse{}, err
	}
	return out, nil
}

// ChangeEntry is one pull-feed entry.
type ChangeEntry struct {
	FileID       string  `json:"fileId"`
	ChangeType   string  `json:"changeType"` // create | modify | rename | delete
	Path         string  `json:"path"`
	PreviousPath *string `json:"previousPath,omitempty"`
	BlobHash     *string `json:"blobHash,omitempty"`
	Size         *int64  `json:"size,omitempty"`
	Mtime        *int64  `json:"mtime,omitempty"`
	Kind         string  `json:"kind"`
	Revision     int64   `json:"revision"`
}

// ChangesResponse is the union of ChangesOK and ChangesFullResync.
type ChangesResponse interface{ isChangesResponse() }

// ChangesOK is {"status":"ok",...}. Status must be "ok" (use NewChangesOK).
type ChangesOK struct {
	Status         string        `json:"status"`
	FromRevision   int64         `json:"fromRevision"`
	ToRevision     int64         `json:"toRevision"`
	LatestRevision int64         `json:"latestRevision"`
	Truncated      bool          `json:"truncated"`
	Changes        []ChangeEntry `json:"changes"`
}

// ChangesFullResync is {"status":"full-resync-required","latestRevision":n}.
type ChangesFullResync struct {
	Status         string `json:"status"`
	LatestRevision int64  `json:"latestRevision"`
}

func (ChangesOK) isChangesResponse()         {}
func (ChangesFullResync) isChangesResponse() {}

// NewChangesOK builds an ok response with Status set.
func NewChangesOK(from, to, latest int64, truncated bool, changes []ChangeEntry) ChangesOK {
	return ChangesOK{Status: "ok", FromRevision: from, ToRevision: to, LatestRevision: latest, Truncated: truncated, Changes: changes}
}

// NewChangesFullResync builds a full-resync-required response.
func NewChangesFullResync(latest int64) ChangesFullResync {
	return ChangesFullResync{Status: "full-resync-required", LatestRevision: latest}
}

// MarshalJSON renders a nil Changes slice as [].
func (r ChangesOK) MarshalJSON() ([]byte, error) {
	type alias ChangesOK
	if r.Changes == nil {
		r.Changes = []ChangeEntry{}
	}
	return json.Marshal(alias(r))
}

func (c *checker) changeEntryFromAny(v any, path string) ChangeEntry {
	var e ChangeEntry
	m := c.obj(v, path, "fileId", "changeType", "path", "previousPath", "blobHash", "size", "mtime", "kind", "revision")
	if m == nil {
		return e
	}
	e.FileID, _ = c.str(m, "fileId", path, true, 1, 0)
	e.ChangeType, _ = c.enum(m, "changeType", path, true, "create", "modify", "rename", "delete")
	if s, ok := c.str(m, "path", path, true, 0, 0); ok {
		c.checkPath(join(path, "path"), s)
		e.Path = s
	}
	if s, ok := c.str(m, "previousPath", path, false, 0, 0); ok {
		c.checkPath(join(path, "previousPath"), s)
		e.PreviousPath = &s
	}
	if s, ok := c.str(m, "blobHash", path, false, 0, 0); ok {
		c.checkSHA(join(path, "blobHash"), s)
		e.BlobHash = &s
	}
	if n, ok := c.safeInt(m, "size", path, false, false); ok {
		e.Size = &n
	}
	if n, ok := c.safeInt(m, "mtime", path, false, false); ok {
		e.Mtime = &n
	}
	e.Kind, _ = c.enum(m, "kind", path, true, "markdown", "attachment")
	e.Revision, _ = c.safeInt(m, "revision", path, true, true)
	return e
}

// ParseChangesResponse validates a changes response, returning ChangesOK or
// ChangesFullResync (values, not pointers).
func ParseChangesResponse(data []byte) (ChangesResponse, error) {
	v, err := decodeJSON(data)
	if err != nil {
		return nil, err
	}
	var c checker
	root, isObj := v.(map[string]any)
	if !isObj {
		c.add("", "Expected object.")
		return nil, c.err()
	}
	switch root["status"] {
	case "ok":
		m := c.obj(v, "", "status", "fromRevision", "toRevision", "latestRevision", "truncated", "changes")
		out := ChangesOK{Status: "ok", Changes: []ChangeEntry{}}
		out.FromRevision, _ = c.safeInt(m, "fromRevision", "", true, false)
		out.ToRevision, _ = c.safeInt(m, "toRevision", "", true, false)
		out.LatestRevision, _ = c.safeInt(m, "latestRevision", "", true, false)
		out.Truncated, _ = c.boolean(m, "truncated", "", true)
		if a, ok := c.arr(m, "changes", "", true); ok {
			for i, item := range a {
				out.Changes = append(out.Changes, c.changeEntryFromAny(item, idx("changes", i)))
			}
		}
		if err := c.err(); err != nil {
			return nil, err
		}
		return out, nil
	case "full-resync-required":
		m := c.obj(v, "", "status", "latestRevision")
		out := ChangesFullResync{Status: "full-resync-required"}
		out.LatestRevision, _ = c.safeInt(m, "latestRevision", "", true, false)
		if err := c.err(); err != nil {
			return nil, err
		}
		return out, nil
	}
	c.add("status", "Invalid discriminator value.")
	return nil, c.err()
}

// SaveContentResponse status: "committed" | "up-to-date" (identical shapes).
type SaveContentResponse struct {
	Status   string `json:"status"`
	Revision int64  `json:"revision"`
	BlobHash string `json:"blobHash"`
	Size     int64  `json:"size"`
	Mtime    int64  `json:"mtime"`
}

// ParseSaveContentResponse validates a save-content response.
func ParseSaveContentResponse(data []byte) (SaveContentResponse, error) {
	var out SaveContentResponse
	v, err := decodeJSON(data)
	if err != nil {
		return out, err
	}
	var c checker
	m := c.obj(v, "", "status", "revision", "blobHash", "size", "mtime")
	out.Status, _ = c.enum(m, "status", "", true, "committed", "up-to-date")
	out.Revision, _ = c.safeInt(m, "revision", "", true, false)
	if s, ok := c.str(m, "blobHash", "", true, 0, 0); ok {
		c.checkSHA("blobHash", s)
		out.BlobHash = s
	}
	out.Size, _ = c.safeInt(m, "size", "", true, false)
	out.Mtime, _ = c.safeInt(m, "mtime", "", true, false)
	if err := c.err(); err != nil {
		return SaveContentResponse{}, err
	}
	return out, nil
}

// EditConflictCurrent is the server's current state in an EDIT_CONFLICT.
type EditConflictCurrent struct {
	BlobHash string `json:"blobHash"`
	Size     int64  `json:"size"`
	Mtime    int64  `json:"mtime"`
	Revision int64  `json:"revision"`
}

// EditConflictResponse is the 409 body: error envelope plus current state.
type EditConflictResponse struct {
	Error   ApiError            `json:"error"`
	Current EditConflictCurrent `json:"current"`
}

// ParseEditConflictResponse validates an edit-conflict response.
func ParseEditConflictResponse(data []byte) (EditConflictResponse, error) {
	var out EditConflictResponse
	v, err := decodeJSON(data)
	if err != nil {
		return out, err
	}
	var c checker
	m := c.obj(v, "", "error", "current")
	if ev, ok := c.get(m, "error", "", true); ok {
		em := c.obj(ev, "error", "code", "message")
		c.literal(em, "code", "error", string(CodeEditConflict))
		out.Error.Code = CodeEditConflict
		out.Error.Message, _ = c.str(em, "message", "error", true, 1, 0)
	}
	if cv, ok := c.get(m, "current", "", true); ok {
		cm := c.obj(cv, "current", "blobHash", "size", "mtime", "revision")
		if s, ok := c.str(cm, "blobHash", "current", true, 0, 0); ok {
			c.checkSHA("current.blobHash", s)
			out.Current.BlobHash = s
		}
		out.Current.Size, _ = c.safeInt(cm, "size", "current", true, false)
		out.Current.Mtime, _ = c.safeInt(cm, "mtime", "current", true, false)
		out.Current.Revision, _ = c.safeInt(cm, "revision", "current", true, false)
	}
	if err := c.err(); err != nil {
		return EditConflictResponse{}, err
	}
	return out, nil
}

// ParseApiErrorResponse validates the error envelope.
func ParseApiErrorResponse(data []byte) (ApiErrorResponse, error) {
	var out ApiErrorResponse
	v, err := decodeJSON(data)
	if err != nil {
		return out, err
	}
	var c checker
	m := c.obj(v, "", "error")
	if ev, ok := c.get(m, "error", "", true); ok {
		em := c.obj(ev, "error", "code", "message")
		var codes []string
		for _, k := range AllApiErrorCodes {
			codes = append(codes, string(k))
		}
		code, _ := c.enum(em, "code", "error", true, codes...)
		out.Error.Code = ApiErrorCode(code)
		out.Error.Message, _ = c.str(em, "message", "error", true, 1, 0)
	}
	if err := c.err(); err != nil {
		return ApiErrorResponse{}, err
	}
	return out, nil
}
