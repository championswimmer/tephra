package httpx

import (
	"errors"
	"log/slog"
	"net/http"
	"strings"

	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
)

// ApiFailure is a deliberate error response (TS ApiFailure).
type ApiFailure struct {
	Status  int
	Code    protocol.ApiErrorCode
	Message string
}

func (e *ApiFailure) Error() string { return string(e.Code) + ": " + e.Message }

// Fail builds an ApiFailure; handlers `return httpx.Fail(...)`.
func Fail(status int, code protocol.ApiErrorCode, message string) *ApiFailure {
	return &ApiFailure{Status: status, Code: code, Message: message}
}

// validationCode maps validation messages to an error code exactly like
// handleApiError in errors.ts.
func validationCode(ve *protocol.ValidationError) protocol.ApiErrorCode {
	has := func(m string) bool {
		for _, i := range ve.Issues {
			if i.Message == m {
				return true
			}
		}
		return false
	}
	if has("Duplicate manifest path.") {
		return protocol.CodeDuplicatePath
	}
	if has("Duplicate manifest file ID.") {
		return protocol.CodeDuplicateFileID
	}
	for _, i := range ve.Issues {
		if strings.Contains(i.Message, "canonical vault-relative path") {
			return protocol.CodeInvalidPath
		}
	}
	return protocol.CodeInvalidManifest
}

// StatusFromError is the HTTP status an error maps to (statusFromError).
func StatusFromError(err error) int {
	var f *ApiFailure
	var v *protocol.ValidationError
	switch {
	case errors.As(err, &f):
		return f.Status
	case errors.As(err, &v):
		return http.StatusBadRequest
	}
	return http.StatusInternalServerError
}

// WriteError renders err as the public error envelope (handleApiError).
// Unknown errors become 500 INTERNAL_ERROR and are logged without detail
// beyond the error text. If the response has already started it is a no-op.
func WriteError(w http.ResponseWriter, r *http.Request, err error) {
	if rw, ok := w.(interface{ Started() bool }); ok && rw.Started() {
		return
	}
	w.Header().Set("X-Request-Id", RequestID(r))
	var f *ApiFailure
	var v *protocol.ValidationError
	switch {
	case errors.As(err, &f):
		WriteJSON(w, f.Status, protocol.ApiErrorResponse{Error: protocol.ApiError{Code: f.Code, Message: f.Message}})
	case errors.As(err, &v):
		WriteJSON(w, http.StatusBadRequest, protocol.ApiErrorResponse{Error: protocol.ApiError{Code: validationCode(v), Message: "Request validation failed."}})
	default:
		slog.Error("Unhandled API error", "error", err.Error())
		WriteJSON(w, http.StatusInternalServerError, protocol.ApiErrorResponse{Error: protocol.ApiError{Code: protocol.CodeInternalError, Message: "An internal error occurred."}})
	}
}

// Validation builds a 400 validation error with the given messages.
func Validation(messages ...string) *protocol.ValidationError {
	ve := &protocol.ValidationError{}
	for _, m := range messages {
		ve.Issues = append(ve.Issues, protocol.Issue{Message: m})
	}
	return ve
}

// HandlerFunc is a route handler that reports failures by returning an error.
type HandlerFunc func(w http.ResponseWriter, r *http.Request) error

// Handle adapts a HandlerFunc to http.Handler; errors and panics are
// converted to the error envelope.
func Handle(fn HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if p := recover(); p != nil {
				if p == http.ErrAbortHandler {
					panic(p)
				}
				if e, ok := p.(error); ok {
					WriteError(w, r, e)
					return
				}
				WriteError(w, r, errors.New("panic"))
			}
		}()
		if err := fn(w, r); err != nil {
			WriteError(w, r, err)
		}
	})
}
