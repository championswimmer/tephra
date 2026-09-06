# Tephra Authentication and Deployment Modes — Implementation Plan

> **Status:** Proposed implementation plan; no implementation has started
> **Project:** Tephra Stage 1 read-only web mirror
> **Modes:** single-user self-hosting and multi-user hosted service
> **Last updated:** 2026-09-06

## 1. Context and user outcome

Tephra needs one codebase and one container image that can be operated in two intentionally
different ways:

1. **Single-user self-hosted:** an operator deploys Tephra for themselves, completes a
   one-time first-account setup, and never exposes public registration. SQLite and filesystem
   blobs on one persistent volume remain the default.
2. **Multi-user hosted:** the Tephra operator runs a public service where people create and
   verify their own accounts. Each user owns multiple private vaults, and no request, job,
   cache entry, database query, or blob operation may cross that user boundary. This profile
   uses PostgreSQL, S3-compatible object storage, and a configured email service.

The implementation must preserve the Stage 1 product boundary: Obsidian remains canonical,
sync is plugin-to-server only, and the web application does not edit or write back to a vault.

The repository already contains useful foundations:

- one-time bootstrap, password login, opaque database-backed sessions, CSRF cookies, and
  vault-scoped plugin tokens;
- `vaults.owner_user_id` and owner-filtered vault listing;
- a working SQLite/filesystem Node composition root and one-container deployment;
- placeholder PostgreSQL and S3 packages, but no implementations;
- `TEPHRA_ALLOW_SIGNUPS` in examples, but no registration, verification, recovery, hosted
  deployment validation, or complete tenant isolation model.

This plan replaces the ambiguous signup flag with explicit instance modes and completes the
security and infrastructure required for each mode.

## 2. Architecture decisions

These decisions are part of the plan and should not be reopened during implementation unless
new evidence requires updating this document.

### 2.1 One auth domain, two instance modes

Use the existing Tephra auth package for both modes. Do not fork the API or web application and
do not require a commercial identity provider.

Add:

```text
TEPHRA_INSTANCE_MODE=single-user | multi-user
```

The Docker image defaults to `single-user`. Production startup validates the complete mode
matrix and fails closed on an unsafe combination.

| Behavior              | `single-user`                           | `multi-user`                       |
| --------------------- | --------------------------------------- | ---------------------------------- |
| First account         | bootstrap token                         | public registration                |
| Maximum accounts      | exactly one active login account        | many                               |
| Registration endpoint | unavailable                             | gated by signup mode               |
| Email required        | no                                      | yes                                |
| Email verification    | no                                      | required before login              |
| Password recovery     | operator-assisted local command         | email token                        |
| Default persistence   | SQLite + filesystem                     | PostgreSQL + S3-compatible         |
| Replica count         | exactly one                             | stateless API replicas plus worker |
| Browser/API product   | same routes and UI after authentication | same                               |

### 2.2 A user account is the Stage 1 tenant

For this plan, one verified `User` is one personal tenant and may own many vaults. Keep
`vaults.owner_user_id`; do not add organizations, teams, invitations, shared vaults, or tenant
switching.

Derive tenant context only from a verified session or a vault-scoped plugin token. A user-,
vault-, or tenant-like identifier supplied in a URL, header, request body, or queued payload is
only a selector and never proof of access.

Introduce a request-local value:

```ts
interface TenantContext {
  ownerUserId: string;
  principal: 'browser-session' | 'plugin-token' | 'internal-job';
}
```

Every tenant-owned repository and service operation must require this context or an explicit
`ownerUserId`. Keep unscoped persistence access limited to authentication lookup, migrations,
garbage collection, and narrowly defined operator jobs.

### 2.3 Built-in email/password auth first

Implement local email/password authentication for both modes. Preserve the `PasswordHasher`
interface so a later hosted deployment can add OIDC/passkeys or replace identity verification
without changing vault ownership.

Use Argon2id for new passwords in the Node runtime. Continue to verify existing encoded scrypt
hashes and replace them with the current Argon2id parameters after a successful login. Never
silently truncate passwords. Use a minimum length of 12 characters, accept Unicode and spaces,
and allow at least 128 characters.

### 2.4 Server-side opaque sessions

Keep opaque, server-side sessions rather than adding JWT access/refresh tokens. The browser
receives only cookies; it does not store credentials in local or session storage.

- Generate session and CSRF secrets with a cryptographically secure RNG.
- Store only an HMAC-SHA-256 digest of the session secret, keyed by
  `TEPHRA_SESSION_SECRET`.
- Store a digest of the CSRF secret on the same session row so the double-submit value is bound
  to that session.
- Use a production `__Host-` session cookie with `HttpOnly`, `Secure`, `SameSite=Lax`, and
  `Path=/`; use a non-prefixed non-secure development cookie only on loopback HTTP.
