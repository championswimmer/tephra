# Tephra Disk Storage + Snapshot Backups

> Status: implementation plan
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`; tenant/volume model from `003-MULTI_TENANT_PERSISTENCE.md`
> Consumed by: `004-DEPLOYMENT_PROFILES.md` for per-platform volume configuration
> Supersedes: all S3/R2 live-engine content previously in this file (dropped 2026-09-06)
> Last updated: 2026-09-06

## Outcome

Tephra has exactly one live storage engine — **mounted disk** (SQLite file +
filesystem blob directory on one volume per tenant) — plus an **offline
snapshot pipeline** that copies periodic whole-vault tarballs to private
object storage for backup. Object storage never serves live traffic.

| Layer | Driver/value | Backing storage | Replicas |
| ----- | ------------ | --------------- | -------- |
| Live database + blobs | `filesystem` (pinned) | Local disk, Railway volume, EBS/EFS, GCP PD/Filestore, NAS bind mount | One writer per volume |
| Snapshot backup (offline) | `snapshot-uploader` (external CLI step, not a BlobStore) | S3, GCS, R2, MinIO, Railway bucket | N/A (copies, not live state) |

Canonical vault bytes, immutability, SHA-256 verification, revisioning, and
per-vault folder layout are identical on every platform. The platform choice
changes durability/operations only — never the sync protocol or reader API.

## Current state

- `@tephra/blob-store-core` defines `has`/`put`/`get`/`delete` with streaming reads/writes.
- `@tephra/blob-store-filesystem` implements the sharded layout with temp-file
  write, streaming SHA-256 + size verification, `fsync`, atomic `rename`.
- `@tephra/blob-store-s3`, `@tephra/blob-store-r2`, `@tephra/database-postgres`,
  `@tephra/database-d1` are **empty placeholder workspaces** — deleted by this plan.
- `apps/api/src/main.ts` hardcodes `sqlite`/`filesystem` and throws otherwise —
  this fail-closed pin becomes permanent doctrine, not a Stage 1 limitation.
- Blob GC (`apps/api/src/blob-gc.ts`) deletes orphan blobs locally.
- No mount sentinel, no snapshot tooling, no `deploy/gcp/`.

## Scope

- Harden the single disk engine (mount sentinel, fsync policy, free-space
  readiness, network-filesystem retry mapping, startup ownership diagnostics).
- Freeze the per-tenant volume layout (`tephra.db`, `blobs/`, `checkouts/`,
  `sync-state/`, `snapshots/`).
- Add `tephra snapshot create/verify/restore` commands producing encrypted,
  content-verified whole-volume tarballs, plus an uploader step to object storage.
- Document the platform × disk matrix (Compose, Railway, AWS, GCP).
- Delete placeholder packages and serverless deploy scaffolds.
- Document cutover/rollback between disk types (volume → volume copy).

## Non-goals

- Any live object-store adapter, presigned/direct browser or plugin uploads,
  CDN fronting, or public object URLs.
- Cross-tenant deduplication (tenants do not share disks).
- Application-layer per-tenant KMS keys for live data (snapshot envelopes may
  use a single operator-managed key; see §Snapshot format).
- Storing blobs in the database.
- FUSE object mounts (`s3fs`, `goofys`, `mountpoint-s3`) as a supported target.
- Multi-writer SQLite over NFS/EFS/Filestore.
- Replication/tiering between live and snapshot layers at runtime.
- Changing `@tephra/blob-store-core` into a Node-only package; it stays
  type-only and browser-safe.

## Live disk engine

### Configuration (pinned)

| Variable | Required | Notes |
| -------- | -------- | ----- |
| `TEPHRA_DATABASE_DRIVER` | no | must be `sqlite` (default); anything else fails startup |
| `TEPHRA_SQLITE_PATH` | yes (prod) | e.g. `/data/tephra.db` |
| `TEPHRA_BLOB_DRIVER` | no | must be `filesystem` (default); anything else fails startup |
| `TEPHRA_BLOB_PATH` | yes (prod) | e.g. `/data/blobs` |
| `TEPHRA_BLOB_REQUIRE_MOUNT` | no | default `true` in production; enforces the mount sentinel |
| `TEPHRA_BLOB_FSYNC` | no | `full` (default), `data`, or `off` for disposable disks |
| `TEPHRA_BLOB_MIN_FREE_BYTES` | no | readiness fails below this headroom |

Delete from examples/docs/code: every `TEPHRA_S3_*`, `TEPHRA_DATABASE_URL`,
`TEPHRA_S3_*` migration/driver branches. The S3/R2/Postgres/D1 workspace
deletions remove the only other consumers.

### Mount verification

Silent data loss on Railway/EFS/PD happens when the volume fails to attach
and the process writes into the container layer instead. On first start the
engine writes `<root>/.tephra-blobstore` (JSON: format version, created
timestamp, random store id). Every start:

1. creates the root if absent, then reads the marker;
2. fails startup when `TEPHRA_BLOB_REQUIRE_MOUNT` is on and the marker is
   missing but the root already contains blob shards, or the store id changed;
3. logs the store id in structured startup logs and `doctor` output.

A missing marker on a genuinely empty root is first-run init, not an error.

### Network filesystem hardening (EFS/NFS/Filestore)

- Temp files in the destination directory (same-filesystem atomic `rename`).
- `fsync` file then containing directory before publishing, gated by
  `TEPHRA_BLOB_FSYNC`.
- `EEXIST`/`EPERM` on rename = concurrent identical write; verify size, accept.
- Retry `ESTALE`/`EIO` once after re-open; persistent failure =
  `BlobUnavailableError { retryable: true }`.
- `ENOSPC`/`EDQUOT` → `BlobCapacityError`; `EACCES`/`EPERM` on open → startup
  ownership diagnostic (container UID vs volume owner).
- No `flock`/`fcntl` correctness locks; write path stays lock-free.
- Never trust `mtime`/listings; existence + size is the contract.
- `probe()` writes/reads/deletes an 8-byte object under `_probe/`; readiness
  additionally `statfs`-checks `TEPHRA_BLOB_MIN_FREE_BYTES`.

### Error taxonomy

Keep typed errors in core so callers stop matching engine strings:

```text
BlobNotFoundError        // read/stat of absent key
BlobIntegrityError       // hash/size mismatch during put or verify
BlobConflictError        // existing object contradicts declared size
BlobUnavailableError     // mount/permission/transport failure (retryable flag)
BlobCapacityError        // ENOSPC, EDQUOT, quota
```

API mapping unchanged: integrity/conflict → 409, capacity → 507,
unavailable → 503 + `Retry-After`, not-found → 404. Messages never include
credentials, tokens, or vault content (redaction regression test).

## Snapshot backups to object storage

Live data is SQLite + blobs on disk. Snapshots are **offline, whole-volume,
point-in-time tarballs** copied to a private bucket. They are the only sanctioned
use of object storage.

### Snapshot format

```text
tephra-snap-<tenant>-<utc-timestamp>.tar.zst
  manifest.json   # format v1, tenant/instance id, created_at, tephra version,
                  # sqlite user_version, file counts, per-file sha256, root hash
  tephra.db       # SQLite backup-API copy (never a live-file cp)
  blobs/…         # full blob tree copy
