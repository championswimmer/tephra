package main

import (
	"net/http"
	"testing"
	"time"
)

// A client that stalls mid-request must not hold a connection forever (Node's
// requestTimeout is 300 s), while responses stay unbounded for slow downloads.
func TestHTTPServerLimits(t *testing.T) {
	srv := newHTTPServer(http.NotFoundHandler())
	if srv.ReadHeaderTimeout <= 0 || srv.ReadTimeout <= 0 || srv.ReadTimeout > 10*time.Minute {
		t.Errorf("read timeouts: header=%s body=%s", srv.ReadHeaderTimeout, srv.ReadTimeout)
	}
	if srv.WriteTimeout != 0 {
		t.Errorf("WriteTimeout must stay unset so large downloads are not cut off: %s", srv.WriteTimeout)
	}
	if srv.MaxHeaderBytes <= 0 || srv.MaxHeaderBytes > 1<<20 {
		t.Errorf("MaxHeaderBytes %d", srv.MaxHeaderBytes)
	}
}
