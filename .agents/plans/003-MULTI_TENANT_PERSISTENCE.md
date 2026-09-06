# Tephra Multi-Tenant Persistence and Isolation (disk-only)

> Status: implementation plan
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`; auth identities from `002-AUTHENTICATION_MODES.md`
> Required before: enabling multi-user signup or executing `004-DEPLOYMENT_PROFILES.md` hosted mode
> Supersedes: all PostgreSQL/S3/RLS content previously in this file (dropped 2026-09-06; see doctrine below)
> Last updated: 2026-09-06

## Outcome

Tephra serves many users through **one VM + one disk per tenant**, never through
shared database or object infrastructure. Each tenant is a full single-tenant
Tephra instance (own container, own volume, own SQLite file) holding that
tenant's vaults in **separate per-vault folders on the one volume mount**.

Tenant separation is therefore a **deployment boundary** (OS process + volume
mount), with the existing application-level owner checks kept as
defense in depth inside an instance.

## Storage doctrine (canonical, replaces all S3/Postgres plans)

- **Live stores are disk-only, always:** SQLite + filesystem blobs. There is no
  PostgreSQL adapter, no S3/R2/D1 live adapter, and no serverless runtime target.
  `TEPHRA_DATABASE_DRIVER`/`TEPHRA_BLOB_DRIVER` remain fail-closed pins
  (`sqlite`/`filesystem`; anything else refuses to start, as today in
  `apps/api/src/main.ts:19-24`).
- **One volume per tenant.** Same user, many vaults: one mount, separate
  per-vault folders (see layout). Many tenants: many VMs, many disks — never
  one shared database or bucket.
- **Object storage is backup-only:** periodic whole-vault snapshots (tarballs)
  may be copied to a private bucket by an external uploader. Snapshots never
  serve live reads/writes. See `005-STORAGE_ENGINES.md`.
- **Why:** the headless Obsidian Sync sidecar (plan 006) needs a real local
  checkout on a POSIX filesystem next to the server. Disk-only keeps Sync,
  server, bridge, and backup on one machine with one failure domain.

## Data layout on the volume

```text
/data/
  tephra.db                 # single SQLite for this tenant/instance (all its vaults)
  blobs/…                   # global content-addressed store (existing sharded layout, unchanged)
  checkouts/<vault-id>/     # headless Obsidian Sync working copy per vault (plan 006; reserved)
  sync-state/               # `ob` CLI device identity (plan 006; reserved)
  snapshots/                # local snapshot staging before upload (see 005-STORAGE_ENGINES.md)
