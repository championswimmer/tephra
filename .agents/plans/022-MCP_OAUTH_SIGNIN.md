# MCP OAuth sign-in and agent setup page

> Status: implemented with this plan
> Depends on: `021-MCP_SERVER.md`

## Scope

Let coding agents obtain an MCP credential through a browser sign-in instead of a hand-copied token, using the
flow the MCP authorization spec (2025-06-18) defines and that Claude Code, Codex, Cursor and others already speak:
OAuth 2.1 authorization code + PKCE (S256), public clients, loopback redirect.

1. Agent calls `POST /mcp` without a token -> `401` with `WWW-Authenticate: Bearer resource_metadata=...` (RFC 9728).
2. Discovery: `/.well-known/oauth-protected-resource[/mcp]`, `/.well-known/oauth-authorization-server` (RFC 8414).
3. `POST /oauth/register` (RFC 7591) - stateless: the `client_id` (`tmc_<base64url json>`) embeds name + redirect URIs.
4. Agent opens `GET /oauth/authorize` in the browser -> validated, redirected to the web consent page `/connect`
   (login first if needed). The signed-in user picks a vault and read / read+edit access, then Authorize or Deny
   (`POST /api/v1/oauth/authorize`, cookie session + CSRF).
5. Server stores a 60 s single-use code (hash only, new `oauth_codes` table, migration 006) and returns the redirect
   URL; the browser navigates to the agent's callback.
6. `POST /oauth/token` verifies code + PKCE verifier + client + redirect, then creates an ordinary vault-bound
   API token (`MCP: <client name>`, scopes `vault:read-metadata` [+ `vault:write`], no expiry) and returns it as
   the access token. It is listed and revocable in the vault's Tokens UI.

Web app: Settings -> "MCP" (`/settings?tab=mcp`) with setup steps for Claude Code, Codex, Cursor,
Antigravity and Pi; consent page `/connect`.

## Non-goals

Refresh tokens / expiring tokens, client secrets, confidential clients, token introspection/revocation endpoints
(revocation stays in the Tokens UI), per-client allow-lists, multi-vault tokens, `plain` PKCE.

## Security notes

- Redirect URIs: loopback `http` (127.0.0.1 / localhost / [::1], any port when it matches a registration otherwise exact)
  or the IDE schemes `cursor:`, `vscode:`, `vscode-insiders:`. Anything else is refused and never redirected to.
- Codes are random (`tpc_`), stored hashed, consumed atomically before validation (single use even on failure), 60 s TTL.
- Approval requires a cookie session with CSRF; API tokens cannot approve. Consent shows the client's self-declared
  name and callback host; the client name is untrusted display text.
- Discovery origin comes from `TEPHRA_PUBLIC_URL` when set, otherwise `X-Forwarded-*`/request URL. Set it behind proxies.
- Tokens/codes are never logged. `/oauth/token` and `/oauth/register` send `Cache-Control: no-store` / open CORS (no credentials).

## Affected packages

`database/core` + `database/sqlite` (`oauthCodes` repository, migration 006), `apps/api` (`src/oauth/server.ts`,
`/mcp` challenge, `publicUrl` dependency, `TEPHRA_PUBLIC_URL`), `apps/web` (pages, client, vite proxy), docs/llms.txt.

## Migration / API consequences

Additive migration 006. New public endpoints under `/oauth/*` and `/.well-known/*`. Existing manual Bearer tokens unchanged.

## Verification

`apps/api/tests/oauth.test.ts` (discovery, DCR validation, redirect rules, PKCE, single use, expiry, scopes, CSRF/session
requirements, deny), sqlite repository test, web tests for the settings page and consent page. `npm run check`.

## Rollout risks

A user approving a malicious local process gets a write token for one vault (revocable, edits are revisions).
Public clients with open DCR can register freely; this is why the redirect rules are strict and consent is explicit.
