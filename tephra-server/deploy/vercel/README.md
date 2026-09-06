# Vercel adapter contract (Stage 1)

The single-process Node Docker image is **not** a Vercel Functions deployment. This
directory intentionally contains no `vercel.json` that would imply otherwise.

A supported Vercel adapter must provide:

- the Vite build as static web output,
- a Vercel Functions API entrypoint with routes equivalent to `/api/v1/*`, `/healthz`,
  and `/readyz`,
- PostgreSQL through the database adapter,
- S3-compatible remote storage through the blob-store adapter, and
- migrations and authentication behavior that are safe under concurrent, stateless
  function execution.

Local SQLite, `/data`, and filesystem blobs are not persistent on Vercel. Database URLs,
object-store credentials, session secrets, and bootstrap tokens belong in encrypted
Vercel environment variables and must never be committed.

The Stage 1 application allows blobs up to 100 MiB by default, but Vercel request-body and
execution limits may be lower. An adapter must reject unsupported upload sizes clearly;
direct-to-object-storage uploads are a future option, not claimed by this configuration.
Until the function entrypoint and remote-state adapters are implemented and tested, use
the Docker deployment instead.