```

No database migration is required for this layout: the existing schema and
blob layout are unchanged. `checkouts/`, `sync-state/`, and `snapshots/` are
new top-level directories created on demand; the server ignores them.

## Tenant model

For Stage 1:

```text
tenant := one deployed instance (one VM/container + one volume + one tephra.db)
one tenant -> one user (single_user) or a future small tenant set
one user -> many vaults (per-vault folders on the tenant volume)
one vault -> one owner user (existing vaults.owner_user_id)
```

Do not add an organizations table. A later sharing/teams plan can introduce a
separate membership model with an explicit migration.

Application-level rules (keep, SQLite-enforced):

- Tenant context is derived from the verified session, verified vault token,
  or trusted internal job — never from client-supplied IDs alone.
- Keep the repository split from the previous revision of this plan
  (`auth` vs tenant-scoped vs maintenance repositories) so request handlers
  cannot accidentally use unscoped access. Implement it on SQLite only.
- A plugin token remains restricted to one owner and one vault.
- Blob writes remain immutable, size-checked, server SHA-256-verified.
- Successful commits remain all-or-nothing and monotonically revisioned.
- Quotas are disk quotas: `TEPHRA_MAX_VAULTS_PER_USER`,
  `TEPHRA_MAX_FILES_PER_VAULT`, `TEPHRA_MAX_UNIQUE_BLOB_BYTES_PER_USER`
  (unique bytes within this instance). Stable `QUOTA_EXCEEDED` error code;
  never overload auth errors.

## Scope

- Harden SQLite/owner checks and tenant-scoped repositories (SQLite only).
- Add disk quota admission + `user_usage` reconciliation (SQLite tables only).
- Implement per-vault folder conventions for checkouts and snapshot staging.
- Document the one-VM-one-disk-per-tenant hosting rule and its backup/restore.
- Exhaustive two-user negative authorization tests on the single-instance model.

## Non-goals

- PostgreSQL, RLS, connection pooling, hosted migrations, cross-adapter suites.
- S3/R2/D1 or any live object-store adapter; presigned/direct uploads.
- Organizations, shared vaults, collaborators, user-to-user transfers.
- Cross-user blob deduplication (moot: tenants do not share disks).
- Per-tenant KMS keys or application-layer blob encryption (snapshots rely on
  provider-side bucket encryption + transport TLS; see 005).
- Vercel/Cloudflare/serverless runtimes (deleted; no persistent disk).
- Billing or plan entitlements.
- Changing the Stage 1 sync protocol except to report `QUOTA_EXCEEDED`.

## Schema and migrations

SQLite only, additive migrations under `tephra-server/migrations/sqlite/`
(never edit a released migration):

- Keep the current global blob table/keying (deduplication within a tenant
  disk is safe and intended).
- Add `user_usage(owner_user_id, vault_count, unique_blob_count,
  unique_blob_bytes, updated_at)` plus a reconciliation operation recomputed
  from canonical rows.
- Quota admission counts current usage; `sync/plan` over-limit fails with
  `QUOTA_EXCEEDED` before any blob write.

No Postgres schema, no RLS policies, no roles, no `migrations/postgres/`.

## Tenant-aware derived work

- `IndexService.indexVault` receives `{ ownerUserId, vaultId, revision }`.
- Every search/render/link/backlink/graph lookup runs in a tenant scope.
- Job payloads include `owner_user_id`, validate a versioned schema, recheck ownership.
- Blob GC selects candidates and rechecks current + historical references in
  the deletion transaction (single-disk, no batch-delete API needed).
- Logs/metrics never carry emails, filenames, titles, or contents.

## Affected areas

- `tephra-server/packages/database/core/`: scoped/global/maintenance interfaces (SQLite only).
- `tephra-server/packages/database/sqlite/`: scoped implementation, quota schema.
- `tephra-server/packages/blob-store/filesystem/`: per-vault checkout/snapshot
  folder helpers (live blob layout unchanged).
- `tephra-server/packages/vault-model/`: usage/quota types.
- `tephra-server/apps/api/`: tenant derivation, quota checks, GC scoping.
- API/database/blob tests; threat model, server README, recovery docs.
- `tephra-server/deploy/{docker,railway,aws,gcp}/`: one-volume-per-tenant examples.

Deleted and out of scope: `packages/database/postgres/`,
`packages/database/d1/`, `packages/blob-store/s3/`,
`packages/blob-store/r2/`, `deploy/vercel/`, `deploy/cloudflare/`.

Shared domain packages remain browser-safe. Filesystem APIs stay in Node
adapters and entrypoints.

## Implementation sequence

### Phase 1 — Authorization contract and negative matrix (SQLite)

1. Build reusable Alice/Bob fixtures, each with multiple vaults and tokens.
2. Cover every vault route/service with owner, foreign-user,
   foreign-vault-token, revoked, and unknown-ID cases.
3. Refactor database interfaces into auth, tenant, and maintenance scopes.
4. Move handlers/index services to tenant-scoped access without storage changes.

Gate: no request handler imports maintenance/unscoped repositories; full
existing API suite passes.

### Phase 2 — Disk quotas and per-vault folders

1. Add `user_usage` schema, admission checks, reconciliation command.
2. Add checkout/snapshot folder conventions + server-ignores-them tests.
3. Single-user upgrade path verified byte- and revision-identical.

Gate: over-quota plan fails cleanly; usage drift reconciles; existing data untouched.

### Phase 3 — One-VM-per-tenant hosting acceptance

1. Provision two independent instances (two volumes, two DBs) per 004.
2. Prove identical content on both, zero cross-access (network boundary, not
   just app predicates), independent backup/restore.
3. Document tenant provisioning/deprovisioning (create VM+disk; delete both).

Gate: tenants share nothing; deleting one tenant's disk cannot affect another.

## Tests and verification

Alice/Bob matrix (single instance): vault list/create/get/delete; token
list/create/revoke and cross-vault use; sync plan/blob/commit; files, tree,
search, metadata, raw, attachment, rendered; links, backlinks, graph, index;
quota accounting, GC, deletion.

```bash
npm test --workspace=@tephra/database-sqlite
npm test --workspace=@tephra/blob-store-filesystem
npm test --workspace=@tephra/api
npm run check
```

Plus the two-instance no-shared-state acceptance in §Phase 3.

## Rollout and rollback

- Land scoped repositories before any multi-user registration work.
- Quota tables are additive; rollback is code-only while signup stays closed.
- If usage accounting drifts, close admission conservatively and reconcile;
  never delete canonical content.
- Tenant deprovisioning (disk deletion) is irreversible: require a verified
  snapshot in object storage first (see 005).

## Completion checklist

- [ ] Every tenant-owned operation requires server-derived owner context.
- [ ] Request handlers cannot access maintenance repositories.
- [ ] Disk quotas enforced with `QUOTA_EXCEEDED`; reconciliation passes.
- [ ] Per-vault checkout/snapshot folders reserved; server ignores them.
- [ ] One-VM-one-disk-per-tenant proven with two independent instances.
- [ ] No Postgres/S3/serverless code, config, or docs remain in live paths.
- [ ] Multi-user signup remains closed until plan 004 hosting acceptance passes.
- [ ] `npm run check` passes.

## References

- `001-TEPHRA_STAGE1_PLAN.md` (read-only mirror, blob/revision invariants).
- `002-AUTHENTICATION_MODES.md` for authenticated identities.
- `004-DEPLOYMENT_PROFILES.md` for the one-volume-per-tenant rule.
- `005-STORAGE_ENGINES.md` for the disk engine + snapshot backup design.
- `006-HEADLESS_OBSIDIAN_SYNC.md` for checkout/sync-state folder consumers.
