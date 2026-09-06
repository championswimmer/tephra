# Tephra Server

Tephra Stage 1 is a private, read-only web mirror for vaults uploaded by the Tephra
Obsidian plugin. The primary self-hosted profile is one Node.js container serving both the
API and built web application, with SQLite and content-addressed blobs persisted under
`/data`.

## Local development

Requirements: Node.js 22 or newer and npm 10 (the version is pinned in the root
`package.json`). From the repository root:

```bash
npm ci
cp tephra-server/.env.example .env
# Replace both secret placeholders in .env.
npm run dev
```

Use `npm run lint`, `npm run typecheck`, `npm run test`, and `npm run build` before
submitting changes. `npm run check` runs all four in that order.

The default local storage paths in `.env.example` are under `./data`. They are relative to
the server process's working directory. The Docker profile instead uses absolute paths
under `/data`.

## Configuration

| Variable                      | Purpose                                              | Default                        |
| ----------------------------- | ---------------------------------------------------- | ------------------------------ |
| `HOST`                        | HTTP bind address                                    | `0.0.0.0` in the image         |
| `PORT`                        | Single API/web HTTP port                             | `8080`                         |
| `TEPHRA_PUBLIC_URL`           | Browser-visible origin, including scheme             | required in production         |
| `TEPHRA_SESSION_SECRET`       | Signs/protects browser sessions                      | required; no safe default      |
| `TEPHRA_BOOTSTRAP_TOKEN`      | One-time proof used to create the first admin        | required for first setup       |
| `TEPHRA_DATABASE_DRIVER`      | Must be `sqlite` (only live database)                | `sqlite`                       |
| `TEPHRA_SQLITE_PATH`          | SQLite database file                                 | `/data/tephra.db` in the image |
| `TEPHRA_BLOB_DRIVER`          | Must be `filesystem` (only live blob store)          | `filesystem`                   |
| `TEPHRA_BLOB_PATH`            | Filesystem blob root                                 | `/data/blobs` in the image     |
| `TEPHRA_MAX_BLOB_BYTES`       | Maximum accepted blob size                           | `104857600` (100 MiB)          |

Never commit a real `.env`. Generate independent high-entropy session and bootstrap
secrets, for example with `openssl rand -hex 32`. Platform request limits can be lower
than `TEPHRA_MAX_BLOB_BYTES`.

## First-user bootstrap

1. Start Tephra with a fresh data directory and `TEPHRA_BOOTSTRAP_TOKEN` set.
2. Open `TEPHRA_PUBLIC_URL`. When no users exist, Tephra shows the bootstrap page.
3. Enter the bootstrap token and create the first administrator account.
4. Confirm login, then remove `TEPHRA_BOOTSTRAP_TOKEN` from the runtime environment and
   restart.

The bootstrap endpoint is permanently unavailable after a user exists. The token is not
a login credential and must not be reused as the session secret.

## Obsidian plugin token flow

After signing in through the browser, create or select a vault and create a device token
for it. The raw token is displayed only once. Put the server URL, vault selection, and raw
token into the Tephra plugin settings; do not paste the bootstrap token there.

Plugin requests authenticate with `Authorization: Bearer <device-token>`. A device token
is scoped to one vault and grants only the sync operations needed by the plugin. Revoke a
lost or retired token from the vault token settings. Tephra stores only a token hash and
must never log the raw token.

## Docker

Build the production image from the repository root:

```bash
docker build -f tephra-server/deploy/docker/Dockerfile -t tephra:local .
```

Run it with a named persistent volume. Generate the bootstrap value separately so it is
available for the first browser visit:

```bash
export TEPHRA_SESSION_SECRET="$(openssl rand -hex 32)"
export TEPHRA_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
printf 'Bootstrap token: %s\n' "$TEPHRA_BOOTSTRAP_TOKEN"
docker run --name tephra --restart unless-stopped \
  -p 8080:8080 \
  -v tephra-data:/data \
  -e TEPHRA_PUBLIC_URL=http://localhost:8080 \
  -e TEPHRA_SESSION_SECRET="$TEPHRA_SESSION_SECRET" \
  -e TEPHRA_BOOTSTRAP_TOKEN="$TEPHRA_BOOTSTRAP_TOKEN" \
  tephra:local
```

The image runs as the unprivileged `node` user, serves `/api/*` and the static web app on
one port, and defaults to SQLite plus filesystem blobs in `/data`. If using a bind mount,
make it writable by UID/GID 1000 before starting the container.

For Compose, export the two secrets (or place them in an uncommitted `.env`) and run from
the repository root:

