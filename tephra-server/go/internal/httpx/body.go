package httpx

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"strconv"

	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
)

// JSONLimit is the maximum JSON request body (2 MiB).
const JSONLimit = 2 * 1024 * 1024

// ReadJSONBytes reads the request body enforcing JSONLimit (413
// INVALID_MANIFEST) both for the declared Content-Length and the actual bytes.
// The content type is deliberately not checked, as in the TS server.
func ReadJSONBytes(r *http.Request) ([]byte, error) {
	if cl := r.Header.Get("Content-Length"); cl != "" {
		if declared, err := strconv.ParseFloat(cl, 64); err == nil && declared > JSONLimit {
			return nil, Fail(http.StatusRequestEntityTooLarge, protocol.CodeInvalidManifest, "Request body is too large.")
		}
	}
	if r.Body == nil {
		return nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(r.Body, JSONLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > JSONLimit {
		return nil, Fail(http.StatusRequestEntityTooLarge, protocol.CodeInvalidManifest, "Request body is too large.")
	}
	return data, nil
}

// ParseJSON decodes like JSON.parse (a leading BOM is dropped, as
// Request.text() does). Numbers are returned as json.Number. Invalid JSON is
// 400 INVALID_MANIFEST "Request body must be valid JSON.".
func ParseJSON(data []byte) (any, error) {
	data = bytes.TrimPrefix(data, []byte("\xef\xbb\xbf"))
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	var v any
	if err := dec.Decode(&v); err != nil {
		return nil, Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Request body must be valid JSON.")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, Fail(http.StatusBadRequest, protocol.CodeInvalidManifest, "Request body must be valid JSON.")
	}
	return v, nil
}

// JSONBody reads and parses the request JSON body (jsonBody without the schema).
func JSONBody(r *http.Request) (any, error) {
	data, err := ReadJSONBytes(r)
	if err != nil {
		return nil, err
	}
	return ParseJSON(data)
}
