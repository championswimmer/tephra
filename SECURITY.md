# Security Policy

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability. Use GitHub's private vulnerability reporting for `championswimmer/tephra` and include reproduction steps, affected versions, and impact.

## Stage 1 security boundaries

Tephra Stage 1 is a read-only mirror: vault files can be uploaded by a vault-scoped plugin token and read by the owning authenticated user. The web application cannot write content back to an Obsidian vault.

Treat the server as sensitive infrastructure. Deploy it behind HTTPS, use a strong initial administrator password, protect plugin tokens, keep the data directory private, and back up the database and blob store together.

Only supported releases receive security fixes. Until a stable release is published, track the latest commit on `main`.
