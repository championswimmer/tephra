# Security Policy

## Reporting a vulnerability

Please do not open a public issue for an undisclosed vulnerability. Use GitHub's private vulnerability reporting for `championswimmer/tephra` and include reproduction steps, affected versions, and impact.

## Stage 1 security boundaries

Tephra Stage 1 syncs vaults both ways: the Obsidian plugin uploads files with a vault-scoped token, and the owning authenticated user can read and edit notes in the web application or through a scoped MCP agent token. Web edits are stored as new vault revisions and are applied to the local Obsidian vault by the plugin on its next pull; the web application never touches the vault files on your device directly.

Treat the server as sensitive infrastructure. Deploy it behind HTTPS, use a strong initial administrator password, protect plugin tokens, keep the data directory private, and back up the database and blob store together.

Only supported releases receive security fixes. Until a stable release is published, track the latest commit on `main`.
