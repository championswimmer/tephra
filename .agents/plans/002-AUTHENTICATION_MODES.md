# Tephra Authentication Modes

> Status: implementation plan
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`
> Followed by: `003-MULTI_TENANT_PERSISTENCE.md`, then `004-DEPLOYMENT_PROFILES.md`
> Last updated: 2026-09-06

## Outcome

Tephra will have one authentication implementation with two explicit operating modes:

| Mode          | Account creation                            | Intended operator                       |
| ------------- | ------------------------------------------- | --------------------------------------- |
| `single_user` | One-time bootstrap creates the only account | A person self-hosting Tephra            |
| `multi_user`  | Public registration with email verification | The operator of a hosted Tephra service |

Both modes use the same user IDs, browser sessions, vault ownership, and vault-scoped plugin
tokens. Authentication behavior changes by mode; the Stage 1 sync and read-only browser model
does not.

Multi-user registration must remain closed in production until the tenant-isolation work in
plan 003 and the hosted deployment gates in plan 004 are complete.

## Current state

The repository already has:

- a transactional first-user bootstrap protected by `TEPHRA_BOOTSTRAP_TOKEN`;
- scrypt password hashes;
- random opaque browser sessions stored by SHA-256 digest;
- secure, HTTP-only, same-site session cookies;
- a CSRF cookie and server-side CSRF check;
- login, logout, current-user, and bootstrap routes;
- vault-scoped plugin tokens stored by hash.

The missing or incomplete pieces are:

- no explicit instance mode;
- `TEPHRA_ALLOW_SIGNUPS` is documented but not implemented;
- no registration, email verification, password reset, password change, or session revocation;
- the web client sends `X-CSRF-Token`, while the API checks `X-Tephra-CSRF`;
- the CSRF value is not bound to its session;
- `TEPHRA_SESSION_SECRET` is documented but not used;
- no distributed rate limiting for public authentication endpoints;
- no email delivery abstraction or reliable delivery queue.

## Scope

- Add explicit, fail-closed auth modes and configuration validation.
- Complete the single-user setup, login, password change, logout-all, and operator recovery
  experience without requiring email.
- Add multi-user registration, email verification, resend, login, forgotten-password, and reset
  flows.
- Harden sessions, CSRF, password hashing, and public endpoint rate limits.
- Add the minimum database contracts and migrations required for auth lifecycle state.
- Add mode-aware web routes and forms.
- Add a provider-neutral email interface and a database outbox contract.

## Non-goals

- Organizations, team membership, shared vaults, invitations, or tenant switching.
- Social login, OIDC, SAML, passkeys, MFA, or account linking.
- Billing, subscriptions, plan entitlements, or a hosted operator dashboard.
- Support-agent impersonation or a global web administrator capable of reading vaults.
- Implementing PostgreSQL, S3, or deployment infrastructure; those belong to plans 003 and 004.
- Web editing, server-to-vault writes, or any other Stage 2 behavior.

## Decisions

### Instance mode

Add:

```text
TEPHRA_INSTANCE_MODE=single_user|multi_user
TEPHRA_SIGNUP_MODE=closed|open
TEPHRA_AUTH_TOKEN_ENCRYPTION_KEY=<32 random bytes; multi_user only>
TEPHRA_TRUSTED_PROXY_COUNT=<non-negative integer>
```

Rules:

- `TEPHRA_INSTANCE_MODE` defaults to `single_user` for existing installations.
- `TEPHRA_SIGNUP_MODE` defaults to `closed` in both modes.
- `open` is invalid with `single_user`.
- Bootstrap is available only in `single_user` and only while there are zero users.
- Registration is available only in `multi_user` with signup `open`.
- `multi_user` rejects `TEPHRA_BOOTSTRAP_TOKEN`.
- `multi_user` requires an independent auth-token encryption key so queued verification/reset
  messages never store plaintext bearer secrets.
- `TEPHRA_TRUSTED_PROXY_COUNT` defaults to `0`. Client IP resolution ignores forwarding headers
  unless the operator explicitly configures the number of trusted proxy hops.
- Store the initialized instance mode in the database and fail startup if the environment later
  disagrees. Conversion between modes is not an implicit configuration change.
- Existing databases migrate to `single_user`. A separate future conversion plan is required to
  turn an existing single-user database into a hosted service.

### User identity

An email/password account is the only identity type in this plan. Normalize email in one shared
function by trimming, Unicode-normalizing, and applying the chosen case policy consistently.
Do not apply provider-specific transformations such as removing dots or plus suffixes.

New multi-user accounts start `pending_verification`. Only `active` users may create sessions.
Single-user bootstrap creates an `active` user whose email is considered verified locally.

### Password storage

Keep scrypt and avoid introducing a native password library in this phase. Version the encoded
parameters and:

- accept the current `scrypt$16384$8$1$...` hashes;
- hash new passwords with `N=65536`, `r=8`, `p=2`, subject to a startup self-test on supported
  deployment sizes;
- rehash legacy parameters after a successful login;
- use a random 16-byte or larger salt;
- accept spaces and Unicode, never silently truncate, require at least 12 characters, and allow
  at least 128 characters;
- keep the dummy-hash path for unknown users to reduce timing-based enumeration.

If the selected parameters exceed the memory envelope of the documented minimum self-host
profile, benchmark once and update this plan with the measured parameter set before coding.

### Browser sessions and CSRF

Keep opaque, database-backed sessions. Do not introduce browser JWTs.

- Generate 32 random bytes for the session secret and store only an HMAC-SHA-256 digest using
  `TEPHRA_SESSION_SECRET`.
- Add a random CSRF secret per session and store its digest on the session row.
- Send the session in an HTTP-only cookie and the CSRF value in a readable same-site cookie.
- Standardize the request header as `X-Tephra-CSRF` in API and web code.
- Validate that the CSRF cookie, header, and current session row agree.
- Reject unsafe cookie-authenticated requests whose `Origin` does not match
  `TEPHRA_PUBLIC_URL`.
- Use `Secure`, `SameSite=Lax`, and `Path=/` in HTTPS deployments. Use the `__Host-` cookie
  prefix only where the secure-cookie rules are satisfied.
- Use a 30-day absolute expiry and a 7-day idle expiry. Update `last_seen_at` no more than once
  every five minutes.
- Password reset, account disablement, and logout-all revoke all sessions. Password change
  revokes all other sessions and rotates the current one.

Changing the session digest format invalidates existing browser sessions once. It must not
invalidate plugin tokens.

### Public auth tokens

Email verification and password-reset tokens are:

- at least 32 random bytes;
- returned only through the email delivery port;
- stored only by SHA-256 digest;
- purpose-bound, single-use, and consumed transactionally;
- valid for 24 hours for verification and 60 minutes for password reset.

Links are built from validated `TEPHRA_PUBLIC_URL`, never from the inbound Host header. After the
web app reads a token query parameter, it posts the value to the API and replaces browser history
with a token-free URL.

### Rate limiting and public responses

Use a database-backed rate-limit repository so limits work across replicas. Bucket by action and
keyed-HMAC fingerprints of normalized email and client IP; do not store raw emails or IPs in the
rate-limit table.

Derive a labeled rate-limit HMAC subkey from `TEPHRA_SESSION_SECRET`; do not reuse the raw session
lookup key directly. Session-secret rotation may reset rate-limit buckets, so rotate during a
controlled maintenance window while edge limits remain active.

Resolve client IP through an injected `ClientAddressResolver`. Starting from the transport peer,
it may walk `X-Forwarded-For` from right to left only through the configured number of trusted
proxy hops. Never trust the leftmost forwarded value merely because the header exists.

Apply limits to registration, login, verification resend/consume, and password reset
request/consume. Public registration, resend, and forgotten-password requests return the same
accepted response whether the address is present, absent, already verified, disabled, or
internally rate-limited. Login always uses the same generic invalid-credentials response.

### Email delivery

Add an infrastructure interface rather than calling SMTP from route handlers:

```ts
interface EmailSender {
  send(message: TransactionalEmail): Promise<void>;
}
```

Add a database outbox repository. Registration/reset transactions create account/token state and
an outbox item atomically. The token table stores only a digest; the short-lived raw token in the
queued message is encrypted with authenticated encryption using the independent
`TEPHRA_AUTH_TOKEN_ENCRYPTION_KEY`, a random nonce, and a key-version field. A processor claims,
decrypts, sends, removes the encrypted payload after success, retries with bounded exponential
backoff, and records only a safe error code. The SMTP and encryption implementations are
Node-only. No email dependency or auth-token encryption key is required in `single_user` mode.

## Public API changes

Replace `/auth/bootstrap/status` with one capabilities endpoint while retaining the old route for
one compatibility release:

```text
GET /api/v1/auth/config
```

Response:

```json
{
  "instanceMode": "single_user",
  "bootstrapRequired": true,
  "signupMode": "closed",
  "emailVerificationRequired": false
}
```

Routes:

```text
POST /api/v1/auth/bootstrap             single_user only
POST /api/v1/auth/register              multi_user + open signup only
POST /api/v1/auth/email/verify          multi_user only
POST /api/v1/auth/email/resend          multi_user only
POST /api/v1/auth/login
POST /api/v1/auth/logout
POST /api/v1/auth/logout-all
POST /api/v1/auth/password/forgot       multi_user only
POST /api/v1/auth/password/reset        multi_user only
POST /api/v1/auth/password/change       authenticated session
GET  /api/v1/auth/me                    authenticated session
```

Mode-disabled routes return 404. Invalid/replayed/expired one-time tokens return a generic 400.
Successful verification and reset do not automatically create a session.

## Schema and repository changes

Do not edit `migrations/sqlite/001_initial.sql`. Add the next numbered SQLite migration.

Extend `users`:

```text
normalized_email       TEXT NOT NULL UNIQUE
status                 TEXT NOT NULL  # pending_verification|active|disabled
email_verified_at      INTEGER NULL
password_changed_at    INTEGER NULL
```

Extend `sessions`:

```text
csrf_token_hash        TEXT NOT NULL
authenticated_at       INTEGER NOT NULL
last_seen_at           INTEGER NOT NULL
revoked_at             INTEGER NULL
```

Add:

```text
instance_settings(id, instance_mode, initialized_at)
auth_one_time_tokens(id, user_id, purpose, token_hash, expires_at, used_at, created_at)
auth_rate_limits(bucket_hash, action, window_started_at, attempt_count, blocked_until, expires_at)
auth_outbox(id, user_id, kind, encrypted_payload NULL, nonce NULL, key_version, status,
            attempts, available_at, locked_at, locked_by, last_error_code,
            created_at, updated_at)