- Give sessions a 30-day absolute lifetime and 7-day idle lifetime. Throttle `last_seen_at`
  writes to at most once every five minutes.
- Rotate the session and CSRF values at login and after a password change. Password reset,
  account disablement, and “log out all devices” invalidate every session for the user.
- Require recent password authentication (within 15 minutes) for changing password, deleting
  the account, or creating/revoking plugin tokens.

The current API expects `X-Tephra-CSRF`, while the web client sends `X-CSRF-Token`. Standardize
both on `X-Tephra-CSRF`, add an Origin check for unsafe cookie-authenticated requests, and add a
regression test before extending auth flows.

### 2.5 Tenant-scoped blob storage

Global hash-only blob addressing leaks whether another account has uploaded the same content
and makes per-account deletion harder. Change the logical blob key to:

```text
(owner_user_id, sha256)
```

and the object-store/filesystem key to an opaque namespace such as:

```text
users/<owner-user-uuid>/blobs/<first-two-hash-chars>/<sha256>
```

Deduplicate within one user across their vaults, not across users. Original bytes remain
canonical, objects remain immutable, and SHA-256 plus declared size must still be verified
before metadata is committed.

### 2.6 Hosted Node profile first

The first multi-user deployment target is the existing Node/Hono application running as a
stateless container with PostgreSQL and S3-compatible storage. Do not claim Cloudflare,
Vercel, D1, or R2 support in this plan; those require separate runtime and adapter work.

The hosted topology is vendor-neutral and can be instantiated on Railway for an initial pilot
or on AWS for a larger production environment:

```text
TLS load balancer / reverse proxy
        |
        +-- 2+ Tephra API/web containers
        |
        +-- 1+ Tephra worker containers
                  |
        PostgreSQL + S3-compatible private bucket + email provider
```

The API and SPA remain same-origin. Redis, Kafka, Kubernetes, and a separate auth service are
not requirements.

## 3. Scope

### 3.1 Shared authentication and account lifecycle

- explicit instance mode and public auth-capabilities endpoint;
- bootstrap/login/logout/current-user flows;
- hosted registration, email verification, verification resend, forgotten-password, password
  reset, password change, and logout-all flows;
- server-side session hardening and CSRF correction;
- database-backed rate limiting suitable for multiple replicas;
- safe auth/audit events without raw emails, IP addresses, secrets, or vault contents;
- operator commands for single-user recovery and hosted user disable/enable;
- account deletion/offboarding with session and plugin-token revocation.

### 3.2 Tenant isolation

- owner-scoped repository/service APIs;
- negative authorization tests for every vault surface;
- user-namespaced blobs and garbage collection;
- tenant-aware indexing, background jobs, quotas, caches, logs, and object keys;
- PostgreSQL row-level security as defense in depth for tenant-owned tables;
- a least-privileged PostgreSQL request role that is not a superuser, table owner, or
  `BYPASSRLS` role.

### 3.3 Deployments

- preserve and document the one-container SQLite/filesystem self-host profile;
- implement the PostgreSQL database and S3-compatible blob adapters;
- add a durable PostgreSQL-backed outbox/job worker for email and indexing retries;
- document and provide checked-in examples for a multi-user Railway pilot and AWS production
  profile;
- migration, release, backup/restore, health check, secret rotation, signup kill switch, and
  rollback procedures.

## 4. Explicit non-goals

- Web-to-vault writes, bidirectional sync, merging, public publishing, or third-party Obsidian
  plugin execution.
- Organizations, teams, shared vault ownership, invitations, roles inside a tenant, or SSO.
- Social login, OIDC, SAML, passkeys, MFA, or account linking in the first implementation.
- A hosted operator UI, support-agent impersonation, or routine operator access to vault
  contents. Initial operator actions are audited CLI/job operations only.
- Billing, subscriptions, paid tiers, tax, or payment-provider integration.
- End-to-end encryption or per-tenant KMS keys.
- Kubernetes, Redis, Kafka, Elasticsearch, or a new microservice architecture.
- Cloudflare Worker/D1/R2 and Vercel Function deployment in this plan.
- Direct browser-to-object-store uploads. Keep authenticated streaming through the API until
  measured platform limits justify a separate, carefully scoped upload-ticket plan.

## 5. Security and product invariants

1. A known vault ID, file ID, revision, token ID, blob hash, object key, or job ID never grants
   access by itself.
2. All vault reads and server-side destructive actions are authorized against a server-derived
   `ownerUserId`; return not-found where appropriate to avoid confirming another user's object.
3. Plugin tokens remain opaque, hash-only at rest, revocable, least privilege, and scoped to
   exactly one vault and its owner.
4. Browser sessions cannot authenticate plugin upload calls, and plugin tokens cannot perform
   account, signup, password, billing, or cross-vault actions.
5. Registration, login, verification resend, and password-reset request responses do not reveal
   whether an email address is registered. Timing should be made reasonably uniform.
