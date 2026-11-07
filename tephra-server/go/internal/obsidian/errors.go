// Package obsidian ports apps/api/src/obsidian/* and routes/obsidian-sync.ts:
// the native Obsidian Sync service that supervises the official
// `obsidian-headless` CLI (run as a Node subprocess), imports its checkout
// into the revisioned vault ledger, and exposes the owner setup routes.
package obsidian

import (
	"errors"
	"net/http"

	"github.com/championswimmer/tephra/tephra-server/go/internal/httpx"
	"github.com/championswimmer/tephra/tephra-server/go/internal/protocol"
)

// NativeFailure never exposes raw subprocess errors, paths, account data or
// command arguments: only the fixed code and message below reach clients.
func NativeFailure(code protocol.ApiErrorCode) *httpx.ApiFailure {
	var msg string
	status := http.StatusConflict
	switch code {
	case protocol.CodeObsidianUnavailable:
		msg = "The official Obsidian client could not be installed or started. Check server network access and retry."
		status = http.StatusServiceUnavailable
	case protocol.CodeObsidianLoginFailed:
		msg = "Obsidian sign-in failed. Check your credentials and try again."
		status = http.StatusUnauthorized
	case protocol.CodeObsidianMFARequired:
		msg = "Enter a current Obsidian two-factor authentication code and sign in again."
		status = http.StatusUnauthorized
	case protocol.CodeObsidianAuthExpired:
		msg = "Obsidian authentication has expired. Sign in again."
		status = http.StatusUnauthorized
	case protocol.CodeObsidianSetupFailed:
		msg = "Vault setup failed. Check your Sync subscription, remote vault and encryption password."
	case protocol.CodeObsidianCheckoutMiss:
		msg = "The local vault or Sync state is missing. Sign in if needed, then set up this remote vault again to download a fresh copy."
	default:
		code = protocol.CodeObsidianSyncFailed
		msg = "Obsidian Sync failed. Check connectivity and available disk space, then retry."
	}
	return httpx.Fail(status, code, msg)
}

// asFailure returns the *ApiFailure inside err, or nil.
func asFailure(err error) *httpx.ApiFailure {
	var f *httpx.ApiFailure
	if errors.As(err, &f) {
		return f
	}
	return nil
}

// orFailure keeps deliberate API failures and replaces anything else with the
// given generic native failure (raw errors may contain paths or secrets).
func orFailure(err error, code protocol.ApiErrorCode) error {
	if err == nil {
		return nil
	}
	if f := asFailure(err); f != nil {
		return f
	}
	return NativeFailure(code)
}
