# Tephra Multi-Tenant Persistence and Isolation

> Status: implementation plan
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`; auth identities from `002-AUTHENTICATION_MODES.md`
> Required before: enabling multi-user signup or executing `004-DEPLOYMENT_PROFILES.md` hosted mode
> Last updated: 2026-09-06

## Outcome

Tephra will safely serve many users from one application and shared infrastructure. Each user is
a Stage 1 personal tenant and can own multiple private vaults. Tenant separation applies to API
authorization, database queries, blob storage, indexing, jobs, quotas, garbage collection, and
observability.

The current SQLite/filesystem implementation remains supported for single-user installations.
The new PostgreSQL/S3-compatible implementation supplies shared, horizontally scalable state for
the hosted deployment.

## Current state

Useful foundations already exist:

- `vaults.owner_user_id` associates a vault with a user;
- vault list and most vault routes check ownership;
- plugin tokens bind `user_id`, `vault_id`, and scopes;
- database and blob-store interfaces separate infrastructure from API code;
- successful vault commits are transactional and revisions are serialized;
- PostgreSQL and S3 workspace packages already exist as empty placeholders.

Gaps that prevent safe hosted use:

- repositories expose unscoped `findById`/`listByVault` methods that are easy to call without an
  owner predicate;
- blob metadata and physical objects are keyed globally by hash;
- sync planning can reveal that another user already stored a matching hash;
- indexing and garbage collection accept vault/hash IDs without explicit tenant context;
- PostgreSQL, S3, hosted migrations, and cross-adapter contract suites do not exist;
- no database-level isolation protects against a missed application predicate;
- no per-user resource ceilings prevent one tenant exhausting shared storage.

## Tenant model

For Stage 1:

```text
tenant_id := authenticated user.id
one user -> many vaults
one vault -> one owner user
```

Do not add an organizations table. A later sharing/teams plan can introduce a separate tenant and
membership model with an explicit migration.

Establish tenant context from the authenticated principal:

```ts
interface TenantContext {
  ownerUserId: string;
  principalKind: 'session' | 'vault_token' | 'internal_job';
}
```

Client-supplied IDs select a resource only after the server verifies it belongs to this context.

## Scope

- Refactor persistence interfaces so tenant-owned operations require owner context.
- Namespace blob metadata and physical objects by user.
- Migrate existing SQLite/filesystem data without changing canonical bytes or revisions.
- Implement full PostgreSQL and S3-compatible adapters.
- Add PostgreSQL row-level security as defense in depth.
- Make indexing, jobs, garbage collection, and usage accounting tenant-aware.
- Add configurable per-user vault, file, and unique-byte limits.
- Add exhaustive two-user negative authorization and adapter parity tests.

## Non-goals

- Organizations, shared vaults, per-vault collaborators, or user-to-user transfers.
- Cross-user blob deduplication.
- Billing or plan-specific entitlements.
- Per-tenant database/schema/bucket provisioning.
- End-to-end encryption or per-tenant KMS keys.
- D1/R2, Vercel, or Cloudflare runtime adapters.
- Direct browser uploads to S3.
- Changing the Stage 1 sync protocol unless required to report a quota error.

## Security invariants

1. A vault, file, revision, blob hash, object key, token, or job ID is not authorization.
2. Tenant context comes from a verified session, verified vault token, or trusted internal job.
3. API code cannot obtain an unscoped tenant repository accidentally.
4. A plugin token remains restricted to one owner and one vault.
5. The same hash uploaded by two users creates two logical and physical tenant objects.
6. No response or meaningful status distinction reveals another tenant's blob existence.
7. Index rows, queued jobs, cache keys, usage rows, logs, and GC candidates retain owner context.
8. PostgreSQL request connections use a role subject to forced RLS; migrations use a separate
   role.
9. Pooled PostgreSQL connections never retain a previous request's tenant setting.
10. Blob writes remain immutable, size-checked, and server-verified with SHA-256.
11. Successful commits remain all-or-nothing and monotonically revisioned.
12. Deleting one user's vault or blobs cannot affect another user's data.

## Persistence contracts

### Tenant-scoped database access

Split global authentication repositories from tenant repositories:

```ts
interface Database {
  auth: AuthRepositories;
  forTenant<T>(
    ownerUserId: string,
    operation: (repositories: TenantRepositories) => Promise<T>,
  ): Promise<T>;
  transactionForTenant<T>(
    ownerUserId: string,
    operation: (repositories: TenantTransactionRepositories) => Promise<T>,
  ): Promise<T>;
  maintenance: MaintenanceRepositories;
}
```

Rules:

- `TenantRepositories` does not accept an owner ID from each caller; the adapter binds it when
  the scoped view/transaction is created.
- Vault lookup becomes owner-scoped and returns null for a foreign vault.
- File, revision, token, device, index, usage, and job methods operate only through the scoped
  repository.
- `MaintenanceRepositories` exposes only named operations needed by migrations, cleanup, and
  reconciliation. It is never injected into request handlers.
- Background job handlers reopen a tenant scope from the job's stored `owner_user_id`, then
  revalidate the referenced vault/resource.

### Tenant-scoped blobs

Change the BlobStore key:

```ts
interface BlobKey {
  namespace: string; // derived from ownerUserId, never email or vault name
  hash: string;
}
```

All `has`, `put`, `get`, and `delete` calls use `BlobKey`. The filesystem and S3 key layout is:

```text
users/<owner-user-uuid>/blobs/<hash[0..2]>/<hash[2..4]>/<hash>
```

The namespace builder validates UUID-like internal IDs and never accepts separators or raw user
input. S3 buckets are private; the application streams authenticated content rather than issuing
public object URLs.

### Quotas

Add global configuration defaults, overridable later by billing work:

```text
TEPHRA_MAX_VAULTS_PER_USER
TEPHRA_MAX_FILES_PER_VAULT
TEPHRA_MAX_UNIQUE_BLOB_BYTES_PER_USER
```

Track unique blob bytes within a user namespace. Check vault/file limits in the same transaction
as vault creation or sync commit. `sync/plan` creates bounded, expiring reservations for its
missing hashes; blob PUT requires a matching reservation in multi-user mode. Admission counts
current unique bytes plus active reservations, preventing concurrent orphan uploads from bypassing
the limit. Commit consumes reservations and updates usage; expiry and tenant-scoped GC remove
abandoned uploads.

Use a stable API error code such as `QUOTA_EXCEEDED`; do not overload auth/authorization errors.

## Schema and migrations

### Tenant blob schema

Replace the global blob primary key with:

```text
blobs(
  owner_user_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  mime_type TEXT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY(owner_user_id, hash)
)
```

`vault_files` and `file_versions` must reference the owner-qualified blob. Either add
`owner_user_id` to those tables with composite foreign keys, or use an equivalent schema that
makes a cross-owner reference impossible at the database level. The implementation must choose
the composite-key form unless an adapter limitation is documented in this plan before coding.

Add:

```text
user_usage(
  owner_user_id PRIMARY KEY,
  vault_count,
  unique_blob_count,
  unique_blob_bytes,
  updated_at
)

