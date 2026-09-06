# Vercel deployment (example — not yet deployable)

> Status: the single-process Node Docker image does **not** run on Vercel
> Functions, and the function entrypoint plus remote-state adapters do not
> exist yet. `vercel.example.json` is a schema-correct reference scaffold
> grounded in current Vercel docs (researched September 2026). Do not copy it
> into a live project root until the adapter TODOs below are done.

## Intended architecture

- The Vite build (`apps/web`) ships as static output with an SPA fallback
  rewrite (`/((?!api/|healthz$|readyz$).*)` → `/index.html`; filesystem routes
  and `/api` functions take precedence anyway).
- One function entrypoint (e.g. `api/index.ts`, `export default handle(app)`
  from `hono/vercel`) serves `/api/:path*` plus `/healthz` and `/readyz`.
- PostgreSQL via the database adapter (Vercel Marketplace Postgres — Neon,
  Supabase, Aurora — wired as env vars) and S3-compatible remote storage via
  the blob-store adapter. No local disk: only `/tmp` scratch (up to 500 MB)
  exists, and SQLite/`/data`/filesystem blobs are unusable.

## Files

| File                  | Purpose                                                       |
| --------------------- | ------------------------------------------------------------- |
| `vercel.example.json` | Reference `vercel.json` scaffold (build, functions, rewrites) |
| `README.md`           | This contract and setup guide                                 |

Because Vercel's **Root Directory** setting scopes the build to one directory
(which then cannot see files outside it), the effective `vercel.json` must
live at the real project root when activated — `deploy/vercel/` is
reference-only by design.

## `vercel.example.json` map

- `$schema` — `https://openapi.vercel.sh/vercel.json` for editor validation.
- `framework: "vite"`, `buildCommand` (web workspace build),
  `installCommand: "npm ci"`, `outputDirectory: "apps/web/dist"`.
- `functions["api/index.ts"]` — `maxDuration: 30`, pinned region. Memory is
  **not** set in the file (dashboard-only; Hobby fixed at 2 GB).
- `rewrites` — `/healthz` and `/readyz` to the function, `/api/:path*` to the
  function, everything else to `/index.html`.
- `headers` — long-lived immutable caching for `/assets/*`.

## Environment mapping (dashboard/CLI only, never committed)

| Variable                 | Notes                                              |
| ------------------------ | -------------------------------------------------- |
| `TEPHRA_PUBLIC_URL`      | Production URL of the Vercel deployment            |
| `TEPHRA_SESSION_SECRET`  | Encrypted env var, high-entropy, independent value |
| `TEPHRA_BOOTSTRAP_TOKEN` | Encrypted env var, one-time; remove after setup    |
| `TEPHRA_DATABASE_DRIVER` | `postgres` (needs adapter)                         |
| `TEPHRA_DATABASE_URL`    | Marketplace Postgres connection string             |
| `TEPHRA_BLOB_DRIVER`     | `s3` (needs adapter; external S3/R2-compatible)    |
| `TEPHRA_S3_*`            | Bucket/region/endpoint/credentials                 |
| `TEPHRA_MAX_BLOB_BYTES`  | Capped by platform limits (see below)              |
| `TEPHRA_ALLOW_SIGNUPS`   | `false`                                            |
| `TEPHRA_LOG_LEVEL`       | `info`                                             |

Vercel env vars are capped at 64 KB total per deployment.

## Limits that shape the adapter

- **Request/response body limit is 4.5 MB** (`FUNCTION_PAYLOAD_TOO_LARGE`
  beyond it). Tephra's default `TEPHRA_MAX_BLOB_BYTES=104857600` (100 MiB) is
  fundamentally incompatible with proxying uploads through a function — large
  uploads need direct-to-storage (presigned URLs) or different hosting. The
  adapter must reject oversized uploads clearly.
- Functions are stateless and autoscale (Fluid compute default): no local
  session store, no on-disk auth state, and migrations must run as a separate
  deploy step — never from request startup under concurrency.
- Duration default 300 s (Hobby max 300 s; Pro/Enterprise up to 800 s).

## Adapter TODOs before this is real

- Vercel Function entrypoint with routes equivalent to `/api/v1/*`,
  `/healthz`, `/readyz` (Hono `hono/vercel` handler).
- PostgreSQL database adapter + S3-compatible blob-store adapter, tested under
  concurrent stateless execution.
- Migration story safe for serverless deploys.
- Same API, authorization, and hash-verification behavior as the Node profile.
