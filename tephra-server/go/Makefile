# Go port of tephra-server (plan 023). Never run plain `go get` / `go mod tidy`:
# go.mod pins exact dependency versions.
BIN ?= bin/tephra-server

.PHONY: build test check fmt vet dev

# Dev server on :3000 (the Vite dev proxy in apps/web targets it). Run from the repo root
# (`npm run dev`); data lives in ./data. Serves the built web app from apps/web/dist if present.
dev:
	HOST=127.0.0.1 PORT=3000 TEPHRA_BOOTSTRAP_TOKEN=$${TEPHRA_BOOTSTRAP_TOKEN:-dev-bootstrap-token} \
	TEPHRA_OBSIDIAN_SYNC_ENABLED=$${TEPHRA_OBSIDIAN_SYNC_ENABLED:-false} \
	TEPHRA_SQLITE_PATH=$(CURDIR)/../../data/tephra.db TEPHRA_BLOB_PATH=$(CURDIR)/../../data/blobs \
	TEPHRA_WEB_ROOT=$(CURDIR)/../apps/web/dist \
	go run ./cmd/tephra-server

build:
	CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o $(BIN) ./cmd/tephra-server

test:
	go test -race ./...
	TEPHRA_TEST_DB=sqlite go test -race ./...

fmt:
	gofmt -w .

vet:
	go vet ./...

check:
	@out="$$(gofmt -l .)"; if [ -n "$$out" ]; then echo "gofmt needed:"; echo "$$out"; exit 1; fi
	go vet ./...
	go test -race ./...
	TEPHRA_TEST_DB=sqlite go test -race ./...