blob_upload_reservations(
  owner_user_id,
  vault_id,
  hash,
  size,
  expires_at,
  created_at,
  PRIMARY KEY(owner_user_id, vault_id, hash)
)
```

Quota admission counts distinct `(owner_user_id, hash)` values across active reservations so two
vaults owned by the same user do not reserve the same bytes twice. Blob PUT still requires the
reservation for the specific vault/token being used.

### SQLite migration

Do not edit migration 001. The next migration runs with the server stopped and:

1. creates owner-qualified tables;
2. derives the owner of every current/historical blob by joining files/versions to vaults;
3. copies each physical hash object into each owner's namespace;
4. verifies every copied object's size and SHA-256;
5. inserts owner-qualified rows and references;
6. verifies row counts, revision histories, manifests, and foreign keys;
7. atomically switches tables only after all verification succeeds.

Keep old global objects for one release as rollback data. Remove them only through a later,
explicit cleanup command. The migration performs a free-space preflight and is resumable or
clearly fails before schema cutover.

### PostgreSQL schema and RLS

Create `tephra-server/migrations/postgres/` with schema parity and a migration ledger. Use
separate deployed roles:

- migration owner role: schema changes only, never used by API/worker;
- application role: least privilege, not superuser, not table owner, no `BYPASSRLS`;
- worker role: same restrictions as the application role, plus execute permission only on named
  job-claim/maintenance functions;
- operator maintenance role: not available to serving processes and used only by documented
  reconciliation/migration commands.

Enable and force RLS on vaults, devices, tokens, blobs, files, revisions, versions, note metadata,
links, index state, usage, and tenant jobs. Policies compare direct `owner_user_id` or join through
an owner-scoped vault.

At the beginning of every tenant transaction, set `app.owner_user_id` transaction-locally. A
missing setting fails closed. Commit or rollback before returning the connection to the pool.
Never use session-scoped `SET` with pooled connections.

Cross-tenant job claiming must not give the worker a general RLS bypass. Expose a narrowly scoped
`SECURITY DEFINER` claim function that returns only claim metadata, fixes its `search_path`, and is
executable only by the worker role. After a claim, the worker opens a normal tenant transaction
for `owner_user_id` and revalidates the resource before doing work.

### PostgreSQL commit serialization

Preserve current sync semantics by locking the vault row in the tenant transaction before
reading its latest revision. Concurrent commits to one vault serialize; commits to different
vaults/users proceed independently. Manifest-hash idempotency remains owner/vault scoped.

## S3-compatible adapter

Implement `@tephra/blob-store-s3` with:

- the AWS SDK S3 client behind the BlobStore interface;
- endpoint, region, bucket, path-style, and workload-identity/static-credential configuration;
- private namespaced keys;
- bounded streaming reads and writes;
- server-side SHA-256 and byte-count verification before the object becomes committed metadata;
- conditional/idempotent immutable writes;
- safe delete and not-found behavior;
- no bucket listing on request paths;
- sanitized errors that never include credentials or signed request data.

For an initial implementation, stream to a temporary tenant key, verify, then promote/copy to the
immutable final key and remove the temporary key. Document platform limits. Multipart/direct
client upload is deferred.

## Tenant-aware derived work

- Change `IndexService.indexVault` to receive `{ ownerUserId, vaultId, revision }`.
- Every search, render, link, backlink, and graph lookup runs in a tenant scope.
- Job payloads include `owner_user_id`, validate a versioned schema, and recheck ownership.
- Metrics may include bounded internal owner/vault IDs only where cardinality is controlled; do
  not put emails, filenames, note titles, or contents in labels/logs.
- Blob GC selects candidates within one owner namespace and rechecks current and historical
  references in the deletion transaction.
- Add a reconciliation operation that recomputes `user_usage` from canonical database rows.

## Affected areas

- `tephra-server/packages/database/core/`: scoped/global/maintenance interfaces.
- `tephra-server/packages/database/sqlite/`: scoped implementation and migration.
- `tephra-server/packages/database/postgres/`: complete adapter, pool, migrations, RLS.
- `tephra-server/packages/blob-store/core/`: `BlobKey`/namespace-aware contract.
- `tephra-server/packages/blob-store/filesystem/`: namespaced layout and migration helper.
- `tephra-server/packages/blob-store/s3/`: complete S3-compatible adapter.
- `tephra-server/packages/vault-model/`: owner-qualified blob and usage types.
- `tephra-server/apps/api/`: tenant derivation, routes, sync, index, GC, quota checks.
- API/database/blob tests and hosted integration fixtures.
- threat model, server README, migration and recovery documentation.

Shared domain packages remain browser-safe. PostgreSQL, filesystem, and S3 APIs remain in Node
adapters and entrypoints.

## Implementation sequence

### Phase 1 — Authorization contract and negative matrix

1. Build reusable Alice/Bob fixtures, each with multiple vaults and plugin tokens.
2. Cover every vault route and service with owner, foreign-user, foreign-vault-token, revoked,
   and unknown-ID cases.
3. Refactor database interfaces into auth, tenant, and maintenance scopes.
4. Move handlers and index services to tenant-scoped access without changing storage layout.

Gate: no request handler imports or receives maintenance/unscoped repositories; the full existing
API suite passes.

### Phase 2 — Blob namespace and SQLite migration

1. Add `BlobKey` and update filesystem behavior.
2. Add owner-qualified blob schema and references.
3. Update plan/upload/commit/read/index/GC flows.
4. Implement the verified existing-data migration and rollback retention.
5. Add quota schema, checks, and reconciliation.

Gate: two users uploading the same hash have independent metadata and objects; deletion/GC of one
does not affect the other; upgraded single-user data is byte-identical and revision-identical.

### Phase 3 — PostgreSQL adapter and RLS

1. Implement migrations and all repository contracts.
2. Add transaction-local tenant context and forced RLS.
3. Implement vault row locking and outbox job claiming.
4. Add deployed-role assertions to readiness/startup.
5. Run the contract and concurrency suites against PostgreSQL.

Gate: wrong or missing tenant context fails at both repository and database-policy layers, and
pooled-connection reuse cannot leak prior tenant context.

### Phase 4 — S3 adapter and shared-state integration

1. Implement namespaced streaming object operations.
2. Exercise temporary upload, verification, promotion, idempotency, and cleanup.
3. Run complete sync/browse/index/GC tests with PostgreSQL plus S3-compatible test storage.
4. Run two API processes concurrently against the shared adapters.

Gate: hosted persistence passes clean-start, restart, concurrent commit, identical-hash,
cross-tenant, and failure-recovery tests.

## Tests and verification

The Alice/Bob matrix must include:

- vault list/create/get/delete;
- token list/create/revoke and token use against another vault;
- sync plan, blob upload, and commit;
- files, tree, search, metadata, raw content, attachment, rendered note;
- links, backlinks, graph, index state/job;
- identical hashes, quota accounting, GC, and deletion.

Adapter tests:

- run one database contract suite against SQLite and PostgreSQL;
- run one blob contract suite against filesystem and S3-compatible storage;
- migrate a schema-1 SQLite fixture with multiple vaults, revisions, indexes, and shared hashes;
- test PostgreSQL RLS with correct, wrong, and missing context and the real deployed app role;
- test pooled connection reuse, concurrent bootstrap/token consume/outbox claim/vault commit;
- inject failures before/after object write, metadata insert, commit, and GC delete.

Run:

```bash
npm test --workspace=@tephra/database-sqlite
npm test --workspace=@tephra/database-postgres
npm test --workspace=@tephra/blob-store-filesystem
npm test --workspace=@tephra/blob-store-s3
npm test --workspace=@tephra/api
npm run check
```

Also run the hosted integration compose suite with two API processes and the existing web/plugin
E2E sync flow.

## Rollout and rollback

- Land tenant-scoped repository APIs before enabling multi-user registration.
- The SQLite blob migration requires a backup, downtime, free-space preflight, and post-migration
  hash/revision verification.
- Use expand/migrate/verify/contract schema changes. Do not drop global blob tables/objects in the
  same release that switches readers.
- PostgreSQL migrations are backward-compatible across one rolling application release.
- If quota accounting drifts, close signup/upload admission conservatively and run reconciliation;
  do not delete canonical content.
- If S3 promotion fails, leave the database uncommitted and clean temporary objects later.
- Never roll back by pointing new schema code at old global objects without the documented
  compatibility reader or restoring the coordinated backup.

## Completion checklist

- [ ] Every tenant-owned API/service operation requires server-derived owner context.
- [ ] Request handlers cannot access maintenance repositories.
- [ ] Blobs are logically and physically namespaced by user.
- [ ] Existing SQLite/filesystem installations migrate without byte or revision changes.
- [ ] SQLite/filesystem behavior remains supported for single-user mode.
- [ ] PostgreSQL passes all database, transaction, migration, and RLS contracts.
- [ ] S3-compatible storage passes immutable streaming blob contracts.
- [ ] Indexing, jobs, quotas, GC, logs, and metrics preserve tenant context.
- [ ] The full Alice/Bob negative matrix passes on both persistence profiles.
- [ ] Multi-user signup remains closed until plan 004 deployment acceptance passes.
- [ ] `npm run check` passes.

## References

- `001-TEPHRA_STAGE1_PLAN.md`, sections 4, 7–9, 14–16, 27–30, 36, 37, and 56.
- `002-AUTHENTICATION_MODES.md` for authenticated identities and auth outbox behavior.
- [OWASP Multi-Tenant Security Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Multi_Tenant_Security_Cheat_Sheet.html)
- [PostgreSQL Row Security Policies](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
