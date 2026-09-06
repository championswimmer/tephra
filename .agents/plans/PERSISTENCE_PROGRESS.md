# Persistence Progress and Handoff

## Completed

- `tephra-server/packages/database/sqlite/**`: Node 22 `node:sqlite` implementation of all database-core repositories, schema migration, serialized transactions, JSON validation, constraints, and rollback behavior.
- `tephra-server/migrations/sqlite/001_initial.sql`: Stage 1 users, sessions, vaults, devices, tokens, blobs, revisions, versions, current files, note metadata, links, indexes, and foreign keys.
- `tephra-server/packages/blob-store/filesystem/**`: validated SHA-256 sharding, stream writes, size/hash checks, atomic rename, idempotency, reads/deletes, and failed-write cleanup.

## Verification reported by implementation agent

- Strict TypeScript typecheck passed for both packages.
- Vitest: 10 tests passed.
- `git diff --check` passed.
- Root check was not run in isolation because dependency installation was prohibited.

## Public integration points

- Consume the `Database` contract from `@tephra/database-core` through the SQLite factory exported by `@tephra/database-sqlite`.
- Consume `BlobStore` through the filesystem implementation exported by `@tephra/blob-store-filesystem`.
- The adapter requires Node 22 because it uses `node:sqlite`.

## Risks and next steps

1. Install folded workspace dependencies and run package and root checks.
2. Wire both concrete adapters into the API composition root and exercise reopen/rollback behavior end to end.
3. Verify migration location/copying in production builds and Docker.
4. Add operational backup/restore and concurrent commit smoke tests.
5. Review garbage-collection behavior before enabling blob deletion; Stage 1 should favor safety over eager cleanup.
