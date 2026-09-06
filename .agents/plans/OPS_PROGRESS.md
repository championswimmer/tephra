# Delivery and Operations Progress

## Completed

- `.github/workflows/ci.yml`: Node 22 npm CI with cached `npm ci`, lint, typecheck, tests, and build.
- `tephra-server/deploy/docker/**`: multi-stage non-root image, persistent `/data`, Compose, healthcheck, and Docker ignore files.
- Railway Docker/volume configuration and deployment guide.
- Explicit AWS, Cloudflare, and Vercel adapter-status documentation.
- `tephra-server/.env.example` and comprehensive server setup/security/backup documentation.

## Verification reported by implementation agent

- `npm ci && npm run check` passed against the pre-fold baseline (23 tests).
- Prettier and `git diff --check` passed.
- Railway JSON and `docker compose config` validation passed.
- Docker image build was not run because no daemon was available.

## Runtime assumptions

The reference deployment is one Node 22 container serving API and built web assets with SQLite and filesystem blobs persisted together under `/data`. Cloud/serverless adapters are documented boundaries, not claimed working Stage 1 targets.

## Risks and next steps

1. Re-run CI after all feature branches and lockfile changes are folded.
2. Add the real API composition entrypoint and ensure the image copies migrations and web assets to the locations it expects.
3. Build and smoke-test the image when a Docker daemon is available.
4. Verify SPA fallback, secure-cookie/TLS proxy settings, shutdown behavior, volume ownership, and backup restore.
5. Keep unsupported provider docs explicit until PostgreSQL/object-store adapters exist and are tested.
