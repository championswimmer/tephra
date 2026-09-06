# Stage 1 API and Authentication Progress

## Scope completed

This work implements the Stage 1 API and authentication packages without changing root configuration, the lockfile, shared contracts, database adapters, blob-store adapters, markdown/indexer packages, web, or plugin code.

### Files added or updated

- `tephra-server/packages/auth/package.json`
- `tephra-server/packages/auth/src/index.ts`
- `tephra-server/packages/auth/tests/auth.test.ts`
- `tephra-server/apps/api/package.json`
- `tephra-server/apps/api/src/app.ts`
- `tephra-server/apps/api/src/index.ts`
- `tephra-server/apps/api/src/entrypoints/node.ts`
- `tephra-server/apps/api/tests/app.test.ts`

### Authentication features

- Node-side `ScryptPasswordHasher` with random salts and fixed, encoded scrypt parameters.
- Random opaque session and API token generation.
- SHA-256 token hashing so repositories store token hashes rather than raw bearer/session secrets.
- Timing-safe secret comparison using fixed-length SHA-256 digests.
- Secure-by-default, `HttpOnly`, `SameSite=Lax` session cookie creation and cookie clearing helpers.
- Cookie parsing, active-token checks, and vault ownership/scope authorization helpers.
- One-time first-admin bootstrap protected by the configured bootstrap token and a database transaction.
- Login with user-enumeration timing mitigation, hashed session identifiers, expiration, and CSRF token issuance.
- Logout, current-user lookup, and CSRF validation for browser-session mutations.

### API features

- Exported in-memory-testable `createApp(dependencies)` Hono application factory.
- Exported `startServer(dependencies, options)` Node transport seam; concrete adapter construction is deliberately external.
- Liveness and readiness routes.
- Bootstrap status/bootstrap, login, logout, and current-user routes.
- Vault create/list/get/delete routes with explicit delete confirmation.
- Vault-scoped upload token create/list/revoke routes; raw token values are returned only at creation.
- Vault ownership and bearer-token scope enforcement on all vault routes, including prevention of same-owner cross-vault token use.
- Zod JSON/body validation, bounded JSON bodies, bounded blob uploads, and uniform `{ error: { code, message } }` responses.
- Sync planning with canonical manifest/hash validation and missing-blob detection.
- Blob PUT with declared-size validation, SHA-256 recomputation, mismatch rejection before metadata insertion, and idempotent existing-blob handling.
- Transactional sync commit with vault locking, in-transaction token authorization, blob presence/size checks, manifest-hash idempotency, stable-`fileId` diffing, revision insertion, version events, current snapshot replacement, and revision advancement only on success.
- File listing/tree metadata, metadata lookup, bounded search, raw/content and attachment streaming, optional Markdown rendering, links, backlinks, aggregate links, and graph routes.
- Content hardening with `nosniff`, sandbox CSP, and forced download for active HTML/XHTML/SVG content.
- Optional post-commit index-service notification.

## Public APIs and dependency expectations

### `@tephra/auth`

Exports:

- `ScryptPasswordHasher`
- `createOpaqueToken(prefix?)`
- `hashOpaqueToken(token)`
- `constantTimeSecretEqual(left, right)`
- `parseCookies(header)`
- `sessionCookie(token, options?)`
- `clearSessionCookie(options?)`
- `tokenIsActive(token, now)`
- `canAccessVault(principal, vault, requiredScope?)`
- `AuthPrincipal` and `SessionCookieOptions` types

The package expects Node.js crypto and the existing `@tephra/core` and `@tephra/vault-model` contracts.

### `@tephra/api`

Exports:

- `createApp(dependencies)`
- `startServer(dependencies, options?)`
- `ApiDependencies`, `IndexService`, and `NodeServerOptions` types

`ApiDependencies` requires:

- `database: Database`
- `blobStore: BlobStore`
- `clock: Clock`
- `ids: IdGenerator`
- `passwordHasher: PasswordHasher`

