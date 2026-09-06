# Stage 1 Threat Model

## Assets

- Administrator credentials and browser sessions
- Vault-scoped plugin tokens
- Private Markdown, attachments, metadata, and revision history
- SQLite database and content-addressed blob directory

## Trust boundaries

The Obsidian plugin reads a local vault and crosses the network boundary to the API. Browsers cross the network boundary using an authenticated session. The API is the only component allowed to reach persistence adapters. Markdown and attachments are untrusted user content even when uploaded by an authenticated plugin.

## Principal threats and controls

| Threat | Stage 1 controls |
| --- | --- |
| Credential theft | Password hashing, opaque token hashes at rest, secure HttpOnly cookies, masked plugin settings |
| Cross-vault access | Owner checks on browser routes and vault-scoped token checks on upload routes |
| Malicious upload path | Canonical relative-path validation; no client path is joined directly to a server filesystem path |
| Blob substitution/corruption | Server recomputes SHA-256 and validates size before atomic storage/metadata writes |
| Partial or replayed sync | Complete canonical manifests, transactional commit, missing-blob rejection, manifest-hash idempotency |
| XSS in Markdown | Raw HTML disabled and rendered output sanitized; unsafe URL schemes rejected |
| Attachment script execution | Safe content disposition/type policy and no active SVG/HTML embedding |
| CSRF/session abuse | SameSite cookies, restrictive CORS, state-changing methods, origin checks in deployments |
| Denial of service | Request/body/file-count limits, bounded upload concurrency, pagination, rate limiting |
| Data loss | Local vault remains canonical; database and blob directory backed up as one unit |
| Secret leakage | Secret-free logs/config examples and tokens returned only once at creation |

## Explicit non-goals

Stage 1 does not provide end-to-end encryption, untrusted multi-tenant execution, third-party Obsidian plugin execution, public publishing, web editing, or server-to-vault synchronization.

## Deployment assumptions

Operators terminate HTTPS, restrict access to persistent storage, rotate exposed tokens, apply updates, and back up SQLite plus blobs consistently. Reverse proxies must preserve secure cookie and request-size policies.
