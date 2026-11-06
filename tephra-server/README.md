# Tephra Server

Tephra Stage 1 is a private web mirror for vaults synced from the Tephra Obsidian
plugin or the official Obsidian Sync headless client, with in-browser note editing. The primary self-hosted profile is one Node.js
container serving both the API and built web application, with SQLite and
content-addressed blobs persisted under `/data`.

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

| Variable                 | Purpose                                                                                       | Default                                         |
| ------------------------ | --------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `HOST`                   | HTTP bind address                                                                             | `0.0.0.0` in the image                          |
| `PORT`                   | Single API/web HTTP port                                                                      | `8080`                                          |
| `NODE_ENV`               | Set to `production` to mark session cookies `Secure`                                          | `production` in the image                       |
| `TEPHRA_PUBLIC_URL`      | Browser-visible origin, including scheme; used for redirects, cookies and MCP OAuth discovery | required in production                          |
| `TEPHRA_SESSION_SECRET`  | Signs/protects browser sessions                                                               | required; no safe default                       |
| `TEPHRA_BOOTSTRAP_TOKEN` | One-time proof used to create the first admin                                                 | required for first setup                        |
| `TEPHRA_DATABASE_DRIVER` | Must be `sqlite` (only live database)                                                         | `sqlite`                                        |
| `TEPHRA_SQLITE_PATH`     | SQLite database file                                                                          | `/data/tephra.db` in the image                  |
| `TEPHRA_BLOB_DRIVER`     | Must be `filesystem` (only live blob store)                                                   | `filesystem`                                    |
| `TEPHRA_BLOB_PATH`       | Filesystem blob root                                                                          | `/data/blobs` in the image                      |
| `TEPHRA_MAX_BLOB_BYTES`  | Maximum accepted blob size                                                                    | `104857600` (100 MiB)                           |
| `TEPHRA_WEB_ROOT`        | Directory of the built web app served by the API process                                      | `/app/tephra-server/apps/web/dist` in the image |
| `TEPHRA_OBSIDIAN_SYNC_ENABLED` | Set to `false` to disable native Sync setup and startup | `true` |
| `TEPHRA_OBSIDIAN_SYNC_PATH` | Private CLI credentials, Sync state and vault checkouts (persistent) | `obsidian-sync` beside the SQLite file; `/data/obsidian-sync` in Docker |
| `TEPHRA_OBSIDIAN_CACHE_PATH` | Disposable installation prefix for the pinned official CLI | OS temp directory + `/tephra-obsidian-client` |
| `TEPHRA_OBSIDIAN_MAX_VAULTS` | Maximum enabled native Sync vaults | `5` |
| `TEPHRA_OBSIDIAN_SCAN_INTERVAL_SECS` | Debounce interval for checkout changes; full scan every 60 seconds | `2` |


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

## Official Obsidian Sync

Obsidian's [standalone headless client](https://obsidian.md/help/headless) runs
without the desktop app and requires Node.js 22+ and an active Obsidian Sync
subscription. This is separate from the desktop Obsidian CLI. Tephra invokes the
official `ob` client as a separate process; it does not implement the Sync
protocol or execute Obsidian plugins.

1. Open **Settings → Obsidian Sync account** and sign in with your Obsidian email/password and a current two-factor code if
   enabled. Account passwords and codes are cleared after submission and are
   never stored in Tephra's database, logs, command line or environment.
2. Create a vault on the vaults page, choosing official Obsidian Sync as its sync
   method. This choice is permanent; create another vault to use Tephra plugin sync.
3. Open the vault's settings and select an existing remote vault (owned or shared). Enter its vault encryption
   password if it uses end-to-end encryption. Remote vault creation stays in
   Obsidian. The account password and vault encryption password may differ.
4. Choose **Two-way** to send browser/agent edits back through Obsidian Sync, or
   **Download only** to browse/search while editing in Obsidian. Connect the vault
   to enable automatic sync and start the initial download.
5. Use **Pause sync**, **Enable automatic sync**, or **Retry sync** in the vault's settings.
   Re-authenticate in global Settings if the account session expires.

