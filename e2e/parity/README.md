# Black-box API parity harness

Runs one deterministic scripted scenario (437 requests) against a **fresh** Tephra server and writes a
normalised JSON snapshot. Snapshots from the Node server and the Go server (plan 023) must be identical.
Dependency-free: Node >= 22 built-ins and global `fetch` only.

## Usage

```bash
# 1. Snapshot any running, freshly started server (empty data dir, TEPHRA_BOOTSTRAP_TOKEN set,
#    TEPHRA_OBSIDIAN_SYNC_ENABLED=false, serving the built web app so static/SPA routes exist):
node e2e/parity/run.mjs --base http://127.0.0.1:8080 --out /tmp/go.json --bootstrap-token "$TOKEN"

# 2. Compare against the checked-in Node golden (exit 1 + readable diff on any difference):
node e2e/parity/compare.mjs e2e/parity/golden/node.json /tmp/go.json

# Regenerate the golden from the Node server (starts it on a free port with temp sqlite/blob dirs,
# runs the scenario, kills it; needs `npm run build` first):
node e2e/parity/run-node.mjs --out e2e/parity/golden/node.json
```

`TEPHRA_BOOTSTRAP_TOKEN` may be used instead of `--bootstrap-token`. The server must be **fresh**: the
scenario bootstraps the first admin user and creates vaults named `alpha`/`beta`/`gamma`. It deletes
its own vaults at the end. Do not set `TEPHRA_PUBLIC_URL` (OAuth metadata is checked against the request
origin and `X-Forwarded-*`); leave `NODE_ENV` unset (cookies are then recorded without `Secure`).

`compare.mjs` flags: `--strict-soft` also fails on "soft" steps (see below).

## What is recorded per step

`{n, name, method, path, status, headers, body}`:

- headers: `content-type, etag, cache-control, allow, www-authenticate, location, content-disposition,
content-security-policy, x-content-type-options, access-control-*, vary, pragma`, `x-request-id`
  (`<uuid>` or `<echo>`), and `set-cookie` as `name=<secret>; Path=/; HttpOnly; SameSite=Lax; Max-Age=...`
  (value replaced, attributes/flags kept).
- body: JSON (key order preserved), small text, or `{bytes, sha256}` for binary/HTML. JSON embedded in
  strings (MCP `content[].text`) is parsed and normalised structurally.
- Normalisation: UUIDs -> `<id:n>` numbered by first appearance across the whole run; `tp?_...` opaque
  tokens -> `<secret>`; server base URL/host -> `<base>`/`<host>`; millisecond timestamps in
  `createdAt/updatedAt/lastSeenAt/lastUsedAt/revokedAt/lastSyncedAt/mtime` (values >= 1e11) and
  `client_id_issued_at` -> `<ts>`. Content hashes, client-supplied mtimes, manifest hashes, revisions,
  ETags (`W/"<rev>-<indexedRev>-graph-v3"`) are deterministic and kept verbatim.
- Ordering is never sorted by the harness EXCEPT the lists below.

## Order-canonicalisation exceptions (Node itself is non-deterministic there)

Node orders these by a tie-breaker of random UUIDv7 ids (same-millisecond rows), so the order differs
between two runs of the _Node_ server. The harness puts them in a canonical order before comparing;
the Go port may use any tie-break, but must return the same set (and the same graph edge multiset):

- `GET /vaults` -> by name; `GET .../tokens` -> by (name, scopes, expiresAt)
- `GET .../links`, `.../files/:id/links`, `.../backlinks` -> by link content (excluding `id`)
- `GET .../graph` `edges` -> by (s, t)
- `GET .../changes`: a non-truncated page is sorted by (revision, path); a **truncated** page is recorded
  only as `{count, revisions}` because the cut point inside one revision depends on the random order.
- The scenario keeps rename+modify of one file in a revision of its own because Node only collapses them
  into a single change entry when the two rows happen to be adjacent in id order.

## Soft steps

Steps flagged `soft` embed zod validation text in MCP tool error messages
(`Invalid arguments: query: Too small: ...`). `compare.mjs` reports them as `SOFT` warnings without
failing unless `--strict-soft`. A Go port may choose to replicate the messages exactly.

