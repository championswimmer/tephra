# Tephra Deployment Profiles

> Status: implementation plan
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`, `002-AUTHENTICATION_MODES.md`, and
> `003-MULTI_TENANT_PERSISTENCE.md`
> Profiles: single-user self-hosted and multi-user hosted service
> Last updated: 2026-09-06

## Outcome

Tephra will publish and test two honest deployment profiles built from the same source and
production image:

| Profile                 | Runtime                              | Persistence                               | Scale                                                          |
| ----------------------- | ------------------------------------ | ----------------------------------------- | -------------------------------------------------------------- |
| Single-user self-hosted | One Node container serving API + web | SQLite + filesystem under `/data`         | Exactly one replica                                            |
| Multi-user hosted       | Stateless Node API/web plus worker   | PostgreSQL + private S3-compatible bucket | Start with one API; scale horizontally after concurrency tests |

The single-user profile remains the default and keeps the existing “one container, one volume,
one port” promise. The hosted profile is not documented as available until auth, tenant
isolation, PostgreSQL, S3, email, and deployment smoke tests all pass.

Railway is the first concrete hosted-service reference because the repository already contains a
Railway deployment and Railway can provide PostgreSQL and S3-compatible buckets. The topology is
vendor-neutral; AWS documentation remains as a production alternative after the same adapters
are verified.

## Scope

- Produce one immutable Node image with explicit `serve`, `worker`, and `migrate` commands.
- Preserve and test Docker Compose and Railway single-user deployments.
- Add a non-production local hosted integration stack using PostgreSQL and S3-compatible storage.
- Add a Railway multi-user pilot with separate API, worker, and migration responsibilities.
- Update AWS guidance for the verified stateless PostgreSQL/S3 profile without making AWS
  mandatory.
- Add strict configuration validation, health/readiness, migration, backup/restore, secret
  rotation, signup kill-switch, deploy, and rollback runbooks.
- Add deployment smoke scripts that exercise real authentication, sync, and browser reads.

## Non-goals

- Provisioning or changing a live Railway/AWS account as part of plan authoring.
- Kubernetes, Redis, Kafka, or a microservice split.
- Cloudflare Workers/D1/R2 or Vercel Functions.
- Multi-region active/active operation.
- Zero-downtime deploys for the SQLite/filesystem profile.
- Direct browser-to-S3 upload tickets.
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

Expose commands through package scripts or a small CLI:

```text
tephra serve
tephra worker
tephra migrate
tephra doctor
```

`doctor` is read-only and validates configuration, public URL, database connectivity/schema,
blob-store access, deployed PostgreSQL role properties, email configuration in multi-user mode,
and mode/storage compatibility. It must not print secrets or send test email unless an explicit
separate command is requested.

Use an immutable version/commit image tag in deployments. Do not deploy production using only
`latest`.

## Configuration matrix

| Variable                           | Single-user                      | Multi-user                                            |
| ---------------------------------- | -------------------------------- | ----------------------------------------------------- |
| `TEPHRA_INSTANCE_MODE`             | `single_user`                    | `multi_user`                                          |
| `TEPHRA_SIGNUP_MODE`               | `closed` only                    | `closed` initially; `open` after acceptance           |
| `TEPHRA_PUBLIC_URL`                | required in production           | required HTTPS origin                                 |
| `TEPHRA_SESSION_SECRET`            | required                         | required, shared by API replicas                      |
| `TEPHRA_AUTH_TOKEN_ENCRYPTION_KEY` | unset                            | required, shared by API and worker                    |
| `TEPHRA_TRUSTED_PROXY_COUNT`       | explicit for chosen ingress      | explicit for chosen ingress                           |
| `TEPHRA_BOOTSTRAP_TOKEN`           | required only before first setup | forbidden                                             |
| `TEPHRA_DATABASE_DRIVER`           | `sqlite`                         | `postgres`                                            |
| `TEPHRA_SQLITE_PATH`               | `/data/tephra.db`                | forbidden                                             |
| `TEPHRA_DATABASE_URL`              | unset                            | required; least-privileged application role           |
| `TEPHRA_MIGRATION_DATABASE_URL`    | unset                            | migrate command only; never injected into API/worker  |
| `TEPHRA_BLOB_DRIVER`               | `filesystem`                     | `s3`                                                  |
| `TEPHRA_BLOB_PATH`                 | `/data/blobs`                    | forbidden                                             |
| S3 endpoint/region/bucket          | unset                            | required; credentials optional with workload identity |
| Email driver/from/credentials      | unset                            | required in multi-user mode                           |

Startup fails before listening when the selected mode and storage/auth configuration disagree.
The Docker default remains single-user with signup closed.

## Profile A — single-user self-hosted

### Topology

```text
Internet or private network
        |
