# Tephra Deployment Profiles (disk-only)

> Status: implementation plan
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`, `002-AUTHENTICATION_MODES.md`, and
> `003-MULTI_TENANT_PERSISTENCE.md`
> Profiles: single-user self-hosted and one-VM-per-tenant hosted
> Supersedes: all PostgreSQL/S3 hosted-service content previously in this file (dropped 2026-09-06)
> Last updated: 2026-09-06

## Outcome

Tephra publishes and tests disk-only deployment profiles built from the same
source and production image. Every profile is **one container + one volume +
one port**; tenants scale by adding VMs/disks, never by sharing a database.

| Profile | Runtime | Persistence | Scale |
| ------- | ------- | ----------- | ----- |
| Single-user self-hosted | One Node container: API + web | One disk: SQLite + filesystem at `/data` | Exactly one replica |
| Hosted per-tenant | Same image, one instance per tenant | One disk per tenant (same layout) | One VM/disk per tenant; N tenants = N instances |

The single-user profile remains the default and keeps the “one container, one
volume, one port” promise. The hosted profile is N copies of the same shape
with per-tenant volumes, secrets, and backups — not a shared stateless service.

Targets: Docker Compose (reference), Railway (volume), AWS (EFS/EBS), **GCP
(Compute Engine PD or Cloud Run + Filestore)**. No Vercel/Cloudflare (deleted:
no persistent disk).

## Scope

- Produce one immutable Node image with `serve`, `worker`, `migrate` commands
  (worker/migrate operate on the local disk; no shared queue).
- Preserve and test Compose + Railway single-user deployments.
- Add/refresh AWS disk guidance (EFS + EBS) and add GCP disk guidance
  (GCE PD + Cloud Run/Filestore) with skeletons + READMEs.
- Per-vault folder layout (`checkouts/`, `sync-state/`, `snapshots/`) mounted
  for the headless Sync sidecar (plan 006).
- Snapshot-to-object-storage backup guides per platform (S3, GCS, Railway bucket).
- Strict configuration validation, health/readiness, backup/restore, secret
  rotation, signup kill-switch, deploy, and rollback runbooks.
- Deployment smoke scripts exercising real auth, sync, and browser reads.

## Non-goals

- Provisioning or changing a live Railway/AWS/GCP account as part of plan authoring.
- Kubernetes, Redis, Kafka, or a microservice split.
- Cloudflare Workers/D1/R2 or Vercel Functions (deleted targets).
- Multi-region active/active operation for one tenant.
- Zero-downtime deploys for the disk profile.
- Direct browser-to-object-storage upload tickets.
- Shared PostgreSQL/S3 hosted service (dropped; see doctrine in plan 003).
- Billing, metering, subscriptions, or customer support tooling.
- Claiming a provider configuration works before it passes a clean-environment smoke test.

## Shared release artifact

Build one multi-stage Docker image from the npm workspace root. It contains:

- compiled API entrypoint and worker;
- built Vite assets served same-origin by the API;
- database migrations;
- only production dependencies;
- no source `.env`, credentials, vault data, or generated secrets;
- an unprivileged runtime user and read-only application filesystem where supported.

Expose commands:

```text
tephra serve
tephra worker
tephra migrate
tephra doctor
tephra snapshot create|verify|restore|upload|prune-local
tephra auth reset-single-user-password
```

`doctor` is read-only: validates configuration, public URL, SQLite
connectivity/schema, blob-store mount sentinel + free space, snapshot
configuration (without secrets), and mode/storage compatibility. Never prints
secrets or vault contents.

Use an immutable version/commit image tag. Do not deploy production on `latest` alone.

## Configuration matrix (all profiles)

| Variable | Value (all profiles) |
| -------- | -------------------- |
| `TEPHRA_INSTANCE_MODE` | `single_user` (default) / `multi_user` only with per-tenant instances + closed signup until acceptance |
| `TEPHRA_SIGNUP_MODE` | `closed` (only value until 002+003+004 acceptance) |
| `TEPHRA_PUBLIC_URL` | required HTTPS origin in production |
| `TEPHRA_SESSION_SECRET` | required, per-instance secret |
| `TEPHRA_TRUSTED_PROXY_COUNT` | explicit for chosen ingress |
| `TEPHRA_BOOTSTRAP_TOKEN` | required only before first setup, then removed |
| `TEPHRA_DATABASE_DRIVER` | `sqlite` (pinned; anything else fails startup) |
| `TEPHRA_SQLITE_PATH` | `/data/tephra.db` |
| `TEPHRA_BLOB_DRIVER` | `filesystem` (pinned; anything else fails startup) |
| `TEPHRA_BLOB_PATH` | `/data/blobs` |
| `TEPHRA_BLOB_REQUIRE_MOUNT` | `true` in production |
| `TEPHRA_BLOB_MIN_FREE_BYTES` | per-platform headroom |
| `TEPHRA_SNAPSHOT_*` | backup-only uploader config (bucket, prefix, key file); never live paths |

Startup fails before listening when storage/mount configuration disagrees.

## Profile A — single-user self-hosted

### Topology

```text
Internet or private network
        |