6. One-time tokens are random, hash-only at rest, single-use, purpose-bound, and expiring.
7. Email links are constructed only from validated `TEPHRA_PUBLIC_URL`, never an inbound Host or
   forwarding header.
8. Passwords, raw one-time tokens, session cookies, CSRF secrets, plugin tokens, email message
   bodies, database URLs, storage credentials, and vault contents never enter logs.
9. Markdown and attachments remain untrusted even in single-user mode. Existing sanitization,
   CSP, `nosniff`, and forced-download protections stay enabled.
10. The multi-user mode must not start with SQLite, filesystem blobs, missing HTTPS public URL,
    missing email delivery, or an unset/placeholder session secret.
11. The single-user mode must not expose registration and must not silently accept a second
    active account.
12. Original file bytes remain canonical; successful changed sync commits remain atomic and
    monotonically revisioned.

## 6. Configuration contract

Replace `TEPHRA_ALLOW_SIGNUPS` with this fail-closed contract:

```text
TEPHRA_INSTANCE_MODE=single-user|multi-user
TEPHRA_SIGNUP_MODE=closed|open
TEPHRA_PUBLIC_URL=https://notes.example.com
TEPHRA_SESSION_SECRET=<at least 32 random bytes>

# single-user first setup only
TEPHRA_BOOTSTRAP_TOKEN=<one-time random secret>

# multi-user open signup
TEPHRA_EMAIL_DRIVER=smtp
TEPHRA_EMAIL_FROM=Tephra <no-reply@example.com>
TEPHRA_SMTP_HOST=...
TEPHRA_SMTP_PORT=...
TEPHRA_SMTP_USERNAME=...
TEPHRA_SMTP_PASSWORD=...
TEPHRA_SMTP_SECURE=true

# multi-user persistence
TEPHRA_DATABASE_DRIVER=postgres
TEPHRA_DATABASE_URL=...
TEPHRA_DATABASE_POOL_MAX=...
TEPHRA_BLOB_DRIVER=s3
TEPHRA_S3_ENDPOINT=...
TEPHRA_S3_REGION=...
TEPHRA_S3_BUCKET=...
TEPHRA_S3_ACCESS_KEY_ID=...       # omit when workload identity is available
TEPHRA_S3_SECRET_ACCESS_KEY=...   # omit when workload identity is available

# initial per-user safeguards; exact defaults documented with implementation
TEPHRA_MAX_VAULTS_PER_USER=...
TEPHRA_MAX_FILES_PER_VAULT=...
TEPHRA_MAX_UNIQUE_BLOB_BYTES_PER_USER=...
```

Validation rules:

- Default `TEPHRA_INSTANCE_MODE` to `single-user` for backward compatibility.
- Default `TEPHRA_SIGNUP_MODE` to `closed` in every mode.
- Reject `SIGNUP_MODE=open` outside `multi-user`.
- Reject `multi-user` unless PostgreSQL, S3-compatible storage, HTTPS public URL, a functioning
  email driver, and a non-placeholder session secret are configured.
- Reject a bootstrap token in `multi-user` to avoid an unintended privileged first account.
- In `single-user`, require a bootstrap token only while the database has no user; after setup,
  allow the operator to remove it.
- Persist the initialized instance mode in an `instance_settings` singleton row and reject a
  conflicting environment value. Mode conversion requires an explicit future migration command,
  not a configuration typo.
- Trust proxy headers only from configured proxy hops. Cookie security and generated links use
  `TEPHRA_PUBLIC_URL`, not inferred request values.

Expose only non-secret capabilities:

```text
GET /api/v1/auth/config

{
  "instanceMode": "single-user" | "multi-user",
  "bootstrapRequired": boolean,
  "signupMode": "closed" | "open",
  "emailVerificationRequired": boolean
}
```

## 7. API and web-flow changes

### 7.1 API routes

Retain:

```text
POST /api/v1/auth/bootstrap
POST /api/v1/auth/login
POST /api/v1/auth/logout
GET  /api/v1/auth/me
```

Add:

```text
GET  /api/v1/auth/config
POST /api/v1/auth/register
POST /api/v1/auth/email/verify
POST /api/v1/auth/email/resend
POST /api/v1/auth/password/forgot
POST /api/v1/auth/password/reset
POST /api/v1/auth/password/change
POST /api/v1/auth/sessions/revoke-all
DELETE /api/v1/account
```

Mode behavior:

- `/bootstrap` returns 404 outside `single-user` and returns 409 after the first account exists.
- `/register` returns 404 unless the instance is `multi-user` with open signup.
- Public registration/recovery endpoints return a generic accepted response even when the email
  is already registered, unknown, disabled, or rate-limited internally.
- A registered multi-user account starts `pending_verification`; login is unavailable until a
  valid verification token activates it.
- Verification consumes the token and redirects the user to login; it does not silently create
  a session.
