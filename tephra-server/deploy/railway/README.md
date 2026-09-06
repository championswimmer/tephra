# Railway deployment

Railway runs the same Docker image as the single-container deployment. The
checked-in `railway.json` points Railway at
`tephra-server/deploy/docker/Dockerfile`, checks `GET /healthz` after deploy,
and pins **one replica** (required for the SQLite/filesystem profile).
Field names follow the Railway config-as-code reference
(`railway.com/railway.schema.json`, researched September 2026).

## `railway.json` map

- `build.builder: "DOCKERFILE"` + `dockerfilePath` — build the repo Dockerfile.
- `deploy.healthcheckPath: "/healthz"` — Railway polls this on the injected
  `PORT` until it returns 2xx before switching traffic. Default timeout is
  300 s; ours is 120 s (raise it if cold starts exceed that).
- `deploy.numReplicas: 1` — mandatory while SQLite/filesystem blobs live on
  one volume. Volumes cannot be shared across replicas.
- `deploy.restartPolicyType: "ON_FAILURE"` + `restartPolicyMaxRetries: 10` —
  the documented defaults, stated explicitly.
- No `startCommand` — the image's `CMD` (`npm run start
--workspace=@tephra/api`) is already correct, and a custom start command
  would override the Docker entrypoint.

## Setup

1. Create a Railway project from this repository.
2. Add a persistent volume to the Tephra service and mount it at `/data`
   (volume attachment is dashboard/API-managed — it is **not** expressible in
   `railway.json`).
3. Set `TEPHRA_PUBLIC_URL` to the service's HTTPS URL. Once a public domain
   exists you can use the Railway-native value
   `TEPHRA_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}`.
4. Generate and set strong, independent values for `TEPHRA_SESSION_SECRET` and
   `TEPHRA_BOOTSTRAP_TOKEN` in Railway Variables (never in `railway.json` or
   git). The app binds `0.0.0.0:$PORT` using the injected `PORT` — do not set
   `PORT` manually.
5. Keep the image defaults for storage, or set explicitly:
   `TEPHRA_DATABASE_DRIVER=sqlite`, `TEPHRA_SQLITE_PATH=/data/tephra.db`,
   `TEPHRA_BLOB_DRIVER=filesystem`, `TEPHRA_BLOB_PATH=/data/blobs`.
6. Deploy, complete bootstrap once, then remove `TEPHRA_BOOTSTRAP_TOKEN` from
   the service variables.

Expect brief downtime on redeploys of volume-backed services (Railway blocks
two live mounts on one volume to prevent corruption), even with a healthcheck.

## Scaling and future paths

Horizontal scaling requires the PostgreSQL database adapter and an
S3-compatible shared blob store; configure those only when those adapters are
available and tested for the release being deployed.

Railway is migrating config-as-code (`railway.json`/`railway.toml`) toward
project-level Infrastructure as Code (`.railway/railway.ts`, with volumes and
replicas expressible in code). This repo intentionally keeps only
`railway.json` for now — a service cannot be managed by both systems at once —
and will migrate the service in one step when IaC is adopted.

## Backup

Back up the mounted volume as described in the server README (stop-consistent
archive or SQLite online backup coordinated with a blob copy). Protect backups
as private data.