HTTPS reverse proxy / platform ingress
        |
one Tephra container :8080 (+ optional obsidian-sync + bridge sidecars, plan 006)
        |
/data: tephra.db + blobs/ + checkouts/ + sync-state/ + snapshots/
```

Supported initial paths:

- Docker Compose on a VPS/home server/NAS with a named or bind-mounted `/data`;
- one Railway service with one persistent volume at `/data`;
- AWS: single-task ECS/EFS or single EC2 with EBS at `/data`;
- GCP: single GCE VM with Persistent Disk, or one Cloud Run service + Filestore.

### First deployment

1. Generate independent high-entropy session and bootstrap secrets.
2. Configure the public URL and TLS proxy/platform domain.
3. Provision the disk (volume/PD/EFS/Filestore) and attach at `/data`.
4. Start exactly one container; wait for `/readyz`.
5. Open `/setup`, enter the bootstrap token, create the only account.
6. Remove `TEPHRA_BOOTSTRAP_TOKEN`; restart.
7. Create a vault + vault-scoped plugin token; sync a small real vault;
   verify file, rendered note, attachment, link, graph reads.
8. Run an initial snapshot (`tephra snapshot create` + `upload`) and prove
   restore into a disposable instance.

### Operations

- `/healthz` = process liveness; `/readyz` = SQLite schema + blob mount
  sentinel + free-space + non-user probe (cleaned immediately).
- Never scale above one replica per volume.
- Back up `/data` as one logical dataset (stopped-archive or SQLite
  backup-API + coordinated blob copy), plus periodic off-host snapshots.
- Expired-session cleanup + blob GC on a documented schedule.
- Password recovery via local operator command (plan 002), never reopened bootstrap.

### Upgrade and rollback

1. Record image digest; run authenticated pre-upgrade smoke.
2. Stop container; snapshot `/data` (local + upload).
3. `tephra doctor`, then `tephra migrate` once.
4. Start new image; run authenticated sync/browse smoke.
5. Retain snapshot + prior image through the rollback window; rollback is
   stop + restore snapshot, never old code on new schema.

## Profile B — hosted per-tenant (one VM + one disk per tenant)

### Topology (per tenant)

```text
HTTPS ingress (per tenant domain or path-routed)
        |
