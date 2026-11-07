package api

import (
	"net/http"

	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
)

// RegisterHealthRoutes registers GET /healthz and GET /readyz.
func RegisterHealthRoutes(mux *http.ServeMux, d Dependencies) {
	mux.Handle("GET /healthz", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ok"})
		return nil
	}))
	mux.Handle("GET /readyz", httpx.Handle(func(w http.ResponseWriter, r *http.Request) error {
		if _, err := d.Database.Users().Count(r.Context()); err != nil {
			httpx.WriteJSON(w, http.StatusServiceUnavailable, protocol.ApiErrorResponse{
				Error: protocol.ApiError{Code: protocol.CodeInternalError, Message: "Service is not ready."},
			})
			return nil
		}
		httpx.WriteJSON(w, http.StatusOK, map[string]string{"status": "ready"})
		return nil
	}))
}