Optional dependencies/configuration are `bootstrapToken`, `indexService`, `secureCookies`, `sessionCookieName`, and `maxBlobBytes`.

The API package expects installed workspace/runtime dependencies for Hono, `@hono/node-server`, Zod, the Tephra contracts/packages, and Node type declarations. Deployment code must construct concrete database/blob-store adapters and pass them to `startServer`; no adapter APIs were invented here.

The optional index service may implement:

- `indexVault(vaultId, revision)`
- `renderMarkdown({ vaultId, fileId, markdown })`
- `search({ vaultId, query, limit })`

## Tests and checks actually run

- `npx tsc -p tephra-server/packages/auth/tsconfig.json --noEmit`
  - **Result:** failed because this isolated worktree has no installed Node type declarations/modules (`node:crypto`, `Buffer`, and related types could not be resolved).
- `npx tsc -p tephra-server/apps/api/tsconfig.json --noEmit`
  - **Result:** failed because this isolated worktree has no installed Hono, Zod, Node, or workspace module declarations. Cascading unresolved-module/type errors were therefore not treated as implementation validation.
- `git diff --check`
  - **Result:** passed.
- Vitest suites were authored but **not run**, because dependencies are not installed and the task explicitly prohibited running `npm install`.

The API fake-backed tests cover bootstrap/login behavior, one-time bootstrap, cross-vault token isolation, bad upload hashes, missing-blob rollback, successful revision advancement, manifest-hash idempotency, file listing, and raw content reads. Auth tests cover salted scrypt hashing/verification, malformed/wrong-password rejection, opaque-token hashing, timing-safe equality behavior, and cookie security attributes.

## Known gaps and integration risks

- Typechecking and tests remain unverified with real installed dependencies. Interface or library-version mismatches may surface after dependency installation.
- No concrete database/blob-store composition entrypoint exists yet; deployment must provide adapters through the documented seam.
- Blob PUT validates correctly but currently buffers the bounded request body before writing it; large-blob memory behavior should be reviewed during adapter integration.
- Indexing is optional and post-commit indexing failures are intentionally swallowed so a durable commit is not rolled back. Operational retry/status handling belongs in the index integration.
- When no index service is supplied, search is a bounded path-only fallback and Markdown rendering returns `INDEX_PENDING`/service unavailable.
- Link, backlink, and graph freshness depends on the separate note-indexing pipeline populating `NoteIndexRepository`.
- CSRF-protected browser clients must preserve the `tephra_csrf` cookie and send the returned token in `X-Tephra-CSRF` for state-changing requests.
- Readiness currently verifies database access only; blob-store writability is not probed.
- Package manifests were changed without a lockfile update, as required. The repository owner must update/install dependencies in the integration worktree.

## Exact next steps

1. Fold this commit into the integration worktree.
2. From the integration worktree, install workspace dependencies and update the lockfile using the repository-standard npm workflow.
3. Run:
   - `npm run typecheck --workspace @tephra/auth`
   - `npm run typecheck --workspace @tephra/api`
   - `npm test --workspace @tephra/auth`
   - `npm test --workspace @tephra/api`
4. Fix only concrete compile/test failures caused by actual package interfaces or installed library versions; preserve the dependency-injection and route behavior described above.
5. Run the repository-level `npm run check` after the other Stage 1 packages and adapters are folded together.
6. Wire concrete `Database`, `BlobStore`, `Clock`, `IdGenerator`, and `PasswordHasher` instances into `startServer` in the deployment composition root.
7. Exercise bootstrap, cookie/CSRF login, token issuance, blob upload, commit, and read routes against a concrete adapter stack.
8. Integrate the Markdown/index service, verify indexing retry/lag behavior, and validate search/link/backlink/graph results against a representative vault.
9. Confirm production settings use secure cookies, a strong bootstrap token, TLS, request-size limits at the proxy, and secret-redacting logs.
