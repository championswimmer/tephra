# Go port of tephra-server (plan 023). Never run plain `go get` / `go mod tidy`:
# go.mod pins exact dependency versions.
BIN ?= bin/tephra-server

.PHONY: build test check fmt vet

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
