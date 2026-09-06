# Cloudflare adapter contract (Stage 1)

The Node Docker image is **not** deployable to Cloudflare Workers. This directory records
the required adapter boundary; it intentionally contains no deployable `wrangler.toml`
until a Worker entrypoint exists.

A Cloudflare deployment must provide:

- a Worker-specific API entrypoint (separate from the Node entrypoint),
- built web assets served by Workers Static Assets or Pages,
- the explicit D1 database adapter (not a local SQLite file),
- the R2 binding-based blob-store adapter,
- Worker-compatible authentication/password hashing, migrations, and environment access,
- `GET /healthz` and `GET /readyz`, and
- the same API, authorization, hash-verification, and 100 MiB default application limit as
  the Node profile (subject to stricter Cloudflare request limits).

A future `wrangler.toml` should declare D1 and R2 bindings by name while keeping resource
IDs and secrets out of source control. Secrets such as `TEPHRA_SESSION_SECRET` and
`TEPHRA_BOOTSTRAP_TOKEN` must be supplied with Wrangler secrets or the Cloudflare
dashboard. Do not point the filesystem or SQLite adapters at ephemeral Worker storage.
