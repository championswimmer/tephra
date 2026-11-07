package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
	"time"
)

func TestHealthcheckURL(t *testing.T) {
	cases := []struct {
		env  map[string]string
		want string
	}{
		{nil, "http://127.0.0.1:8080/healthz"},
		{map[string]string{"HOST": "0.0.0.0", "PORT": "9000"}, "http://127.0.0.1:9000/healthz"},
		{map[string]string{"HOST": "::", "PORT": "1"}, "http://127.0.0.1:1/healthz"},
		{map[string]string{"HOST": "::1"}, "http://[::1]:8080/healthz"},
		{map[string]string{"HOST": "10.0.0.5", "PORT": " 81 "}, "http://10.0.0.5:81/healthz"},
	}
	for _, c := range cases {
		if got := healthcheckURL(env(c.env)); got != c.want {
			t.Errorf("%v: got %s want %s", c.env, got, c.want)
		}
	}
}

func TestRunHealthcheck(t *testing.T) {
	status := http.StatusOK
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/healthz" {
			w.WriteHeader(404)
			return
		}
		w.WriteHeader(status)
	}))
	defer srv.Close()
	u, _ := url.Parse(srv.URL)
	e := env(map[string]string{"HOST": u.Hostname(), "PORT": u.Port()})
	var errOut bytes.Buffer
	client := &http.Client{Timeout: time.Second}
	if code := runHealthcheck(e, client, &errOut); code != 0 {
		t.Fatalf("healthy server: exit %d (%s)", code, errOut.String())
	}
	status = http.StatusServiceUnavailable
	if code := runHealthcheck(e, client, &errOut); code != 1 {
		t.Fatalf("503 should fail, got %d", code)
	}
	srv.Close()
	if code := runHealthcheck(e, client, &errOut); code != 1 {
		t.Fatalf("closed server should fail, got %d", code)
	}
}
