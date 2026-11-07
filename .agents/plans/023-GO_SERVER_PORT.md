# 023 — Port `tephra-server` API to Go

## Context and outcome

The Node API (`tephra-server/apps/api` + its `packages/*`, ≈7k LOC source, ≈3.8k LOC tests) is memory-heavy
at idle. Goal: a Go server that is a **1:1 feature-complete, wire-compatible** replacement: same HTTP API,
same SQLite schema/data files, same blob layout, same env vars, same web app, same plugin protocol.
An existing deployment must be able to stop the Node process and start the Go binary on the same `/data`
directory (and vice versa, for rollback).

**Hard rule from the owner:** the Node backend is NOT removed, replaced in Dockerfiles/deploy assets,
or marked deprecated until the Go version passes the parity suite (Phase 6). Go is additive until then.

## Scope

- New Go module at `tephra-server/go/` (module `github.com/championswimmer/tephra/tephra-server/go`),
  Go ≥ 1.22 (installed: 1.26). Binary: `cmd/tephra-server`.
- Port: protocol, vault-model (incl. revision diff), core (clock, UUIDv7), auth (scrypt), markdown
  (parse/render/callout/table/inline), link-resolver, indexer (+graph payload), database (SQLite repos,
  transactions, `lockVault`, migrations), blob-store (filesystem), all HTTP routes (auth, vaults, tokens,
  sync plan/blob/commit, changes, files/tree/search/resolve/rendered/links/backlinks, graph, web-edit,
  health), MCP server (`/mcp`), OAuth (`/oauth/*`, `/.well-known/*`), blob GC, runtime index service,
  Obsidian headless-sync service (`obsidian/*`), request logging, static web serving + SPA fallback,
  graceful shutdown, config from env.
- Parity harness (Phase 0/6) and Docker/deploy assets for Go (added alongside, not replacing).

## Non-goals

- No change to `tephra-web` (React/Vite) or `tephra-plugin`; Go serves the same `apps/web/dist`.
- No new features, no API changes, no schema changes (no new migration unless Node gets one too).
- No Postgres/S3 engines (the product is disk-only).
- Not porting `graph-renderer`, `markdown-editor`, `test-fixtures` (browser-side / test-only).
- Do not touch Node source except to add the parity harness hooks if strictly required.

## Invariants (must hold in Go; each needs a regression test)

- Original file bytes canonical; blobs immutable and **SHA-256 verified** on write; commits are revisioned
  and atomic under `lockVault` semantics (single writer per vault; use `BEGIN IMMEDIATE`).
- Manifest hash / canonical JSON must be **byte-identical** to the TS implementation (cross-implementation
  vectors generated from Node and checked into `go/internal/testdata/`).
- Password hashes: scrypt parameters/encoding identical to `packages/auth` so existing users log in. API token
  and session/OAuth-code hashing identical. Constant-time comparisons where the TS used them.
- Cookie names/attributes, error codes/JSON error envelope, status codes, header names, ETags, pagination and
  ordering identical to Node.
- Never log tokens, passwords, cookies, vault contents. Obsidian subprocess secrets never on argv/env.
- DB access only via repository interfaces; blob access only via the BlobStore interface.
- Pure-Go SQLite (`modernc.org/sqlite`, no CGO) so the binary is static and distroless-friendly. Same pragmas
  as `openSqliteDatabase` (WAL, foreign_keys, busy_timeout…), same `PRAGMA user_version` migration chain,
  migrations embedded from a copy of `tephra-server/migrations/sqlite` (a test asserts the copy equals the original).
- Markdown/link-resolution behaviour must match TS exactly (shared browser package stays the web's source;
  Go port is verified against shared vectors).
- Minimal dependencies: stdlib `net/http` (Go 1.22 ServeMux patterns), `database/sql`, `log/slog`; third-party
  only for sqlite and `golang.org/x/crypto/scrypt` (or `x/crypto` equivalents), uuid not needed (own UUIDv7).

## Layout and ownership (non-overlapping for parallel work)

```
tephra-server/go/
  go.mod
  cmd/tephra-server/main.go            # P5 (config, wiring, shutdown, static)
  internal/core/                       # P1-A  clock, UUIDv7, ids
  internal/vaultmodel/                 # P1-A  entities, revision diff
  internal/protocol/                   # P1-A  manifest, canonical JSON, hashing, validation, errors, versioning
  internal/db/                         # P1-A  repository interfaces (mirror database/core)
  internal/db/sqlite/                  # P2-D  impl, migrate, embedded migrations
  internal/blobstore/ (+fs/)           # P1-C  interface + filesystem impl
  internal/auth/                       # P1-C  scrypt hasher, token generation/hash
  internal/markdown/                   # P1-B
  internal/linkresolver/               # P1-B
  internal/indexer/                    # P2-E  note index + graph payload
  internal/httpx/                      # P2-F  router helpers, error envelope, JSON body, request log, auth+vault middleware, DTOs
  internal/api/                        # P2-F routes: health/auth/vaults/tokens
                                       # P3-G  routes: sync, changes, files, graph, web-edit; blobgc; runtime index
  internal/mcp/, internal/oauth/       # P3-H
  internal/obsidian/                   # P3-I  service, checkout, cli (subprocess), routes
  internal/testutil/                   # P2-F shared test helpers (in-memory db, temp blob store, fake clock)
.agents/ , e2e/parity/                 # P0-J  black-box parity harness (Node script, runs against any base URL)
```
Each package: `*_test.go` ported from the matching vitest file(s) (same cases, same expectations).

## Phases

