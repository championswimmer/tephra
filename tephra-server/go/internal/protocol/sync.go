package protocol

// SyncBody is the body of POST sync/plan and sync/commit (identical shapes).
type SyncBody struct {
	DeviceID     string              `json:"deviceId"`
	ManifestHash string              `json:"manifestHash"`
	Files        []SyncManifestEntry `json:"files"`
}

type (
	SyncPlanBody   = SyncBody
	SyncCommitBody = SyncBody
)

func parseSyncBody(data []byte) (SyncBody, error) {
	var out SyncBody
	v, err := decodeJSON(data)
	if err != nil {
		return out, err
	}
	var c checker
	m := c.obj(v, "", "deviceId", "manifestHash", "files")
	out.DeviceID, _ = c.str(m, "deviceId", "", true, 1, 0)
	out.ManifestHash, _ = c.str(m, "manifestHash", "", true, 0, 0)
	if fv, ok := c.get(m, "files", "", true); ok {
		out.Files = c.manifestFromAny(fv, "files")
	}
	if len(c.issues) == 0 {
		c.checkSHA("manifestHash", out.ManifestHash)
		c.checkManifest("files", out.Files, true)
	}
	if err := c.err(); err != nil {
		return SyncBody{}, err
	}
	return out, nil
}

// ParseSyncPlanBody validates a sync plan request body (strict object).
func ParseSyncPlanBody(data []byte) (SyncPlanBody, error) { return parseSyncBody(data) }

// ParseSyncCommitBody validates a sync commit request body (strict object).
func ParseSyncCommitBody(data []byte) (SyncCommitBody, error) { return parseSyncBody(data) }

// MissingBlob is a blob the client must upload.
type MissingBlob struct {
	Hash string `json:"hash"`
	Size int64  `json:"size"`
}

// SyncPlanResponse status: "upload-required" | "up-to-date".
type SyncPlanResponse struct {
	Status               string        `json:"status"`
	LatestRevision       int64         `json:"latestRevision"`
	MissingBlobs         []MissingBlob `json:"missingBlobs"`
	ProtocolVersion      *string       `json:"protocolVersion,omitempty"`
	MinimumPluginVersion *string       `json:"minimumPluginVersion,omitempty"`
}

// SyncCommitResponse status: "committed" | "up-to-date".
type SyncCommitResponse struct {
	Status               string  `json:"status"`
	Revision             int64   `json:"revision"`
	ProtocolVersion      *string `json:"protocolVersion,omitempty"`
	MinimumPluginVersion *string `json:"minimumPluginVersion,omitempty"`
}

// BlobUploadResponse is the PUT blob response.
type BlobUploadResponse struct {
	Hash   string `json:"hash"`
	Stored bool   `json:"stored"`
}

func (c *checker) optVersionFields(m map[string]any) (*string, *string) {
	var pv, mv *string
	if s, ok := c.str(m, "protocolVersion", "", false, 1, 0); ok {
		pv = &s
	}
	if s, ok := c.str(m, "minimumPluginVersion", "", false, 1, 0); ok {
		mv = &s
	}
	return pv, mv
}

// ParseSyncPlanResponse validates a sync plan response.
func ParseSyncPlanResponse(data []byte) (SyncPlanResponse, error) {
	var out SyncPlanResponse
	v, err := decodeJSON(data)
	if err != nil {
		return out, err
	}
	var c checker
	m := c.obj(v, "", "status", "latestRevision", "missingBlobs", "protocolVersion", "minimumPluginVersion")
	out.Status, _ = c.enum(m, "status", "", true, "upload-required", "up-to-date")
	out.LatestRevision, _ = c.safeInt(m, "latestRevision", "", true, false)
	out.MissingBlobs = []MissingBlob{}
	if a, ok := c.arr(m, "missingBlobs", "", true); ok {
		for i, item := range a {
			p := idx("missingBlobs", i)
			bm := c.obj(item, p, "hash", "size")
			var mb MissingBlob
			if h, ok := c.str(bm, "hash", p, true, 0, 0); ok {
				c.checkSHA(join(p, "hash"), h)
				mb.Hash = h
			}
			mb.Size, _ = c.safeInt(bm, "size", p, true, false)
			out.MissingBlobs = append(out.MissingBlobs, mb)
		}
	}
	out.ProtocolVersion, out.MinimumPluginVersion = c.optVersionFields(m)
	if err := c.err(); err != nil {
		return SyncPlanResponse{}, err
	}
	return out, nil
}

// ParseSyncCommitResponse validates a sync commit response.
func ParseSyncCommitResponse(data []byte) (SyncCommitResponse, error) {
	var out SyncCommitResponse
	v, err := decodeJSON(data)
	if err != nil {
		return out, err
	}
	var c checker
	m := c.obj(v, "", "status", "revision", "protocolVersion", "minimumPluginVersion")
	out.Status, _ = c.enum(m, "status", "", true, "committed", "up-to-date")
	out.Revision, _ = c.safeInt(m, "revision", "", true, false)
	out.ProtocolVersion, out.MinimumPluginVersion = c.optVersionFields(m)
	if err := c.err(); err != nil {
		return SyncCommitResponse{}, err
	}
	return out, nil
}

// ParseBlobUploadResponse validates a blob upload response.
func ParseBlobUploadResponse(data []byte) (BlobUploadResponse, error) {
	var out BlobUploadResponse
	v, err := decodeJSON(data)
	if err != nil {
		return out, err
	}
	var c checker
	m := c.obj(v, "", "hash", "stored")
	if h, ok := c.str(m, "hash", "", true, 0, 0); ok {
		c.checkSHA("hash", h)
		out.Hash = h
	}
	out.Stored, _ = c.boolean(m, "stored", "", true)
	if err := c.err(); err != nil {
		return BlobUploadResponse{}, err
	}
	return out, nil
}