```

Repository requirements:

- unique token hashes and normalized emails;
- consume-token operation must atomically mark a valid unused token as used;
- revoke all sessions by user ID;
- delete expired sessions/tokens/rate-limit buckets;
- claim outbox rows safely for one or more processors;
- never expose password hashes, token hashes, CSRF hashes, or outbox secrets in DTOs/logs.

## Affected areas

- `tephra-server/packages/vault-model/`: user/session/auth token types.
- `tephra-server/packages/auth/`: password policy, hash upgrades, session/token/cookie helpers.
- `tephra-server/packages/database/core/`: auth repositories and atomic operations.
- `tephra-server/packages/database/sqlite/`: migration and adapter behavior.
- `tephra-server/packages/email/core/` (new): provider-neutral interface and template inputs.
- `tephra-server/packages/email/smtp/` (new): Node-only SMTP adapter.
- `tephra-server/apps/api/src/config.ts` (new): strict environment parsing.
- `tephra-server/apps/api/src/app.ts`: mode-aware auth routes and middleware.
- `tephra-server/apps/api/src/main.ts`: mode-specific composition.
- `tephra-server/apps/web/src/app/`: auth state and route guards.
- `tephra-server/apps/web/src/routes/AuthPages.tsx`: registration/verification/recovery forms.
- `tephra-server/apps/web/src/api/`: API DTOs and CSRF header correction.
- `.env.example`, `tephra-server/.env.example`, server README, threat model.

## Implementation sequence

### Phase 1 — Freeze and harden existing behavior

1. Add regression tests for bootstrap races, login enumeration response, cookie attributes, and
   the current CSRF header mismatch.
2. Add strict config parsing and `/auth/config`.
3. Add mode gates while leaving `single_user` and signup `closed` as defaults.
4. Implement session-secret HMAC, session-bound CSRF, Origin validation, idle expiry, password
   change, and logout-all.
5. Add versioned scrypt verification and rehash-on-login.

Gate: existing self-host data and plugin tokens still work; existing browser sessions require one
fresh login; registration is still unreachable.

### Phase 2 — Complete single-user auth

1. Make bootstrap and instance-settings initialization one transaction.
2. Enforce a maximum of one user in the API and readiness validation.
3. Add an operator-only `tephra auth reset-single-user-password` command that prompts for the new
   password on a TTY/stdin, updates the only user, and revokes browser sessions without reopening
   bootstrap. Refuse a password passed as a normal command-line argument.
4. Update setup/login UI and self-host documentation.

Gate: a fresh and an upgraded SQLite installation each complete setup, login, password change,
logout-all, restart, and recovery tests without email.

### Phase 3 — Add dormant multi-user lifecycle

1. Add user status, normalized email, one-time token, rate-limit, and outbox schema/repositories.
2. Add email core/SMTP packages and escaped text/HTML templates.
3. Implement registration, verification, resend, forgot, and reset API behavior.
4. Add corresponding web routes and token-removal-from-history behavior.
5. Add cleanup and outbox processor contracts.

Gate: lifecycle and abuse tests pass in integration, but production signup remains closed until
plans 003 and 004 are complete.

## Tests and verification

- Unit: normalization, password limits, current/legacy scrypt, malformed hashes, HMAC session
  lookup, cookie attributes, CSRF binding, token purpose/expiry/replay, rate-limit windows, email
  escaping, and trusted public URL construction.
- API: wrong-mode endpoints, concurrent bootstrap, duplicate registration, generic responses,
  pending/disabled login, verification/resend, reset invalidation, logout-all, malicious Origin,
  CSRF mismatch, and plugin-token rejection on account routes.
- Database: fresh migration, upgrade from schema 1, unique normalized email, token consume race,
  multi-processor outbox claim, and cleanup.
- Web: setup-only routing, conditional registration link, verification, forgot/reset, error and
  loading states, history token removal, and CSRF header.

Run:

```bash
npm test --workspace=@tephra/auth
npm test --workspace=@tephra/database-sqlite
npm test --workspace=@tephra/api
npm test --workspace=@tephra/web
npm run check
```

## Rollout and rollback

- Ship mode parsing and session hardening first with `single_user` as the default.
- Announce the one-time browser logout caused by the new session digest/CSRF schema.
- Use additive schema changes. Do not drop old session fields until a later release.
- Keep `/auth/bootstrap/status` for one release, then remove it after the web client migrates.
- If hosted auth has a problem, set signup to `closed`; existing login, sync, and browse remain
  available.
- Rotating `TEPHRA_SESSION_SECRET` intentionally logs out all browsers and must be documented.
- Never use the bootstrap token as a session/email/token secret.

## Completion checklist

- [ ] Instance mode and signup mode are explicit and fail closed.
- [ ] Single-user bootstrap can create exactly one active account.
- [ ] Self-host password recovery works without email or reopening bootstrap.
- [ ] Multi-user registration requires email verification.
- [ ] Password reset and logout-all revoke the intended sessions.
- [ ] CSRF cookie/header/session and Origin validation are consistent.
- [ ] Public auth endpoints are database-rate-limited and enumeration-resistant.
- [ ] Outbox delivery is transactional, retryable, and secret-free in logs.
- [ ] Plugin token behavior and all Stage 1 read-only invariants remain unchanged.
- [ ] Production signup is still closed pending plans 003 and 004.
- [ ] `npm run check` passes.

## References

- `001-TEPHRA_STAGE1_PLAN.md`, sections 23, 24, 28, 36, and 37.
- [OWASP Authentication Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html)
- [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
- [OWASP Session Management Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html)
- [OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