HTTPS reverse proxy / platform ingress
        |
one Tephra container :8080
        |
/data/tephra.db + /data/blobs
```

Supported initial paths:

- Docker Compose on a VPS/home server/NAS with a named or bind-mounted `/data` volume;
- one Railway service with one persistent volume mounted at `/data`;
- the existing single-task AWS/EFS reference, clearly marked as stateful and single replica.

### First deployment

1. Generate independent high-entropy session and bootstrap secrets.
2. Configure the public URL and TLS proxy/platform domain.
3. Start exactly one container and wait for `/readyz`.
4. Open `/setup`, enter the bootstrap token, and create the only account.
5. Remove `TEPHRA_BOOTSTRAP_TOKEN` from runtime configuration and restart.
6. Create a vault and vault-scoped plugin token.
7. Sync a small real vault and verify file, rendered note, attachment, link, and graph reads.
8. Run an initial coordinated backup and prove it can be restored into a disposable instance.

### Operations

- `/healthz` reports process liveness.
- `/readyz` validates database schema/access and blob-store readability/writability with a
  non-user probe that is cleaned immediately.
- Never scale the service above one replica with SQLite/filesystem storage.
- Back up SQLite and the blob directory as one logical dataset. Prefer stopped backups for the
  simplest supported path; an online path must use SQLite's backup API and coordinate blob
  copying.
- Run expired-session/auth-token cleanup and owner-scoped blob GC on a documented schedule.
- Password recovery uses the local operator command from plan 002, never a reopened bootstrap.

### Upgrade and rollback

1. Record the current image digest and run authenticated pre-upgrade smoke.
2. Stop the container and take a coordinated `/data` backup.
3. Run `tephra doctor`, then `tephra migrate` once.
4. Start the new immutable image and run authenticated sync/browse smoke.
5. Retain the backup and prior image through the rollback window.

If a migration has not crossed a destructive contract phase, roll back the image. Otherwise stop
the service and restore the coordinated backup; never point older code at a newer unsupported
schema.

## Profile B — multi-user hosted service

### Topology

```text
HTTPS ingress
    |
Tephra API/web service (one replica for pilot, 2+ after validation)
    |---------------- PostgreSQL
    |---------------- private S3-compatible bucket

Tephra worker service
    |---------------- PostgreSQL auth/index outbox
    |---------------- email provider
    |---------------- private S3-compatible bucket

