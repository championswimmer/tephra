---
name: dev-server
description: Start the Tephra dev server with the sample vault, and restart it after code changes. Use whenever working on the server, web UI, or shared rendering packages and needing to run or reload the local server.
---

# Tephra Dev Server

## Prerequisites

- Node.js 22+, npm 10+.
- From the repository root: `npm install`.
- Configuration lives in `.env` at the repo root (see `.env.example`). Important keys:
  `HOST` / `PORT` (defaults `127.0.0.1` / `8080`),
  `TEPHRA_SQLITE_PATH` (default `./data/tephra.db`),
  `TEPHRA_BLOB_PATH` (default `./data/blobs`),
  `TEPHRA_WEB_ROOT` (default `./tephra-server/apps/web/dist`),
  `TEPHRA_BOOTSTRAP_TOKEN` (first-admin setup only).

## Start the server

```bash
npm run dev
```

This runs the API via tsx (`tephra-server/apps/api/src/main.ts`) and serves both
`/api/*` and the static web app on `TEPHRA_PUBLIC_URL` (default
`http://localhost:8080`).

## Load the sample vault

The sample vault source is `sample-vault/` at the repo root. Sync it into the
running server with:

```bash
npm run sync:vault
```

This runs `e2e/sync-vault.mjs`, which speaks the same plan/upload/commit sync
protocol as the Obsidian plugin. It imports from
`tephra-server/packages/protocol/dist`, so run `npm run build` first if that
package has never been built. Useful overrides:

```bash
TEPHRA_BASE=http://127.0.0.1:8080 VAULT_DIR=sample-vault npm run sync:vault
```

Defaults: `TEPHRA_BASE=http://127.0.0.1:8080`,
`TEPHRA_ADMIN_EMAIL=admin@example.com`,
`TEPHRA_ADMIN_PASSWORD=change-me-immediately`, `VAULT_DIR=sample-vault`.

## First-admin bootstrap (fresh data directory only)

1. Start Tephra with `TEPHRA_BOOTSTRAP_TOKEN` set.
2. Open `TEPHRA_PUBLIC_URL`. With no users present, the bootstrap page appears.
3. Enter the bootstrap token and create the administrator account.
4. Remove `TEPHRA_BOOTSTRAP_TOKEN` from the environment and restart.

The bootstrap endpoint is permanently disabled once a user exists.

## Restart the server after code changes

Two build gotchas — the dev server does **not** pick up everything from source:

1. **Shared packages resolve via `dist`, not `src`.** The API runs under tsx,
   but workspace imports such as `@tephra/markdown` (and `@tephra/protocol`)
   resolve to each package's `dist/` build. After editing a shared package,
   rebuild it:
   ```bash
   npm run build --workspace=@tephra/markdown
   ```
2. **The web app is served as a static build.** The API serves
   `TEPHRA_WEB_ROOT` (`tephra-server/apps/web/dist`). After editing anything
   under `tephra-server/apps/web/src` (components, styles, routes), rebuild it:
   ```bash
   npm run build --workspace=@tephra/web
   ```

Then restart the API (run from the repository root so relative `.env` and data
paths resolve):

```bash
PID=$(lsof -ti :8080 -sTCP:LISTEN)
kill "$PID"
nohup node --env-file=.env --import tsx tephra-server/apps/api/src/main.ts > /tmp/tephra-server.log 2>&1 &
curl -s -o /dev/null -w "HTTP %{http_code}\n" http://localhost:8080/
```

If `lsof` finds nothing, locate the process with
`ps aux | grep "apps/api/src/main.ts"` and kill that PID instead.
Confirm the restart in the log (`/tmp/tephra-server.log`) — a `GET / ... 200`
means the server is back up.
