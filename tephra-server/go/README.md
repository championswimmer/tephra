# tephra-server (Go)

Go port of the Tephra API server. See `.agents/plans/023-GO_SERVER_PORT.md`.
The Node implementation remains the default; the Go server is an additive, drop-in alternative on the
same data directory (see [Running the Go server](#running-the-go-server)).

```sh
cd tephra-server/go
gofmt -l . && go vet ./... && go test -race ./...
```

## Build and run

```sh
npm run go:build   # CGO-free static binary at tephra-server/go/bin/tephra-server (make -C tephra-server/go build)
npm run go:test    # go test -race, default and TEPHRA_TEST_DB=sqlite
npm run go:check   # gofmt -l (must be empty), go vet, go test -race (both DB modes)
```

Never run plain `go get` / `go mod tidy`; `go.mod` pins exact versions.

`cmd/tephra-server` reads the same environment as the Node API (`HOST`, `PORT`, `NODE_ENV`,
`TEPHRA_DATABASE_DRIVER`, `TEPHRA_BLOB_DRIVER`, `TEPHRA_SQLITE_PATH`, `TEPHRA_BLOB_PATH`,
`TEPHRA_BOOTSTRAP_TOKEN`, `TEPHRA_PUBLIC_URL`, `TEPHRA_MAX_BLOB_BYTES`, `TEPHRA_WEB_ROOT`,
`TEPHRA_OBSIDIAN_SYNC_ENABLED|PATH|CACHE_PATH|MAX_VAULTS|SCAN_INTERVAL_SECS`). It serves the built web
app from `TEPHRA_WEB_ROOT` (files streamed from disk, `/favicon.ico` is `logo-main.svg`, unmatched GETs
fall back to `index.html`, like Node; no cache headers are sent, also like Node).

### Memory tuning

Unless `GOGC` is set the binary uses `GOGC=50` (more frequent, smaller heaps). For hard caps set
`GOMEMLIMIT` (e.g. `GOMEMLIMIT=200MiB`); the runtime then collects more aggressively near the limit.
The HTTP server sets only `ReadHeaderTimeout` (15 s) and `IdleTimeout` (120 s): there is deliberately no
read/write timeout so large blob uploads and downloads on slow links are not cut off. Shutdown on
SIGINT/SIGTERM drains connections and force-exits with status 1 after 10 s.

### Parity check against the Node golden

```sh
node e2e/parity/run.mjs --base http://127.0.0.1:$PORT --out /tmp/go.json --bootstrap-token "$TOKEN"
node e2e/parity/compare.mjs e2e/parity/golden/node.json /tmp/go.json
```

## Running the Go server

Direct: `npm run go:build`, then (after `npm run build` for the web app) e.g.

```sh
HOST=127.0.0.1 PORT=8080 TEPHRA_BOOTSTRAP_TOKEN=change-me TEPHRA_OBSIDIAN_SYNC_ENABLED=false \
TEPHRA_SQLITE_PATH=./data/tephra.db TEPHRA_BLOB_PATH=./data/blobs \
TEPHRA_WEB_ROOT=tephra-server/apps/web/dist tephra-server/go/bin/tephra-server
```

Docker (additive; `deploy/docker/Dockerfile` and `compose.yml` for Node are unchanged and remain the default):

```sh
docker build -f tephra-server/deploy/docker/Dockerfile.go -t tephra:go .                 # distroless, no Node
docker build -f tephra-server/deploy/docker/Dockerfile.go --build-arg WITH_OBSIDIAN_SYNC=true -t tephra:go-sync .
TEPHRA_BOOTSTRAP_TOKEN=change-me docker compose -f tephra-server/deploy/docker/compose.go.yml up --build
```

- Environment variables are identical to the Node server (list above) and the image sets the same defaults as
  the Node image (`/data/tephra.db`, `/data/blobs`, 100 MiB blob limit, `NODE_ENV=production`). The only
  difference: with `WITH_OBSIDIAN_SYNC=false` (default) the image sets `TEPHRA_OBSIDIAN_SYNC_ENABLED=false`
  because there is no Node/npm to run the official headless client. With `true` the runtime is
  `node:22-bookworm-slim` (Node + npm, used only by the Obsidian sync feature) and sync stays enabled like in
  the Node image. `TEPHRA_SESSION_SECRET` is not read by either server.
- `tephra-server healthcheck` (no shell/curl needed) probes `http://127.0.0.1:$PORT/healthz`, exit 0 when 2xx;
  it is the image `HEALTHCHECK`.
- Switching Node <-> Go: stop one, start the other on the same data directory/volume. Never run both at once.
  Rollback to Node is just starting the Node image on the same volume. Verified in both directions by
  `node e2e/parity/cross-open.mjs` (see `e2e/parity/README.md`).
- WAL: the Go server (like the Node one) runs SQLite in WAL mode, so `tephra.db-wal`/`tephra.db-shm` may
  exist next to `tephra.db` while running. A clean shutdown (SIGTERM/SIGINT) checkpoints and removes them;
  after a crash they hold committed data and must stay with the database (back up all three files, or
  stop the server first). Opening with the other implementation recovers them automatically.
