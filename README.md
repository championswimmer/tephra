# Tephra

Tephra is a stripped-down, web-based Obsidian client that you host yourself. It keeps your local Obsidian vault as the source of truth, syncs it to a Tephra server, and lets you open that vault from any browser as if a lightweight copy of Obsidian were running on your own infrastructure.

Today, that means a private Stage 1 web mirror for your notes, links, attachments, and graph. In the future, Tephra aims to grow into a fuller cloud-hosted Obsidian companion with browser editing, two-way sync, a safe subset of community plugin support, and optional publishing controls.

Tephra is built for portable single-user deployments: run your vault on your own domain in one container or VM, whether that is an EC2 instance, a Railway deployment, or a similar box you control.

> Stage 1 is under active development. It intentionally provides no web editing or server-to-vault writeback.

## What Tephra does

- Mirrors your whole Obsidian vault into a private web app you can reach from anywhere.
- Preserves Obsidian-style reading features like rendered Markdown, wikilinks, backlinks, attachments, and graph navigation.
- Lets the Obsidian plugin on desktop or mobile keep the hosted view current.
- Stays self-hosted and private: your domain, your login, your storage.

## Where Tephra is headed

- Browser-based note editing for quick fixes away from your main machine.
- Two-way sync so web edits can flow safely back to your vault.
- A browser-safe subset of community plugin support.
- Optional publishing flows for chosen parts of a vault.

## Repository

- [`tephra-server/`](tephra-server/) — API, web application, shared domain packages, and deployment assets.
- [`tephra-plugin/`](tephra-plugin/) — mobile-compatible Obsidian synchronization plugin.
- [Stage 1 implementation plan](.agents/plans/001-TEPHRA_STAGE1_PLAN.md)

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