- Password reset consumes its token, replaces the password hash, invalidates all sessions and
  outstanding auth tokens, sends a notification, and requires a normal login.
- Account deletion requires recent password authentication and typed confirmation, immediately
  revokes sessions/plugin tokens, marks the account `deleting`, and enqueues idempotent cleanup.

### 7.2 Web routes and state

Add:

```text
/register
/verify-email
/forgot-password
/reset-password
```

Update auth state to consume `/auth/config` before routing:

- single-user + empty database -> `/setup`;
- single-user + existing account -> `/login` with no registration link;
- multi-user + anonymous -> `/login`, with registration link only when signup is open;
- verified session -> `/vaults`;
- pending verification -> confirmation/resend screen.

Keep errors accessible but generic. Do not place raw one-time tokens into application logs,
analytics, referrers, or persistent browser storage. After reading a token from a URL, submit it
in the request body and replace the browser history entry with a token-free URL.

### 7.3 Operator commands

Add explicit non-interactive-safe commands using the same adapters as the service:

```text
tephra auth issue-single-user-recovery
tephra auth reset-single-user-password --token <one-time-token>
tephra auth disable-user --user-id <uuid>
tephra auth enable-user --user-id <uuid>
tephra auth revoke-user-sessions --user-id <uuid>
```

Commands must prefer secrets on stdin or an interactive prompt; command help must warn that
shell arguments may be retained in history/process listings. Operator actions emit metadata-only
audit events. There is no operator command to read vault content.

## 8. Data model and migrations

Never edit `migrations/sqlite/001_initial.sql`. Add numbered SQLite migrations and introduce a
parallel PostgreSQL migration directory/run mechanism.

### 8.1 User and session changes

Extend `users` with:

```text
normalized_email        TEXT NOT NULL UNIQUE
email_verified_at       INTEGER NULL
status                  TEXT NOT NULL  # pending_verification|active|disabled|deleting
instance_role           TEXT NOT NULL  # instance_admin|user
password_changed_at     INTEGER NULL
```

Continue storing the user-facing email separately. Normalize consistently in one auth-domain
function; do not apply provider-specific Gmail-style dot or plus-address transformations.

Extend `sessions` with:

```text
csrf_token_hash         TEXT NOT NULL
authenticated_at        INTEGER NOT NULL
last_seen_at            INTEGER NOT NULL
revoked_at              INTEGER NULL
```

Existing sessions cannot be converted to HMAC lookup or session-bound CSRF without raw secrets;
the migration intentionally invalidates them and requires one fresh login.

### 8.2 One-time tokens, rate limits, jobs, audit, and quota

Add:

```text
auth_one_time_tokens
  id, user_id, purpose, token_hash, expires_at, used_at, created_at

auth_rate_limits
  bucket_hash, action, window_started_at, attempt_count, blocked_until, expires_at

outbox_jobs
  id, owner_user_id NULL, type, payload_json, status, attempts,
  available_at, locked_at, locked_by, last_error_code, created_at, updated_at

auth_audit_events
  id, user_id NULL, event_type, outcome, request_id NULL,
  source_fingerprint NULL, metadata_json, created_at

user_usage
  owner_user_id, vault_count, unique_blob_count, unique_blob_bytes, updated_at

instance_settings
  singleton_id, instance_mode, initialized_at
```

- Hash rate-limit identifiers with a rotating/peppered server key; do not store raw IP addresses
  or email addresses in rate-limit/audit rows.
- Allowlist job types and validate their payload schema before execution. A tenant-owned job
  always carries `owner_user_id` and rechecks ownership when it runs.
- Store only bounded error codes/messages in jobs; never serialize content or credentials.
- Make email send, index retry, account deletion, expired-session cleanup, expired-token cleanup,
  and blob GC idempotent worker operations.
- Update usage transactionally with commits/deletions and provide a reconciliation command that
  recomputes it from canonical rows.

### 8.3 Tenant-scoped blobs

Change blob metadata to a composite identity:

```text
blobs
  owner_user_id, hash, size, mime_type, created_at
  PRIMARY KEY(owner_user_id, hash)
```

Update blob references and garbage-collection queries accordingly. Migration procedure:

1. Back up SQLite and blob data.
2. Derive each blob's owner(s) by joining current files and retained versions through vaults.
3. Create one verified namespaced object per owner; hard links may be used only as a filesystem
   adapter optimization when safe, never as domain semantics.
4. Insert tenant-scoped metadata only after object hash and size verification succeeds.
5. Switch reads/writes to namespaced keys.
6. Keep old global objects during a documented rollback window, then remove them through a
   separate, explicit cleanup release.

Because hosted mode is not yet deployable, complete this migration before opening public signup.

### 8.4 PostgreSQL RLS defense in depth

Apply RLS to vaults, tokens, blob metadata, current files, revisions, versions, note metadata,
links, and tenant-owned jobs. Use transaction-local `app.owner_user_id` and fail closed when it is
absent. Policies on tables without a direct owner column must join through `vaults`.

