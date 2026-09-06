# Markdown, Link Resolution, and Indexing Progress

## Completed

- `@tephra/markdown`: typed frontmatter, headings, tags, block IDs, code-aware wiki/Markdown links and embeds, sanitized HTML, routing tokens, and attachment handling.
- `@tephra/link-resolver`: deterministic exact/relative/basename resolution, URL decoding, heading/block subpaths, ambiguity/unresolved states, and attachment detection.
- `@tephra/indexer`: note metadata/link row generation, resolution-change reindex planning, and graph node/edge aggregation.

## Verification reported by implementation agent

- 13 Vitest tests passed.
- Strict source typecheck passed.
- `git diff --check` passed.
- No `node:` imports were found.
- Root check was not run in isolation because dependency installation was prohibited.

## Integration assumptions

All three packages are browser-safe and expose their entrypoints from `src/index.ts`. The API/index service should parse current Markdown blobs, resolve against the complete current-file snapshot, replace note metadata/link rows for the committed revision, and use the renderer output as the only HTML sent to the web application.

## Risks and next steps

1. Install folded dependencies and run package/root checks.
2. Connect the packages to the API `IndexService`; no durable commit should be rolled back because indexing fails.
3. Validate API HTML link attributes against the web client's routing assumptions.
4. Exercise duplicate basenames, Unicode/encoded paths, unsafe schemes/raw HTML, embeds, and reindexing against the fixture vault.
5. Add a retry/status path for indexing lag and larger-vault performance coverage.
