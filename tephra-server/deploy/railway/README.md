# Railway deployment

Railway runs the same Docker image as the single-container deployment. The checked-in
`railway.json` points Railway at `tephra-server/deploy/docker/Dockerfile` and configures
`GET /healthz` as the deployment health check.

## SQLite and filesystem profile

1. Create a Railway project from this repository.
2. Add a persistent volume to the Tephra service and mount it at `/data`.
3. Set `TEPHRA_PUBLIC_URL` to the service's HTTPS URL.
4. Generate and set strong, independent values for `TEPHRA_SESSION_SECRET` and
   `TEPHRA_BOOTSTRAP_TOKEN` in Railway Variables.
5. Keep the image defaults for SQLite and filesystem storage, or explicitly set:
   `TEPHRA_DATABASE_DRIVER=sqlite`, `TEPHRA_SQLITE_PATH=/data/tephra.db`,
   `TEPHRA_BLOB_DRIVER=filesystem`, and `TEPHRA_BLOB_PATH=/data/blobs`.
6. Deploy, complete bootstrap once, and then remove `TEPHRA_BOOTSTRAP_TOKEN` from the
   service variables.

Do not put secrets in `railway.json` or commit a Railway variable export. Back up the
mounted volume as described in the server README.

This profile must run as **one replica**. SQLite and local blobs are not shared between
replicas. Horizontal scaling requires the PostgreSQL database adapter and an
S3-compatible shared blob store; configure those only when those adapters are available
and tested for the release being deployed.