Use separate roles:

- **migration role:** owns schema; never used by serving processes;
- **request/worker role:** least privilege, no superuser or `BYPASSRLS`, subject to forced RLS;
- **maintenance role:** only for named jobs that cannot operate through tenant context, with
  explicit allowlisted commands and audit.

Set tenant context with `SET LOCAL`/transaction-local configuration on every transaction and
clear it by commit/rollback before returning a pooled connection. Do not store tenant context in
process-global state or a connection-level setting that can leak through a pool.

## 9. Package and file ownership boundaries

Expected implementation areas:

| Area                                                | Responsibility                                                                                               |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `tephra-server/packages/vault-model/`               | user/account/session/tenant blob domain types only                                                           |
| `tephra-server/packages/auth/`                      | normalization, password policy/hash migration, session and one-time-token primitives; no email/network calls |
| `tephra-server/packages/database/core/`             | auth repositories, tenant-scoped repository interfaces, transaction and job contracts                        |
| `tephra-server/packages/database/sqlite/`           | single-user-compatible migrations/adapters and contract tests                                                |
| `tephra-server/packages/database/postgres/`         | PostgreSQL repositories, transactions, migration runner, RLS policies, job claiming                          |
| `tephra-server/packages/blob-store/core/`           | namespace-aware immutable blob contract                                                                      |
| `tephra-server/packages/blob-store/filesystem/`     | namespaced paths, atomic writes, migration helper                                                            |
| `tephra-server/packages/blob-store/s3/`             | namespaced keys, streaming upload/read/delete, integrity metadata, contract tests                            |
| `tephra-server/packages/email/core/` (new)          | browser-safe email-delivery interface and template input types                                               |
| `tephra-server/packages/email/smtp/` (new)          | Node-only SMTP adapter; credentials remain runtime-only                                                      |
| `tephra-server/apps/api/src/app.ts`                 | mode-aware routes, auth middleware, tenant derivation, quotas, generic errors                                |
| `tephra-server/apps/api/src/config.ts` (new)        | parse/validate/freeze runtime configuration                                                                  |
| `tephra-server/apps/api/src/main.ts`                | Node composition for selected adapters and command mode                                                      |
| `tephra-server/apps/api/src/worker.ts` (new)        | durable job claiming, retry/backoff, graceful shutdown                                                       |
| `tephra-server/apps/web/`                           | config-driven setup/register/verify/recovery UI and CSRF fix                                                 |
| `tephra-server/deploy/docker/`                      | single-user compose plus hosted local-integration example                                                    |
| `tephra-server/deploy/railway/`                     | single-user profile retained; multi-user pilot instructions/config                                           |
| `tephra-server/deploy/aws/`                         | stateful profile retained; stateless PostgreSQL/S3 hosted profile                                            |
| `docs/`, root/server/plugin READMEs, `.env.example` | mode matrix, setup, recovery, privacy, backup, deployment, token flow                                        |

Shared packages must remain browser-safe. Node crypto, SMTP, PostgreSQL, filesystem, and S3 SDK
usage belongs only in their Node adapters/entrypoints.

## 10. Ordered implementation phases

### Phase 0 — Contract freeze and security test matrix

1. Record current auth/API behavior with tests before refactoring.
2. Add a reusable two-user/two-vault authorization matrix covering list, get, delete, token,
   plan, upload, commit, files, raw content, attachments, rendered notes, links, backlinks,
   search, tree, graph, and indexing.
3. Add a regression test demonstrating the current CSRF header mismatch, then fix it in Phase 1.
4. Add database and blob-store adapter contract-test harnesses so SQLite/PostgreSQL and
   filesystem/S3 must behave identically.

**Gate:** tests fail for deliberate cross-user access and pass for the owner; no production
behavior has changed yet.

### Phase 1 — Configuration, session hardening, and single-user completion

1. Add strict config parsing and `/auth/config`.
2. Implement explicit modes, leaving `single-user` as the default.
3. Bind CSRF tokens to sessions, standardize the header, add Origin enforcement, idle expiry,
   session rotation, password change, and revoke-all.
4. Add Argon2id plus scrypt verification/rehash.
5. Make bootstrap create the only `instance_admin`; make concurrent bootstrap transactional and
   permanently unavailable afterward.
6. Add operator-assisted single-user recovery without email.
7. Update setup/login UI and Docker/self-host documentation.

**Gate:** an upgraded self-host installation retains its user/vaults/tokens, is asked to log in
again once, cannot create a second account, and passes the complete existing sync/browse suite.

### Phase 2 — Registration and account lifecycle

1. Add user status, normalized email, one-time token, rate-limit, audit, and outbox repositories.
2. Add the email interface and SMTP adapter with plain-text and minimal HTML templates.
3. Implement register/verify/resend/forgot/reset/change/logout-all routes with generic public
   responses and transactional single-use tokens.
