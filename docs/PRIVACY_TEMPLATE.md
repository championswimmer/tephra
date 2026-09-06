# Privacy Notice Template for Tephra Operators

> Replace bracketed text before publishing. This template is operational guidance, not legal advice.

**Operator:** [name and contact]

This Tephra instance stores account identifiers, authentication records, device metadata, vault paths and metadata, Markdown content, attachments, and revision history supplied by authorized users and their Obsidian plugins. It processes this data only to synchronize and provide authenticated read-only web access to the selected vaults.

Data is stored in [hosting location/provider]. It is not sold or used for advertising. Infrastructure subprocessors are [list providers]. Server logs retain [describe request metadata and retention] and must not contain passwords, session values, upload tokens, or vault content.

Users may request access, export, or deletion by contacting [contact]. Deleting a remote vault does not delete the user's local Obsidian vault. Historical blobs may remain until the configured garbage-collection and backup-retention periods expire.

Security controls include HTTPS, password hashing, hashed plugin tokens at rest, vault-scoped authorization, content hash verification, and sanitized Markdown rendering. No internet service can be guaranteed perfectly secure; report concerns through [security reporting channel].

Last updated: [date].
