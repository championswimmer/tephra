# Contributing to Tephra

Read [`AGENTS.md`](AGENTS.md) and the active plan under [`.agents/plans/`](.agents/plans/) before changing code. Large features and refactors require a written plan in that directory first.

## Setup

```bash
nvm use
npm ci
npm run check
```

Use strict TypeScript, preserve package boundaries, and add tests for behavior changes. Shared parsing, protocol, and model packages must remain browser-safe. Never introduce web-to-vault writes into Stage 1.

## Pull requests

- Keep each pull request focused and explain the user-visible outcome.
- Document API, schema, migration, and environment-variable changes.
- Include regression tests for security or data-integrity fixes.
- Confirm `npm run check` passes.
- Do not commit credentials, `.env` files, databases, or generated plugin bundles.