one-shot migration job uses a separate database migration role
```

API and web remain same-origin. API and worker containers have no persistent local volume. The
application database role is not the migration/table-owner role and is subject to forced RLS.

### Railway pilot layout

Use one Railway project with separate `staging` and `production` environments:

- `tephra-api`: repository Dockerfile, command `tephra serve`, health path `/readyz`;
- `tephra-worker`: same image, command `tephra worker`, no public domain;
- `Postgres`: managed PostgreSQL service;
- one project bucket: S3-compatible private blob storage;
- migration release step/job: same image, command `tephra migrate` with migration credentials.

Because this is an npm workspace with shared packages, keep the repository root as Docker build
context; do not set a restrictive service root directory. Pin Node through the Docker image.

Use Railway variable references for database connectivity and inject bucket credentials as
secrets. Do not commit bucket credentials, database URLs, SMTP secrets, session secrets, or real
domains in `railway.json`.

Start the pilot with one API and one worker. Prove two API replicas pass session, rate-limit,
outbox-claim, RLS, sync-commit, and rolling-restart tests before increasing production replicas.

### Hosted first deployment

1. Provision staging PostgreSQL, bucket, email sender/domain, API, and worker.
2. Create separate migration and application database roles and verify the application role is
   not superuser/table owner/`BYPASSRLS`.
3. Configure mode `multi_user`, signup `closed`, HTTPS public URL, shared session secret, quotas,
   and provider credentials.
4. Run `tephra doctor` and the one-shot migration job.
5. Start the worker, then API; wait for readiness and zero migration drift.
6. Run a two-account staging smoke: register/verify/login, create multiple vaults, sync equal-hash
   content, browse, attempt every cross-account access, revoke sessions/tokens, and restore.
7. Repeat on production with signup closed.
8. Open signup only after alarms, backup/PITR, restore drill, and the security matrix are green.

### Hosted release sequence

1. Build and scan one immutable image; deploy the same digest to staging.
2. Run backward-compatible migrations once with the migration role.
3. Roll worker and API, then run deployment smoke and observe queue lag/errors.
4. Promote the same digest to production.
5. Run migrations once, roll worker, roll API, and run authenticated smoke.
6. Keep destructive schema/object cleanup in a later release after the rollback window.

`TEPHRA_SIGNUP_MODE=closed` is the immediate kill switch for registration. It must not interrupt
existing login, plugin sync, or read-only browsing.

### Hosted operations

- PostgreSQL: automated backups/PITR, connection/pool limits, migration history, restore drills.
- Bucket: private access, encryption, lifecycle for temporary uploads, versioning/retention as
  appropriate, restore/delete tests.
- Email: delivery failure/bounce monitoring and sender-domain configuration.
- Worker: health, oldest-ready-job age, retries, dead letters, and idempotent replay.
- API: readiness, latency/error rate, authentication rate-limit events, quota rejections, storage
  errors, and repeated cross-tenant denials without logging private request data.
- Secrets: platform secret manager, least privilege, documented rotation. Rotating the session
  secret logs out all browser sessions; plugin tokens are independent.
- Deleted data: document active-store deletion and backup retention in the privacy notice.

## Deployment files

Expected changes:

- `tephra-server/deploy/docker/Dockerfile`: shared `serve`/`worker`/`migrate` image.
- `tephra-server/deploy/docker/compose.yml`: retained single-user profile.
- `tephra-server/deploy/docker/compose.hosted-test.yml` (new): PostgreSQL plus S3-compatible
  integration environment, explicitly non-production.
- `tephra-server/deploy/railway/railway.single-user.json`: one replica/volume documentation.
- `tephra-server/deploy/railway/railway.multi-user.example.json`: API reference configuration;
  worker/migration setup documented where one service config cannot express the whole project.
- `tephra-server/deploy/railway/README.md`: both profiles, variable references, bucket, migration,
  smoke, rollback.
- `tephra-server/deploy/aws/`: retain stateful ECS/EFS files; add or update only the stateless
  PostgreSQL/S3 contract verified by plan 003.
- `tephra-server/apps/api/src/main.ts`: `serve` composition.
- `tephra-server/apps/api/src/worker.ts`: outbox/index worker.
- `tephra-server/apps/api/src/cli.ts`: migrate/doctor/operator commands.
- `.env.example`, `tephra-server/.env.example`, root/server READMEs, threat/privacy docs.
- `e2e/deploy-single-user.mjs` and `e2e/deploy-multi-user.mjs` (new): bounded smoke scripts.

Do not update `PROGRESS.md` until the corresponding profile is deployed from a clean environment
and verified.

## Implementation sequence

### Phase 1 — Image and command contract

1. Add `serve`, `worker`, `migrate`, and `doctor` entrypoints with strict mode validation.
2. Update the Dockerfile to ship all entrypoints and migrations as an unprivileged image.
3. Add build metadata endpoint/output without exposing environment secrets.
4. Verify graceful API/worker shutdown and migration locking.

Gate: the image runs every command locally and fails unsafe configuration before accepting
traffic.

### Phase 2 — Single-user profile

1. Update Compose and stateful Railway/AWS examples with explicit single-user mode.
2. Add setup, backup, restore, upgrade, rollback, and recovery documentation.
3. Add single-user deploy smoke automation.
4. Deploy from a clean volume and restore into another clean volume.

Gate: one documented command path yields a working one-container install, and restore preserves
the account, plugin tokens, vault bytes, and revision history.

### Phase 3 — Hosted integration profile

1. Add the non-production PostgreSQL/S3-compatible compose stack.
2. Wire API, worker, migration, SMTP test sink, shared session secret, and quotas.
3. Run the two-account and two-API process suites from plans 002 and 003.
4. Exercise backup/restore and a failed migration/deploy rollback.

Gate: all hosted behavior works without local persistent API/worker state.

### Phase 4 — Railway pilot

1. Document/create the API, worker, PostgreSQL, bucket, staging, and production layout.
2. Add example service configs and exact variable mapping without real secrets.
3. Deploy staging with signup closed, run migration and smoke, then validate two API replicas.
4. Deploy production with signup closed, run restore drill and security acceptance.
5. Enable controlled signup, observe, then open signup.

Gate: a clean Railway environment can be deployed from the runbook and survives API/worker
restart without session, job, or tenant-isolation failure.

### Phase 5 — AWS stateless reference

1. Update AWS documentation/config examples to use the verified image and commands with ALB,
   ECS API/worker, RDS PostgreSQL, and private S3.
2. Use task roles instead of static S3 credentials where possible.
3. Document networking, secrets, migration job, backups, health, scaling, and rollback.
4. Validate config schemas and, when an AWS test environment is available, run the same smoke
   suite. Until then, label it reference-only rather than supported.

## Verification

Build and local checks:

```bash
npm run check
docker build -f tephra-server/deploy/docker/Dockerfile -t tephra:test .
docker compose -f tephra-server/deploy/docker/compose.yml config
docker compose -f tephra-server/deploy/docker/compose.hosted-test.yml config
```

Required smoke assertions:

- health and readiness distinguish process health from dependency readiness;
- configuration errors prevent listening;
- migrations run once under concurrency;
- self-host restart and restore preserve data;
- hosted API/worker replacement preserves sessions/jobs;
- registration is closed by default and mode-disabled routes stay unreachable;
- two users can each own several vaults and cannot access each other's resources;
- real plugin upload creates a verified revision and the browser reads it;
- same-hash cross-user upload, GC, and deletion remain isolated;
- rollback follows the documented non-destructive path.

Validate deployment configuration with provider schemas/CLI before reporting support. Run bounded
logs/metrics checks after any real deployment; do not rely only on a “deployed” status.

## Risks and mitigations

| Risk                                   | Mitigation                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| Self-host accidentally enables signup  | invalid mode combination; signup defaults closed                                  |
| Hosted service starts on local storage | startup rejects SQLite/filesystem in multi-user mode                              |
| Multiple SQLite replicas corrupt state | deployment config pins one replica; readiness/doctor warn and docs forbid scaling |
| API replicas race migrations           | separate one-shot migration command and database migration lock                   |
| Worker duplicates email/index work     | transactional claim, lease, idempotency key, retry tests                          |
| New image cannot read migrated data    | backward-compatible expand/contract migrations and staging rollback drill         |
| Blob/schema rollback loses data        | delay destructive cleanup; coordinated backups; verified restore                  |
| Secrets leak into files/logs           | platform secret injection, redaction tests, placeholder-only examples             |
| Email outage blocks new users          | durable outbox/retry/resend; existing login/sync/browse unaffected                |
| Open signup abuse                      | default closed, database rate limits, quotas, monitoring, one-step kill switch    |
| Provider docs/config drift             | validate against current official schema/CLI during implementation                |

## Completion checklist

- [ ] One immutable image provides serve, worker, migrate, and doctor commands.
- [ ] Unsafe mode/storage/email configuration fails before serving.
- [ ] Single-user Docker and Railway remain one-container/one-volume/one-port workflows.
- [ ] Single-user setup, backup, restore, upgrade, rollback, and recovery are exercised.
- [ ] Hosted runtime uses PostgreSQL/S3 and no local persistent API/worker state.
- [ ] Migration, application, and maintenance database privileges are separated.
- [ ] Hosted worker retries auth/index jobs safely.
- [ ] Hosted two-account isolation and real plugin/browser smoke pass.
- [ ] Railway staging and production runbooks contain no secrets and pass clean deployment tests.
- [ ] AWS remains clearly labeled supported or reference-only according to actual validation.
- [ ] Signup is opened only after plans 002, 003, and 004 are complete.
- [ ] Documentation and `PROGRESS.md` describe only verified behavior.
- [ ] `npm run check` passes.

## References

- `001-TEPHRA_STAGE1_PLAN.md`, sections 28–30, 35–37, 54, and 56–57.
- `002-AUTHENTICATION_MODES.md` for auth configuration and lifecycle.
- `003-MULTI_TENANT_PERSISTENCE.md` for PostgreSQL/S3 and isolation requirements.
- [Railway deployment documentation](https://docs.railway.com/cli/deploying)
- [Railway monorepo documentation](https://docs.railway.com/deployments/monorepo)
- [Railway CLI documentation](https://docs.railway.com/cli)