one Tephra instance (same image, tenant's secrets)
        |
tenant's disk: tephra.db + blobs/ + checkouts/ + sync-state/ + snapshots/
        |
snapshot copies → private bucket (S3/GCS/Railway, backup only)
```

The operator provisions N independent copies of Profile A. Tenants share
nothing: no shared database, bucket, volume, or secret. Tenant onboarding =
provision disk + instance + secrets + domain; offboarding = final snapshot,
then delete instance + disk.

### Railway pilot layout

One Railway project, per-tenant services (or per-tenant projects for strong
billing separation):

- `tephra-<tenant>`: repo Dockerfile, `tephra serve`, `/readyz` health path,
  own `tephra-data-<tenant>` volume at `/data`, own secrets.
- Snapshot upload to a private Railway bucket via scheduled job/command
  (bucket holds snapshots only, never live blobs).
- Migration = one-shot `tephra migrate` with the instance stopped.

### AWS layout

- Per tenant: one ECS service (`desiredCount: 1`) + EFS access point, or one
  EC2/Lightsail instance + EBS volume; ALB path/host routing; secrets in
  Secrets Manager/SSM; snapshots to private S3 via lifecycle rules.
- Keep the existing `deploy/aws/*.json` EFS skeletons; add an EC2+EBS Compose
  variant in `deploy/aws/README.md`.

### GCP layout (new)

- **Option 1 — GCE VM (recommended first):** one `e2-micro`/equivalent VM per
  tenant + one balanced Persistent Disk mounted at `/data`; Compose runs the
  Tephra + optional sidecar stack; static IP + Cloud DNS + managed TLS via a
  small HTTPS LB or Caddy/Traefik on the VM; snapshots via `gcloud compute
  disks snapshot` + `tephra snapshot upload` to private GCS.
- **Option 2 — Cloud Run + Filestore:** one service per tenant
  (`--min-instances 1 --max-instances 1`, VPC connector, Filestore NFS at
  `/data`); HTTPS built in; snapshots to GCS via scheduled Cloud Scheduler +
  `snapshot upload`.
- Skeletons: `tephra-server/deploy/gcp/` with a startup-script/compose
  bundle for GCE and a `service.yaml` + Filestore guide for Cloud Run
  (reference-only until smoke-tested, same honesty rule as AWS).

### Hosted acceptance (per tenant instance)

Same gates as Profile A first deployment, plus: two tenant instances hold
identical-hash content with zero cross-access; deleting tenant B's disk
provably affects tenant A not at all; each tenant restores independently
from its own snapshot.

## Deployment files

- `tephra-server/deploy/docker/Dockerfile`: `serve`/`worker`/`migrate`/`snapshot` image.
- `tephra-server/deploy/docker/compose.yml`: retained single-user profile
  (+ optional sidecar overlay from plan 006).
- `tephra-server/deploy/railway/railway.single-user.json` → IaC: one replica/volume docs.
- `tephra-server/deploy/aws/`: stateful ECS/EFS + EC2/EBS files (S3 sections
  rewritten as snapshot-backup only).
- `tephra-server/deploy/gcp/` (new): GCE startup + Cloud Run skeletons + README.
- `tephra-server/deploy/vercel/`, `deploy/cloudflare/`: **deleted**.
- `tephra-server/apps/api/src/main.ts`: `serve` composition w/ fail-closed pins.
- `tephra-server/apps/api/src/cli.ts`: migrate/doctor/snapshot/operator commands.
- `.env.example`, READMEs, threat/privacy docs.
- `e2e/deploy-single-user.mjs`, `e2e/deploy-tenant-pair.mjs` (new smoke scripts).

Do not update `PROGRESS.md` until the profile is deployed from a clean
environment and verified.

## Implementation sequence

### Phase 1 — Image and command contract

1. `serve`/`worker`/`migrate`/`doctor`/`snapshot` entrypoints + strict validation.
2. Dockerfile ships all entrypoints + migrations as unprivileged image.
3. Graceful shutdown; migration locking (single-writer; lock file on disk).

Gate: image runs every command locally; unsafe config fails before traffic.

### Phase 2 — Single-user profile (+ GCP)

1. Compose + Railway + AWS refresh (disk-only wording, snapshot guides).
2. New GCP GCE + Cloud Run skeletons + README.
3. Setup/backup/restore/upgrade/rollback/recovery docs per platform.
4. Deploy smoke per platform from a clean disk; restore into another clean disk.

Gate: one documented path per platform yields a working install; restore
preserves account, tokens, bytes, revisions.

### Phase 3 — Per-tenant hosting acceptance

1. Two independent instances, identical-hash content, cross-access attempts.
2. Independent snapshot/restore per tenant.
3. Tenant onboard/offboard runbook (provision → smoke → snapshot → delete).

Gate: tenants share nothing; deletion is provably isolated.

## Verification

```bash
npm run check
docker build -f tephra-server/deploy/docker/Dockerfile -t tephra:test .
docker compose -f tephra-server/deploy/docker/compose.yml config
```

Smoke assertions: health vs readiness split; config errors block listen;
migrations run once; restart/restore preserve data; registration closed and
mode-disabled routes unreachable; two tenants share nothing; real plugin
upload → verified revision → browser read; snapshot→wipe→restore identical;
rollback follows the non-destructive path.

Validate provider configs with current CLI schemas before claiming support.
Bounded logs/metrics checks after any real deploy.

## Risks and mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Self-host accidentally enables signup | invalid mode combo; signup defaults closed |
| Operator points two instances at one disk | per-tenant volume/provision checklist; mount sentinel store-id check |
| Multiple SQLite writers corrupt state | one replica/VM per disk; docs forbid sharing; sentinel fails fast |
| New image cannot read migrated data | backward-compatible expand/contract; staging rollback drill |
| Blob/snapshot rollback loses data | delayed destructive cleanup; verified snapshots before upgrade |
| Secrets leak into files/logs | platform secret injection, redaction tests, placeholder-only examples |
| Snapshot bucket public | private-by-default docs, no public-URL code, checklist item |
| Provider docs/config drift | validate against current official schema/CLI during implementation |
| GCP guidance untested | label reference-only until the same smoke passes on GCP |

## Completion checklist

- [ ] One image provides serve/worker/migrate/doctor/snapshot/auth commands.
- [ ] Unsafe configuration fails before serving.
- [ ] Compose/Railway/AWS/GCP each have a one-disk working path.
- [ ] Setup/backup/restore/upgrade/rollback/recovery exercised per platform.
- [ ] Two-tenant isolation + independent restore proven.
- [ ] Snapshot guides (S3/GCS/Railway bucket) written; buckets hold backups only.
- [ ] Serverless scaffolds deleted; no live object-store references remain.
- [ ] Signup opens only after plans 002, 003, 004 acceptance.
- [ ] Docs + `PROGRESS.md` describe only verified behavior.
- [ ] `npm run check` passes.

## References

- `001-TEPHRA_STAGE1_PLAN.md` for read-only invariants.
- `002-AUTHENTICATION_MODES.md` for auth lifecycle.
- `003-MULTI_TENANT_PERSISTENCE.md` for one-volume-per-tenant + quotas.
- `005-STORAGE_ENGINES.md` for disk engine + snapshot design.
- `006-HEADLESS_OBSIDIAN_SYNC.md` for sidecar consumers of `/data`.
- [Railway volumes](https://docs.railway.com/reference/volumes)
- [Railway CLI](https://docs.railway.com/cli)
- [EFS + ECS](https://docs.aws.amazon.com/efs/latest/ug/performance.html)
- [GCE persistent disks](https://cloud.google.com/compute/docs/disks)
- [Filestore + Cloud Run](https://cloud.google.com/filestore/docs/mounting-run)