4. Add database-backed rate limits for IP fingerprint + normalized-email fingerprint on
   registration, login, resend, and reset request/consume paths.
5. Add web registration, verification, and recovery pages.
6. Implement disabled/deleting account handling and operator commands.

**Gate:** multi-replica tests cannot bypass limits through another API process; email failures
retry from the outbox without duplicating account state or token use.

### Phase 3 — Tenant-isolation refactor and quotas

1. Add `TenantContext` and refactor public handlers/services to tenant-scoped repositories.
2. Namespace database blob metadata and BlobStore operations by owner user ID.
3. Update plan/upload/commit/read/index/GC flows and plugin-token authorization.
4. Make index and email jobs tenant-aware; include owner in every cache/job key.
5. Add transactional user usage and configured vault/file/storage limits.
6. Execute and verify the existing-data blob migration.

**Gate:** the full two-user matrix passes, including two users uploading the same hash; neither
can detect, read, reference, delete, index, or garbage-collect the other's object.

### Phase 4 — PostgreSQL, S3, and durable worker

1. Implement PostgreSQL migrations and every `Database` repository contract.
2. Implement transaction-local tenant context, RLS policies, least-privileged roles, vault
   commit serialization, and safe pooled-connection reuse.
3. Implement S3-compatible storage with namespaced object keys, bounded/streamed I/O, immutable
   writes, SHA-256 verification, and safe idempotency.
4. Implement PostgreSQL outbox claiming with `SKIP LOCKED` or equivalent transactional claiming,
   bounded concurrency, exponential backoff with jitter, dead-letter visibility, and graceful
   shutdown.
5. Make API readiness validate database access and blob-store access without writing user data;
   expose separate worker health/lag metrics.
6. Run the same integration suite against SQLite/filesystem and PostgreSQL/S3-compatible test
   infrastructure.

**Gate:** hosted mode startup succeeds only with working shared adapters, and two API replicas
plus one worker pass signup, login, sync, browse, restart, and concurrency tests.

### Phase 5 — Deployment artifacts and runbooks

1. Keep the existing stateful Docker/Railway/AWS single-user examples at one replica and add
   explicit `TEPHRA_INSTANCE_MODE=single-user`.
2. Add a local hosted integration compose profile containing PostgreSQL and an S3-compatible
   development service, clearly marked non-production.
3. Add a Railway multi-user pilot profile: stateless API service, managed PostgreSQL, private
   S3-compatible bucket, worker service, migration release command, HTTPS domain, and SMTP
   secrets. Do not attach `/data` or set a bootstrap token.
4. Add an AWS production reference: ALB + ECS API/worker services, RDS PostgreSQL, private S3
   bucket, workload-role credentials, managed secrets, encryption, database backups/PITR, bucket
   versioning/lifecycle, and restricted network paths.
5. Add predeploy migration, postdeploy smoke, signup close/open, session-secret rotation,
   backup/restore, account recovery, and rollback runbooks.
6. Update root/server/plugin docs and environment examples. Remove claims that placeholder
   adapters are deployable until their gates pass.

**Gate:** a clean single-user install and a clean multi-user staging install can each be deployed
from documentation alone and pass their smoke scripts.

### Phase 6 — Hosted staging, security review, and controlled launch

1. Deploy with signup closed and seed two test accounts through an operator-only staging path.
2. Run authorization regression, concurrent sync, quota, worker retry, session rotation,
   database restore, and object restore drills.
3. Review all SQL, object keys, logs, metrics labels, queued payloads, and error responses for
   tenant data leakage.
4. Run dependency/security scanning and a focused external review of auth and cross-tenant
   boundaries.
5. Enable signup for a small allowlisted/pilot audience, observe rate-limit and worker metrics,
   then switch to open signup only after acceptance criteria hold.

## 11. Detailed deployment runbooks

### 11.1 Single-user self-hosted

Target:

```text
one Tephra container
one persistent /data volume
one HTTPS origin
SQLite at /data/tephra.db
filesystem blobs under /data/blobs
```

Deploy sequence:

1. Generate independent session and bootstrap secrets.
2. Start exactly one container behind TLS with mode `single-user`.
3. Wait for `/readyz`, open `/setup`, and create the administrator with the bootstrap token.
4. Remove the bootstrap token from runtime secrets and restart.
5. Create a vault and one vault-scoped plugin token; complete a real plugin sync and browser read.
6. Schedule coordinated SQLite/blob backups and expired-session/blob-GC maintenance.
7. Before upgrade, take a backup; run the new image's migration command once; start the image;
   run authenticated browse-and-sync smoke tests; retain the old image and backup through the
   rollback window.

Constraints:

- never scale beyond one process with SQLite/filesystem storage;
- never set signup open;
- use the recovery command if the password is lost; do not re-enable bootstrap;
- a load balancer health response is not sufficient—test authenticated content after upgrades.