```

- Created with the service **stopped** (simplest supported path) or via
  SQLite online-backup + coordinated blob copy (documented online path).
- Optional envelope encryption with a single operator key
  (`TEPHRA_SNAPSHOT_KEY_FILE`, age/XChaCha20); keys live outside the repo.
- Verified on create (re-read + hash vs manifest) and on restore (same).

### Uploader

`tephra snapshot upload --file … --to s3|gcs …` is a thin external step using
provider CLIs/SDKs with workload identity preferred (GCE service account,
ECS task role) and static keys last resort. It never touches live paths and
never runs inside the API process. Retention/versioning is a bucket lifecycle
rule, documented per platform (S3 lifecycle, GCS lifecycle, R2 rules).

### CLI surface

```text
tephra snapshot create  --data-dir /data --out /data/snapshots/… [--encrypt]
tephra snapshot verify  --file …
tephra snapshot restore --file … --data-dir /data   # into a STOPPED instance
tephra snapshot upload  --file … --to <s3|gcs> --bucket … [--prefix …]
tephra snapshot prune-local --keep 3
```

Restore is always into a stopped, empty-data-dir instance, followed by
`/readyz` + authenticated browse smoke. Never restore over a running server.

## Affected areas

- `tephra-server/packages/blob-store/core/`: `stat`, `probe`, error taxonomy
  (drop the `driver: 'filesystem' | 's3'` union → `'filesystem'`).
- `tephra-server/packages/blob-store/filesystem/`: sentinel, fsync policy,
  error mapping, NFS retry, free-space checks, snapshot folder helpers.
- `tephra-server/packages/blob-store/s3/`, `r2/`: **deleted**.
- `tephra-server/packages/database/postgres/`, `d1/`: **deleted**.
- `tephra-server/packages/database/sqlite/`: quota + usage (with plan 003).
- `tephra-server/apps/api/src/main.ts`: keep fail-closed pins; update messages
  to name the disk-only doctrine.
- `tephra-server/apps/api/src/cli.ts`: `snapshot` subcommands; `doctor`
  storage section (driver, mount id, free space — never secrets).
- `tephra-server/deploy/docker/`: Compose volume (unchanged shape).
- `tephra-server/deploy/railway/`: volume (unchanged) + snapshot-upload docs.
- `tephra-server/deploy/aws/`: EFS stateful files stay; scaled-profile S3
  contract section deleted.
- `tephra-server/deploy/gcp/`: **new** (see plan 004).
- `tephra-server/deploy/vercel/`, `deploy/cloudflare/`: **deleted**.
- `.env.example`, `tephra-server/.env.example`, READMEs, `docs/*`.
- Root `package.json` workspaces: drop `database/*` + `blob-store/*` globs in
  favor of explicit existing package paths (or keep globs pointing at
  surviving dirs only — implementation chooses, must keep `npm run check` green).

## Implementation sequence

### Phase 1 — Deletions + fail-closed wording

1. Delete `packages/blob-store/{s3,r2}`, `packages/database/{postgres,d1}`,
   `deploy/{vercel,cloudflare}`; fix workspaces/lockfile (`npm install` to
   regenerate).
2. Scrub `TEPHRA_S3_*`/`TEPHRA_DATABASE_URL`/Postgres/S3/R2/D1/Vercel/Workers
   from env examples, READMEs, docs, deploy guides, and plan cross-refs.
3. Update `main.ts` errors to state disk-only doctrine.
4. Gate: `npm run check` green; no dangling references (`grep` clean).

### Phase 2 — Disk hardening

Mount sentinel, fsync policy, free-space readiness, NFS error mapping/retries,
ownership diagnostics, `probe()`, redaction tests.

Gate: unmounted/wrong-owner/full volume fails readiness, never writes into
the container layer.

### Phase 3 — Snapshots

`snapshot create/verify/restore/upload/prune-local`, manifest format,
encryption envelope, bucket lifecycle docs per platform, restore drill on a
real sample vault (stop → snapshot → upload → wipe → restore → smoke).

Gate: byte-identical vault + unchanged revisions after a full
snapshot→wipe→restore cycle, plus a verified bucket copy.

### Phase 4 — Matrix + runbooks

Platform × disk matrix, per-platform snapshot-upload guides (AWS CLI, `gcloud
storage`, Railway bucket), cutover volume→volume procedure, rollback notes.

## Deployment matrix (disk-only)

| Platform | Disk | Config | Replica limit |
| -------- | ---- | ------ | ------------- |
| Docker Compose VPS | named volume / bind mount at `/data` | `compose.yml` | 1 |
| Railway | volume `tephra-data` at `/data` | `.railway/railway.ts` | 1 |
| AWS ECS Fargate | EFS access point (UID/GID 1000), transit encryption | `deploy/aws/*.json` | 1 |
| AWS EC2 / lightsail | EBS gp3 attached + mounted at `/data` | compose on host | 1 |
| GCP Cloud Run + Filestore | Filestore NFS at `/data` (VPC connector) | `deploy/gcp/*` | 1 (min=max=1) |
| GCP Compute Engine VM | Persistent Disk (balanced/SSD) mounted at `/data` | `deploy/gcp/*` | 1 VM per tenant |
| Self-host NAS/mini-PC | bind mount at `/data` | `compose.yml` | 1 |

SQLite remains single-writer regardless of disk type; changing disk types is a
volume→volume copy, never a live migration.

## Verification

```bash
npm run check
npm test --workspace=@tephra/blob-store-filesystem
npm test --workspace=@tephra/api
tephra snapshot create --data-dir ./data --out /tmp/snap.tgz
tephra snapshot verify --file /tmp/snap.tgz
```

E2E per disk type: bootstrap → login → plan/upload/commit → recommit
idempotency → rendered/attachment byte-identical → index/links/graph →
interrupted upload leaves nothing → GC scoped → readiness fails on
unmounted/wrong-owner/full → snapshot→wipe→restore reproduces revisions.

## Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Volume fails to mount; writes hit container disk | sentinel + `TEPHRA_BLOB_REQUIRE_MOUNT` readiness failure |
| UID mismatch (Railway/EFS/PD) | startup ownership diagnostic + documented access-point/UID setup |
| Full disk mid-commit | `TEPHRA_BLOB_MIN_FREE_BYTES` readiness gate + `BlobCapacityError` → 507 |
| Live `.db` file copied directly | snapshot uses SQLite backup API; docs forbid raw cp of live DB |
| Snapshot bucket accidentally public | private-by-default docs, no public-URL code, lifecycle + checklist |
| Snapshot key loss | key-file backup drill; loss = snapshots unreadable (live disk unaffected) |
| Operator scales replicas after disk switch | replica limits stated per row, enforced by 004 validation |
| NFS latency slows commits | batched existence checks, `fsync` policy knob, throughput guidance |

## Completion checklist

- [ ] Placeholder packages + serverless scaffolds deleted; workspaces green.
- [ ] All S3/PG/R2/D1/Vercel/Cloudflare references scrubbed from code/docs/plans.
- [ ] Disk engine detects unmounted roots, ownership problems, low free space.
- [ ] `snapshot create/verify/restore/upload` exercised on a real vault.
- [ ] Snapshot→wipe→restore reproduces bytes + revisions; bucket copy verified.
- [ ] Deployment matrix + per-platform snapshot guides written.
- [ ] `npm run check` passes.

## References

- `001-TEPHRA_STAGE1_PLAN.md` for blob/sync invariants.
- `003-MULTI_TENANT_PERSISTENCE.md` for one-volume-per-tenant + quotas.
- `004-DEPLOYMENT_PROFILES.md` for platform wiring.
- [SQLite online backup](https://www.sqlite.org/backup.html)
- [Railway volumes](https://docs.railway.com/reference/volumes)
- [Amazon EFS + ECS](https://docs.aws.amazon.com/efs/latest/ug/performance.html)
- [GCP Filestore + Cloud Run (NFS)](https://cloud.google.com/filestore/docs/mounting-run)
- [GCS lifecycle management](https://cloud.google.com/storage/docs/lifecycle)
- [S3 lifecycle rules](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