## Scenarios covered

Health/readiness (+HEAD, request-id echo/regeneration); bootstrap status & creation (validation, alias
field, wrong token, repeat 409, email lower-casing); login/logout/me (cookies + CSRF cookie flags, session
as bearer, CSRF missing/wrong/alt header, 2 MB body limit); obsidian-sync capability routes in the
disabled form (503 / `available:false`, per-vault 409 sync-mode mismatch, obsidian vault creation 503);
vaults (create/validation/duplicate/trim, get by id and name, list, delete confirmation, cascade of
tokens); API tokens (scopes, devices, expiry, revoke, listing, session-only enforcement, wrong-vault and
wrong-scope 403, revoked/expired 401 `TOKEN_REVOKED`); sync plan/blob PUT/commit (manifest hash,
duplicate path/fileId, invalid path, unsorted, hash/size mismatch, 413, missing blobs 409, idempotent
commit by manifest hash, old-manifest recommit, up-to-date); reads (files/tree/file/content/raw/
attachments incl. html/svg forced download headers and octet-stream, rendered Markdown with wikilinks,
embeds, callouts, tables, tags, footnotes, links/backlinks/all links, search with title match/limits/
validation); resolve (exact, NFD->normalized, case, ambiguous 409, historic rename, deleted 410, 404,
400s); changes (pagination, truncation, clamp, 400s, full-resync, rename/delete/create/modify entries,
empty vault); graph (ETag, `If-None-Match` 304, stale etag, token read, scope 403, new etag after edits);
web edit (If-Match missing/malformed/stale 409 `EDIT_CONFLICT`, up-to-date, angle-bracket and quoted
If-Match, size mismatch, 413, CSRF, scopes incl. `vault:write`-only, non-markdown 400, bearer session);
MCP (auth/401 challenge, 405s, parse error, batch, initialize, ping, notifications, tools/list, every
tool incl. error paths, patches, conflicts, scopes, session-as-bearer vault disambiguation); OAuth
(discovery metadata, forwarded headers, CORS preflight, dynamic registration validation, authorize
redirects and refusals, consent client info, approve/deny, PKCE token exchange via form and JSON, single
use, wrong verifier/client/redirect, read-only vs write tokens used on `/mcp` and REST); static index,
hashed asset, `/favicon.ico`, SPA fallback, unknown routes; post-delete behaviour.

## Not coverable (black-box limits)

- Only one user can exist (no register endpoint), so cross-owner access (another user's vault/device,
  `Device belongs to another user`) is not exercised.
- Obsidian-mode vaults cannot be created with sync disabled, so `readOnly`/`obsidianSync` vault fields,
  native login/setup/remotes/enable and obsidian write-through paths are only checked in their
  unavailable form. The `/readyz` 503 path and 500 `INTERNAL_ERROR` need fault injection.
- Code expiry (60 s TTL), session expiry (30 d), 100 MB blob limit (413 on actual bytes; only the
  declared-size check is tested) and the 10 k graph-node cap need long waits or huge payloads.
- `Secure` cookie variant (requires `NODE_ENV=production` + TLS), and `X-Request-Id`/log-line contents
  beyond the header.

## Cross-open and memory benchmark

Both need `npm run build` and `npm run go:build`, Linux, and use temp dirs/ephemeral ports.

```bash
node e2e/parity/cross-open.mjs      # Node<->Go on one data dir, both directions + Go SIGKILL -> Node (WAL)
node e2e/parity/bench-memory.mjs    # VmRSS/VmHWM from /proc: idle, after parity scenario, after ~1000-note sync
```

`cross-open.mjs` seeds a data dir with server A (bootstrap, vault, API token, sync commits with notes,
PNG and binary attachments, rename, delete, web edit), stops it with SIGTERM, starts server B on the same dir
and checks login with A's password hash, A's API token, identical reads (vault, files, tree, changes, graph,
links, search, content/raw/rendered), a new commit plus web edit, then returns to A. It also runs
`PRAGMA integrity_check` (needs the `sqlite3` CLI) and reports leftover `-wal`/`-shm` files.