### 11.2 Multi-user hosted service

Target:

```text
same immutable image, separate commands:
  migrate (one-shot)
  serve   (2+ stateless replicas)
  worker  (1+ replicas with safe job claiming)

shared PostgreSQL
private S3-compatible object storage
transactional email provider/SMTP relay
single HTTPS application origin
```

Deploy sequence:

1. Provision PostgreSQL with separate migration and request roles, automated backup/PITR, and
   restricted networking.
2. Provision a private bucket with encryption, versioning/retention policy, blocked public
   access, and workload identity where the platform supports it.
3. Configure verified email sender/domain and delivery monitoring.
4. Store secrets in the platform secret manager; do not bake them into images or config files.
5. Run migrations once with the migration role and verify RLS/request-role assertions.
6. Start workers, then API replicas, with signup closed.
7. Run readiness plus two-account registration/sync/read/isolation smoke tests.
8. Open signup through configuration only after smoke tests and monitoring succeed.
9. For each release: close or leave signup as policy requires, run backward-compatible migration,
   roll API/worker replicas, run smoke tests, then complete any delayed destructive cleanup in a
   later release.

Operational minimums:

- alerts for readiness failure, database saturation, worker lag/dead letters, email delivery
  failure, auth rate-limit spikes, repeated cross-tenant-denial events, storage errors, and quota
  reconciliation drift;
- periodic restore drills for PostgreSQL and object storage, not only backup-success checks;
- a documented retention window for deleted account data in backups;
- a one-step signup kill switch (`TEPHRA_SIGNUP_MODE=closed`) that does not affect existing users;
- session-secret rotation runbook that explicitly warns all browser sessions will be invalidated;
- no global support/operator browser session capable of browsing private vaults.

## 12. Test and verification plan

### 12.1 Unit tests

- email normalization and collision behavior;
- Argon2id hash/verify, legacy scrypt verify, rehash decision, malformed encodings;
- random session/token creation, HMAC/hash behavior, expiry, single use, wrong purpose;
- cookie attributes in development/production and session-bound CSRF validation;
- password rules without silent truncation;
- config validation for every safe/unsafe mode combination;
- rate-limit bucket hashing/window transitions;
- email template escaping and trusted-origin link construction;
- namespace-safe object-key construction and path traversal rejection.

### 12.2 API/security integration tests

- concurrent single-user bootstrap creates exactly one account;
- bootstrap and register are unavailable in the wrong modes;
- generic registration/reset responses resist user enumeration;
- unverified, disabled, deleting, and expired-session accounts cannot authenticate;
- reset token replay, verification token replay, token purpose swap, and expired token fail;
- password reset and revoke-all invalidate every session;
- CSRF header/cookie/session mismatch and malicious Origin fail;
- plugin bearer requests remain independent of CSRF and cannot call account routes;
- recent-auth requirements reject old sessions;
- rate limits hold across two API instances;
- account deletion revokes access immediately and cleanup is retry-safe.

For Alice and Bob, test all identifiers in both directions:

- vault list/get/delete;
- plugin token list/create/revoke and cross-vault token use;
- sync plan/blob upload/commit;
- file/tree/search/raw/rendered/attachment routes;
- links/backlinks/graph and index jobs;
- identical blob hashes, GC, quotas, account deletion, and job replay.

### 12.3 Adapter and migration tests

- run the full database contract against SQLite and PostgreSQL;
- run blob contracts against filesystem and an S3-compatible test service;
- verify PostgreSQL request role properties and RLS with missing/wrong/correct tenant context;
- prove pooled connections do not retain the prior transaction's tenant context;
- migrate a copy of the current `001_initial.sql` database containing a user, sessions, multiple
  vaults, revisions, tokens, shared hashes, and note indexes;
- verify every migrated object hash/size and rollback-window compatibility;
- prove failed migrations leave the prior schema/data usable or restore cleanly from backup.

### 12.4 Browser and deployment tests

- single-user first setup, login, logout, recovery, vault/token creation, plugin sync, browse;
- multi-user register, verify, login, recovery, multiple vaults, isolation, deletion;
- two browser contexts for cross-account navigation and stale-session behavior;
- container restart retains self-host data;
- hosted API replica replacement retains sessions and jobs;
- backup/restore environment passes authenticated sync/browse and revision checks.

Required final commands include:

```bash
npm run check
npm test --workspace=@tephra/auth
npm test --workspace=@tephra/database-sqlite
npm test --workspace=@tephra/database-postgres
npm test --workspace=@tephra/blob-store-filesystem
npm test --workspace=@tephra/blob-store-s3
npm test --workspace=@tephra/api
npm test --workspace=@tephra/web
```

Also run the repository's web E2E suite, hosted integration compose smoke suite, Docker image
build, migration test, and both deployment smoke scripts.

## 13. Compatibility, rollout, and rollback risks