```bash
export TEPHRA_SESSION_SECRET="$(openssl rand -hex 32)"
export TEPHRA_BOOTSTRAP_TOKEN="$(openssl rand -hex 32)"
docker compose -f tephra-server/deploy/docker/compose.yml up --build -d
```

The Compose service uses the named `tephra-data` volume. Do not scale it beyond one
replica while using SQLite or filesystem blobs.

## Health checks

- `GET /healthz` reports process health and is used by Docker and Railway.
- `GET /readyz` reports readiness, including storage connectivity where supported.

Examples:

```bash
curl --fail http://localhost:8080/healthz
curl --fail http://localhost:8080/readyz
```

A healthy response does not replace an authenticated browse-and-sync smoke test after an
upgrade.

## Persistence and backup

The SQLite database and blob directory form one logical dataset. Keep the entire Docker
`/data` volume persistent; deleting or replacing the container must not delete it.

The simplest consistent backup is taken while Tephra is stopped:

```bash
docker stop tephra
docker run --rm -v tephra-data:/data:ro -v "$PWD/backups:/backup" \
  alpine:3.21 tar -C /data -czf /backup/tephra-data.tgz .
docker start tephra
```

Protect backups as private data, encrypt them off-host, and test restoration into a new
volume. For online backups, use SQLite's online backup mechanism first and coordinate its
snapshot with a copy of the blob directory; copying a live `.db` file directly is not a
consistent procedure. Back up before upgrades and retain the previous image until the
post-upgrade smoke test succeeds.

## Blob garbage collection

Failed or superseded uploads can leave blobs in the blob directory that no current
vault file and no retained file version references. Tephra's `collectUnreferencedBlobs`
routine (in `@tephra/api`) deletes such orphan blobs from both the blob store and the
`blobs` table. A blob only becomes eligible 7 days after its `created_at` timestamp, so
blobs belonging to in-flight uploads — always much newer than the cutoff — are never
collected, and blobs referenced by current files or retained history are never
candidates. Run collection as a periodic maintenance job, not on the sync hot path.

## Migration policy

SQLite migrations live in `tephra-server/migrations/sqlite/` (for example
`001_initial.sql`). They auto-run on Node.js server startup: a fresh database
executes the migration transactionally and records the schema version with
`PRAGMA user_version`; an
up-to-date database is left untouched and a newer-than-supported database fails fast
instead of starting. Never edit a released migration. Schema changes ship as a new
numbered migration file plus code that understands the previous version.

## Compatibility matrix

| Client / platform              | Status                                             |
| ------------------------------ | -------------------------------------------------- |
| Desktop Obsidian plugin        | Tested (Stage 1 sync and read-only web mirror)     |
| Evergreen desktop browsers     | Tested (current Chrome, Firefox, Safari, Edge)     |
| Mobile browsers (Web Crypto)   | Supported via the mobile-path Web Crypto code path |
| Physical mobile device testing | Pending — manual test on a real phone not yet done |

Only evergreen browsers are supported. If the mobile-path Web Crypto flow fails on a
device, report the device, OS, and browser version.

## Deployment targets

Live storage is disk-only on every target: one container/VM + one disk per
tenant (SQLite + filesystem at `/data`). Object storage holds periodic
snapshot tarballs only — never live blobs.

- [Railway](deploy/railway/README.md): same Docker image, declared via
  `.railway/railway.ts` (service + `/data` volume, one replica) — deploy with
  `railway config apply` or a published template.
- [AWS](deploy/aws/README.md): ECS/EFS single-task guidance plus EC2/EBS;
  snapshots to private S3.
- [GCP](deploy/gcp/README.md): Compute Engine VM + Persistent Disk, or
  Cloud Run + Filestore; snapshots to private GCS.

Only use targets whose skeletons have passed a clean-environment smoke test
for the release being deployed. Multi-tenant hosting means more independent
single-disk instances (see `.agents/plans/004-DEPLOYMENT_PROFILES.md`), never
a shared database.

## Security notes

Terminate TLS in production and set `TEPHRA_PUBLIC_URL` to the HTTPS origin. Do not expose
port 8080 directly to the public internet without a hardened reverse proxy or load
balancer. Keep registrations disabled unless deliberately operating a multi-user service.

All vaults are private in Stage 1. Treat Markdown, HTML, attachments, filenames, and MIME
types as untrusted input; rendered Markdown must be sanitized. The server must verify blob
sizes and SHA-256 hashes and enforce authorization on every vault resource. Device tokens,
session cookies, passwords, note contents, database URLs, and object-store credentials
must not appear in logs. Apply security updates, restrict access to `/data` and backups,
and rotate/revoke credentials after suspected exposure.
