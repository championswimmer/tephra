# Tephra

Tephra is a self-hostable, read-only web mirror for Obsidian vaults. The local vault remains the source of truth: the Tephra Sync plugin uploads complete, revisioned manifests and content-addressed blobs; the Tephra Server provides secure browser access to files, rendered notes, links, attachments, and a knowledge graph.

> Stage 1 is under active development. It intentionally provides no web editing or server-to-vault writeback.

## Repository

- [`tephra-server/`](tephra-server/) — API, web application, shared domain packages, and deployment assets.
- [`tephra-plugin/`](tephra-plugin/) — mobile-compatible Obsidian synchronization plugin.
- [Stage 1 implementation plan](.agents/plans/TEPHRA_STAGE1_PLAN.md)

## Development

Requirements: Node.js 22+ and npm 10+.

```bash
npm install
npm run check
npm run dev
```

See the product READMEs for configuration and usage.

## Security model

Vaults are private. Plugin credentials are scoped to one vault. Uploaded blobs are independently SHA-256 verified. Markdown is treated as untrusted input and sanitized before display.

## License

AGPL-3.0-or-later. See [LICENSE](LICENSE).
