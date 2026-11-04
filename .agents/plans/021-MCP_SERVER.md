# MCP Server (`/mcp`)

> Status: implemented with this plan
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`, web editing write path (`routes/web-edit.ts`)

## Scope

A Streamable-HTTP Model Context Protocol endpoint at `POST /mcp` on every Tephra server so AI agents
can work with a vault. Tools:

- `list_vaults` – vaults the credential can reach.
- `search_notes` – search by path/title (reuses the REST search implementation).
- `read_note` – fetch a Markdown note (content, blob hash, revision) by path.
- `create_note` – add a new `.md` note; fails if the path (case-insensitively) exists.
- `update_note` – edit an existing note by **unified diff** (`patch`) or **full replacement** (`content`).

Also `GET /llms.txt` at the site root (web app `public/` and the marketing website `public/`)
documenting the endpoint, auth and tools.

## Non-goals

SSE streaming/server-initiated messages, MCP sessions, OAuth, delete/rename, attachment writes,
resources/prompts capabilities.

## Design

- Stateless JSON-RPC 2.0 over POST (spec 2025-03-26 Streamable HTTP; responses are plain JSON).
  `GET /mcp` returns 405. Implemented without an SDK dependency (small surface, no new packages).
- Auth: `Authorization: Bearer <api token>` only (cookies are rejected, so no CSRF/DNS-rebinding
  surface). Read tools need `vault:read-metadata`; write tools need `vault:write`. A token is bound
  to one vault; session bearers (owner) pass `vault` explicitly.
- Writes share one commit helper modelled on the web-edit path: blob stored via `storeBlobIfAbsent`
  (server-computed SHA-256), a single transaction under `lockVault`, one revision + `diffRevision`
  ledger row, synthetic device `mcp:<userId>`, graph cache drop and re-index afterwards.
- Optimistic concurrency: `update_note` with `content` requires `base_hash`; `patch` is applied to the
  current content inside the transaction (context must match exactly, else conflict) and may carry
  `base_hash`.
- Never log note contents or tokens.

## Affected packages

`tephra-server/apps/api` (new `src/mcp/*`, `app.ts`, exported `authenticate`), web + website `public/llms.txt`,
README/PROGRESS docs.

## Migration / API consequences

None to the DB or REST API. New public endpoint `/mcp` and `/llms.txt`.

## Verification

Vitest in `apps/api/tests/mcp.test.ts`: auth (no token, cookie-only, wrong scope, other vault), initialize/tools list,
search/read/create/update (patch + full), conflicts, bad patches, path validation, revision ledger.
`npm run check`.

## Rollout risks

Write-capable token handed to an agent can modify notes; mitigated by existing scoped, revocable tokens
and revisioned history (every edit is a new revision).