0. **Plan + parity harness (J, parallel with Phase 1).** `e2e/parity/`: a Node ESM script (no deps beyond
   built-ins) that, given `BASE_URL`, runs a scripted scenario (bootstrap admin, login, create vault, token,
   sync plan→blob PUT→commit, changes, files/tree/search/resolve/rendered/links/backlinks, graph + ETag/304,
   web edit incl. conflict, token delete, OAuth register/authorize/token + `/mcp` tool calls, health/ready,
   error cases/validation, vault delete) and records normalised responses (ids/timestamps/tokens redacted by
   shape). Output JSON snapshot; `compare.mjs` diffs two snapshots. Run against Node first to produce the golden
   snapshot (checked in). Also exports cross-implementation vectors (manifest hashes, canonical JSON, scrypt
   hashes, markdown→HTML/render cases, link-resolution cases) from the TS packages into `go/internal/testdata/`.
1. **Foundations (parallel A, B, C).**
   A: module scaffold, `core`, `vaultmodel`, `protocol`, `db` interfaces.
   B: `markdown`, `linkresolver`.
   C: `auth`, `blobstore` + filesystem.
2. **Persistence + HTTP skeleton (parallel D, E, F)** — start once A's types land.
   D: sqlite repos/migrations/transactions. E: indexer. F: httpx + auth/vault middleware + health/auth/vaults/tokens routes.
3. **Feature routes (parallel G, H, I)** — start once D+F land.
   G: sync/changes/files/graph/web-edit/blobgc/runtime-index. H: MCP + OAuth. I: Obsidian sync service/routes.
4. **Integration (K).** `cmd/tephra-server/main.go`: env config (all vars listed below), wiring, SPA static
   serving + `/favicon.ico`, graceful shutdown (10 s force), `Makefile`/npm script `go:*`, CI-able
   `npm run check:go` (`go vet`, `gofmt -l`, `go test -race ./...`), staticcheck if available.
5. **Parity + safety (L).** Run parity harness against Go and Node; fix all diffs. Cross-open test: DB+blobs
   created by Node opened by Go and the reverse. Load/memory benchmark (idle RSS, RSS under sync of a
   1k-file vault) recorded in PROGRESS.md. Security-invariant regression tests (hash verify, path traversal,
   auth scope/vault scoping, secret logging).
6. **Packaging (M, only after Phase 5 green).** `deploy/docker/Dockerfile.go` (multi-stage, static binary,
   distroless/alpine + node only if Obsidian sync enabled — see risks), compose variant, README/deploy docs,
   `PROGRESS.md`. Node Dockerfile and default deploy assets stay untouched; switching defaults is a separate,
   owner-approved follow-up.

Env vars to support (identical semantics): `HOST`, `PORT`, `NODE_ENV` (→ secure cookies when `production`),
`TEPHRA_DATABASE_DRIVER`, `TEPHRA_BLOB_DRIVER` (both must be sqlite/filesystem else fail), `TEPHRA_SQLITE_PATH`,
`TEPHRA_BLOB_PATH`, `TEPHRA_BOOTSTRAP_TOKEN`, `TEPHRA_PUBLIC_URL`, `TEPHRA_MAX_BLOB_BYTES`, `TEPHRA_WEB_ROOT`,
`TEPHRA_OBSIDIAN_SYNC_ENABLED`, `TEPHRA_OBSIDIAN_SYNC_PATH`, `TEPHRA_OBSIDIAN_CACHE_PATH`,
`TEPHRA_OBSIDIAN_MAX_VAULTS`, `TEPHRA_OBSIDIAN_SCAN_INTERVAL_SECS`.

## API / schema / migration consequences

None by design. Same endpoints, same SQLite schema (user_version 7), same blob layout. Go and Node are
interchangeable on one data dir (not run concurrently).

## Verification

- `cd tephra-server/go && gofmt -l . && go vet ./... && go test -race ./...`
- Parity: `node e2e/parity/run.mjs --base http://127.0.0.1:PORT --out go.json` vs checked-in Node golden; `compare.mjs` must report 0 diffs.
- Existing `npm run check` must stay green (Node untouched).
- Memory benchmark documented.

## Risks

- **Obsidian headless sync** runs the official `obsidian-headless` npm CLI as a subprocess (Node). The Go
  server keeps launching it identically (secrets via stdin launcher, output limits). Runtime image must
  include Node only for this feature; idle memory is unaffected when no sync vault is active. Document it.
- Markdown/render subtle divergence → mitigate with TS-generated vectors and parity snapshots.
- scrypt/canonical-JSON/number formatting (JS number vs Go int64/float) divergences → vectors.
- JSON key order / HTML escaping (Go escapes `<>&` by default; use `SetEscapeHTML(false)`) and `null` vs omitted
  fields — the TS shapes are authoritative.
- SQLite concurrency: pure-Go driver, WAL, single write connection + read pool; commit path under `BEGIN IMMEDIATE`.
- Rollback: Node binary remains deployable on the same data dir at all times.

## Completion checklist

- [ ] Phase 0 harness + golden snapshot + vectors
- [ ] Phase 1 A/B/C merged, tests green
- [ ] Phase 2 D/E/F merged
- [ ] Phase 3 G/H/I merged
- [ ] Phase 4 binary runs web app end-to-end
- [ ] Phase 5 parity 0 diffs, cross-open OK, benchmark recorded
- [ ] Phase 6 Go Docker/docs added; Node still default
- [ ] `npm run check` and Go checks green; PROGRESS.md updated with verified facts only; plan deleted when complete and committed
