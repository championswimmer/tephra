# Cloudflare deployment (template — not yet deployable)

> Status: the Node Docker image does **not** run on Cloudflare Workers, and the
> Worker entrypoint plus D1/R2 adapters do not exist yet. `wrangler.template.jsonc`
> is a schema-correct starting point grounded in current Cloudflare docs
> (researched September 2026). Do not present it as working until the adapter
> TODOs below are done.

## Intended architecture (one Worker + Static Assets)

- One Worker serves the Hono API (`/api/*`, `/healthz`, `/readyz`).
- Workers Static Assets serves the Vite build (`apps/web/dist`) with
  `not_found_handling = "single-page-application"` for SPA fallback.
- `run_worker_first = ["/api/*"]` routes API calls to the Worker first while
  letting static assets serve directly (cheaper and faster than `true`).
- D1 binding `DB` replaces the local SQLite file; R2 binding `BLOBS` replaces
  the filesystem blob directory.

## Files

| File                      | Purpose                                             |
| ------------------------- | --------------------------------------------------- |
| `wrangler.template.jsonc` | Wrangler config skeleton with placeholder resources |
| `README.md`               | This contract and setup guide                       |

## Setup (once adapters exist)

1. Create the resources:
   `wrangler d1 create tephra` and `wrangler r2 bucket create <BUCKET_NAME>`.
2. Copy `wrangler.template.jsonc` to `wrangler.jsonc` at the Worker project
   root and fill in every `<PLACEHOLDER>` (entrypoint path, asset directory,
   database IDs, bucket names, public URL). Keep resource IDs out of git —
   prefer per-environment config or `wrangler d1 create --update-config`.
3. Set secrets (never in the config file):
   `wrangler secret put TEPHRA_SESSION_SECRET` and
   `wrangler secret put TEPHRA_BOOTSTRAP_TOKEN` (independent high-entropy
   values). Complete bootstrap once, then delete the bootstrap secret.
4. Apply D1 migrations from the configured `migrations_dir`, then
   `wrangler deploy`.

## Environment mapping

| Tephra variable           | Cloudflare home                          |
| ------------------------- | ---------------------------------------- |
| `TEPHRA_PUBLIC_URL`       | `vars` (public origin, including scheme) |
| `TEPHRA_ALLOW_SIGNUPS`    | `vars` (`"false"`)                       |
| `TEPHRA_DATABASE_DRIVER`  | `vars` (`"d1"` — needs adapter)          |
| `TEPHRA_BLOB_DRIVER`      | `vars` (`"r2"` — needs adapter)          |
| `TEPHRA_MAX_BLOB_BYTES`   | `vars` (see limits below)                |
| `TEPHRA_LOG_LEVEL`        | `vars`                                   |
| `TEPHRA_SESSION_SECRET`   | `wrangler secret` (never committed)      |
| `TEPHRA_BOOTSTRAP_TOKEN`  | `wrangler secret` (removed after setup)  |
| `TEPHRA_SQLITE_PATH` etc. | unused — no local files on Workers       |
| `TEPHRA_S3_*`             | unused — R2 is reached via binding       |

## Limits that shape the adapter

- Worker memory is 128 MB; request bodies are capped at 100 MB (Free/Pro),
  200 MB (Business), up to 5 GB (Enterprise). Tephra's default
  `TEPHRA_MAX_BLOB_BYTES=104857600` (~100 MiB) already exceeds the Free/Pro
  cap, so proxied 100 MiB uploads will fail there. The adapter must reject
  oversized uploads clearly, and large uploads should move to direct-to-R2
  (e.g. presigned URLs) rather than being buffered through the Worker.
- No filesystem or `process.env`-based config in the Worker path; bindings
  arrive on `env` (e.g. `c.env.DB`), and auth/migrations must be
  Worker-compatible.

## Adapter TODOs before this is real

- Worker entrypoint (e.g. `apps/api/src/worker.ts`) exporting
  `default { fetch }` from the shared Hono app, separate from the Node
  entrypoint.
- Explicit D1 database adapter (migrations via `migrations_dir`) and R2
  binding-based blob-store adapter.
- Worker-compatible session/password-hashing and single-flight migration story.
- Same routes (`/api/v1/*`, `/healthz`, `/readyz`) and hash-verification
  behavior as the Node profile.
