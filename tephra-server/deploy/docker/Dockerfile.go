# syntax=docker/dockerfile:1.7
# Go port of the Tephra server (plan 023). Additive: the Node Dockerfile stays the default.
# Build from the repo root:  docker build -f tephra-server/deploy/docker/Dockerfile.go -t tephra:go .
#   --build-arg WITH_OBSIDIAN_SYNC=true  adds Node + npm (needed only for official Obsidian
#                                         headless sync; glibc image, ~170 MB larger)
# Default (false): static distroless runtime, TEPHRA_OBSIDIAN_SYNC_ENABLED=false.
ARG WITH_OBSIDIAN_SYNC=false

# ---- web app (same as the Node image's build stage)
FROM node:22-bookworm-slim AS web
WORKDIR /app
COPY package.json package-lock.json ./
COPY tephra-plugin/package.json ./tephra-plugin/package.json
COPY tephra-server/apps/api/package.json ./tephra-server/apps/api/package.json
COPY tephra-server/apps/web/package.json ./tephra-server/apps/web/package.json
COPY tephra-server/packages ./tephra-server/packages
RUN npm ci
COPY tsconfig.base.json eslint.config.mjs .prettierrc.json ./
COPY tephra-plugin ./tephra-plugin
COPY tephra-server ./tephra-server
RUN npm run build

# ---- static Go binary
FROM golang:1.26-bookworm AS gobuild
WORKDIR /src
COPY tephra-server/go/go.mod tephra-server/go/go.sum ./
RUN go mod download
COPY tephra-server/go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/tephra-server ./cmd/tephra-server \
 && mkdir -p /out/data/blobs

# ---- runtime, Obsidian sync disabled (default): distroless, no shell, no Node
FROM gcr.io/distroless/static-debian12:nonroot AS runtime-false
ENV TEPHRA_OBSIDIAN_SYNC_ENABLED=false
COPY --from=gobuild --chown=nonroot:nonroot /out/data /data

# ---- runtime, Obsidian sync enabled: Node + npm for the official `obsidian-headless` CLI
FROM node:22-bookworm-slim AS runtime-true
RUN mkdir -p /data/blobs && chown -R node:node /data
USER node

FROM runtime-${WITH_OBSIDIAN_SYNC} AS runtime
# Same defaults as tephra-server/deploy/docker/Dockerfile (Node image).
ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    TEPHRA_DATABASE_DRIVER=sqlite \
    TEPHRA_SQLITE_PATH=/data/tephra.db \
    TEPHRA_BLOB_DRIVER=filesystem \
    TEPHRA_BLOB_PATH=/data/blobs \
    TEPHRA_MAX_BLOB_BYTES=104857600 \
    TEPHRA_OBSIDIAN_SYNC_PATH=/data/obsidian-sync \
    TEPHRA_OBSIDIAN_CACHE_PATH=/tmp/tephra-obsidian-client \
    TEPHRA_WEB_ROOT=/app/web
COPY --from=gobuild /out/tephra-server /usr/local/bin/tephra-server
COPY --from=web /app/tephra-server/apps/web/dist /app/web
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["/usr/local/bin/tephra-server", "healthcheck"]

ENTRYPOINT ["/usr/local/bin/tephra-server"]
