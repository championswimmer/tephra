# Contributing to Tephra

Read [`AGENTS.md`](AGENTS.md) and the active numbered plan under [`.agents/plans/`](.agents/plans/) before changing code. Large features and refactors require a numbered written plan (`NNN-SLUG.md`) in that directory first.

## Setup

```bash
nvm use
npm ci
npm run check      # web app + plugin
npm run go:check   # Go server (tephra-server/go)
```

The server is written in Go (`tephra-server/go`); the web app and plugin use strict TypeScript. Preserve package boundaries and add tests for behavior changes. Shared TypeScript packages (`protocol`, `graph-renderer`, `markdown-editor`) must remain browser-safe. Never introduce web-to-vault writes into Stage 1.

## Pull requests

- Keep each pull request focused and explain the user-visible outcome.
- Document API, schema, migration, and environment-variable changes.
- Include regression tests for security or data-integrity fixes.
- Confirm `npm run check` and `npm run go:check` pass (whichever apply to your change).
- Do not commit credentials, `.env` files, databases, or generated plugin bundles.