### Runtime installation and restart recovery

Neither the repository dependencies nor the Docker image include
`obsidian-headless`. On first sign-in/use, Tephra installs the pinned official
`obsidian-headless@0.0.14` npm package into `TEPHRA_OBSIDIAN_CACHE_PATH` using the
public npm registry. The runtime needs npm and outbound access to npmjs.org and
GitHub's native-addon downloads. Linux deployments normally use the package's
prebuilt `better-sqlite3` addon; platforms without an available prebuild need
native compilation tools. Installation failures are shown in Settings and can
be retried without affecting Tephra plugin vaults.

The login subprocess supplies an explicit `Accept-Language` header to avoid
the [upstream 0.0.14 sign-in timeout](https://github.com/obsidianmd/obsidian-headless/issues/58).
The installed official CLI package remains unmodified.

The installation cache is disposable. On boot, enabled vaults are resumed and
the client is installed again if its cached executable has disappeared. No
installation occurs on boot when there are no enabled native vaults. If the
administrator lowers the enabled vault limit, excess vaults are paused during
startup and show the limit error in Settings.

Keep **SQLite, blobs and `TEPHRA_OBSIDIAN_SYNC_PATH` on a persistent local disk**
(the Docker defaults put all of them under `/data`). The native state contains a
per-vault Obsidian session token, derived encryption key, sync database and
checkout. These are private files/directories restricted to the service user;
protect this volume and its backups. Account passwords, MFA codes and encryption
passwords are not retained. Synced notes are decrypted on your trusted server
for rendering, search and editing, just as other Tephra notes are stored there.

An object-store bucket backup does not replace the writable persistent disk. If
the entire data volume disappears, Tephra's database and saved credentials also
disappear; reinstallation alone cannot restore those. If only native state or a
previously populated checkout is missing, Tephra refuses to start syncing that
checkout so local data loss cannot propagate as remote deletions. Sign in if
needed, load the remote vaults, and use **Download fresh copy and enable sync**
to rebuild from Obsidian. This explicitly replaces the local checkout while
retaining imported Tephra content until the download completes.

Deleting a native vault stops the process before unlink/logout and local
removal; it does not delete the remote Obsidian vault. Pausing preserves the
credentials, files and state for later recovery. Back up/restore the native
checkout and CLI state together with the database and blobs while the service
is stopped; do not restore its sync state independently of its files.

### Content and deployment behavior

The official client runs continuously and Tephra watches for changed files,
reconciling them after a short debounce plus a periodic full scan. Every import
preserves the original bytes, stores SHA-256 verified immutable blobs, and
commits file changes/deletions as a revision. Browser and agent Markdown writes
pause the client, check the base hash, atomically replace the local file, import
the change, and restart Sync. Stale edits return a conflict. Editing is disabled
for paused, unhealthy, initial-sync or download-only native vaults.

Direct device sync requests (`POST .../sync/plan`, `PUT .../blobs/:hash`, and
`POST .../sync/commit`) return HTTP 409 with code `VAULT_SYNC_MODE_MISMATCH`
and a message explaining that official Obsidian Sync is enabled for the vault.
This also applies before setup, while paused, or after a Sync error, including
requests using previously issued upload tokens. Upload token creation is
rejected with the same reason; read and agent tokens remain available.
Plugin read APIs and MCP tools remain available under their usual scopes;
browser and agent edits still require an active, healthy two-way connection.
Use official Obsidian Sync for those vaults on your devices. Obsidian
configuration/plugin sync is disabled, and hidden/configuration files are excluded from Tephra's
content import. Run one service process per local data volume; shared network
filesystems and multiple replicas are unsupported.

The automated tests use a fake official-client adapter for account and remote
operations. Installation, CLI version/local JSON commands, and secret stdin
launching are verified separately. Live paid-account sync (including E2E and
MFA) requires manual acceptance with an Obsidian account.

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
| Desktop Obsidian plugin        | Tested (Stage 1 sync and in-browser editing)       |
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
  `npm run deploy:railway` (or `railway config apply`) or a published template.
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