| Risk                                                            | Mitigation / rollback                                                                                         |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Existing browser sessions cannot migrate to HMAC + bound CSRF   | Deliberately invalidate once; plugin tokens are unaffected                                                    |
| Blob namespacing is long-running or duplicates storage          | Offline/self-host preflight, free-space check, resumable copy+verify, retain old keys through rollback window |
| Accidental public signup on self-host                           | explicit mode, signup defaults closed, incompatible config fails startup                                      |
| Accidental multi-user use of local state                        | multi-user startup rejects SQLite/filesystem and verifies shared adapters                                     |
| Missed owner predicate leaks data                               | tenant-scoped repository API + complete negative matrix + PostgreSQL forced RLS                               |
| Pooled Postgres tenant context leaks                            | transaction-local setting, mandatory transaction wrapper, connection reuse regression test                    |
| Email outage strands signup/reset                               | durable outbox, resend flow, retry/backoff, delivery alerts; existing sessions continue                       |
| Rate limiting blocks legitimate shared-IP users                 | combine IP and account fingerprints, bounded backoff, metrics, configurable thresholds                        |
| Secret rotation logs everyone out                               | documented behavior and staged rotation; never rotate bootstrap as session secret                             |
| Quota counters drift                                            | canonical reconciliation job and fail-safe limits around uploads/commits                                      |
| Account deletion removes a shared physical object               | per-user blob namespace prevents cross-user sharing; GC is owner-scoped                                       |
| Database migration rollback is unsafe after destructive cleanup | additive expand/contract migrations; destructive cleanup only in a later release after backup/rollback window |
| Hosted operator gains unintended content access                 | no admin browse UI/impersonation, separate least-privilege roles, audited maintenance paths                   |

## 14. Documentation changes

Update only when corresponding behavior is implemented and verified:

- root and server README mode-selection table and environment variables;
- Docker, Railway, and AWS deployment guides for both profiles;
- first setup, login, password recovery, session revocation, and plugin token instructions;
- hosted email/DNS, signup kill switch, account disable/delete, backup/restore, and secret-rotation
  runbooks;
- `docs/THREAT_MODEL.md` with public-auth abuse, email/token threats, cross-tenant storage/query/
  job/cache risks, and operator boundaries;
- `docs/PRIVACY_TEMPLATE.md` with account email, operational metadata, deletion, and backup
  retention disclosures;
- `SECURITY.md` supported versions and hosted vulnerability-reporting expectations;
- `PROGRESS.md` only after features and deployment profiles pass their gates.

## 15. Completion checklist

### Shared

- [ ] Explicit fail-closed instance mode replaces ambiguous signup behavior.
- [ ] Session, cookie, CSRF, password, token, and rate-limit controls pass regression tests.
- [ ] Plugin tokens remain single-vault and cannot perform browser/account actions.
- [ ] All Stage 1 sync, immutable-blob, revision, rendering, and read-only constraints still pass.

### Single-user

- [ ] Fresh one-container install supports exactly one bootstrap-created administrator.
- [ ] Registration/email dependencies are absent and unreachable.
- [ ] Operator-assisted password recovery works without reopening bootstrap.
- [ ] SQLite/filesystem backup, migration, restore, and authenticated smoke test are documented and
      exercised.
- [ ] Deployment remains exactly one replica with one persistent volume and one port.

### Multi-user

- [ ] Open registration, verification, login, recovery, password change, revoke-all, disable, and
      deletion lifecycles work.
- [ ] One user can own and sync multiple private vaults.
- [ ] The full Alice/Bob cross-tenant matrix passes on PostgreSQL/S3.
- [ ] Blob storage, indexing, jobs, quotas, audit, GC, and account deletion are tenant-aware.
- [ ] PostgreSQL RLS and least-privileged deployed roles are verified at runtime.
- [ ] API and worker replicas are stateless and safe under concurrency/restart.
- [ ] Signup can be closed without taking down existing login/sync/browse traffic.
- [ ] Railway pilot and AWS production runbooks pass clean-environment deploy/restore smoke tests.

### Repository

- [ ] All schema changes are new numbered migrations; released migrations are unchanged.
- [ ] Public configuration and deployment docs match real implemented adapters only.
- [ ] No secrets, raw identifiers used for rate limiting, or vault contents appear in logs/tests.
- [ ] `npm run check` passes.

## 16. Source references

Internal sources of truth:

- `.agents/plans/001-TEPHRA_STAGE1_PLAN.md`
- `tephra-server/apps/api/src/app.ts`
- `tephra-server/apps/api/src/main.ts`
- `tephra-server/packages/auth/src/index.ts`
- `tephra-server/packages/database/core/src/index.ts`
- `tephra-server/deploy/`
- `docs/THREAT_MODEL.md`
- `AGENTS.md`

Security guidance used for this design:

- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [OWASP Multi-Tenant Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)
- [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
