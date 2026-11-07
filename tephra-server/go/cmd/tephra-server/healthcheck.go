package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"time"
)

// healthcheckURL builds the local /healthz URL from HOST/PORT. Wildcard or
// empty hosts are probed through loopback.
func healthcheckURL(lookup func(string) (string, bool)) string {
	host, _ := lookup("HOST")
	host = strings.TrimSpace(host)
	if host == "" || host == "0.0.0.0" || host == "::" || host == "[::]" {
		host = "127.0.0.1"
	}
	host = strings.Trim(host, "[]")
	port, ok := lookup("PORT")
	if port = strings.TrimSpace(port); !ok || port == "" {
		port = "8080"
	}
	return "http://" + net.JoinHostPort(host, port) + "/healthz"
}

// runHealthcheck implements `tephra-server healthcheck` for container
// HEALTHCHECKs in images without a shell, curl or wget. Exit status 0 when
// /healthz answers 2xx within the timeout, 1 otherwise.
func runHealthcheck(lookup func(string) (string, bool), client *http.Client, stderr io.Writer) int {
	resp, err := client.Get(healthcheckURL(lookup))
	if err != nil {
		fmt.Fprintln(stderr, "healthcheck failed:", err)
		return 1
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 1<<16))
	if resp.StatusCode < 200 || resp.StatusCode > 299 {
		fmt.Fprintln(stderr, "healthcheck failed: status", resp.StatusCode)
		return 1
	}
	return 0
}

func defaultHealthClient() *http.Client { return &http.Client{Timeout: 4 * time.Second} }
