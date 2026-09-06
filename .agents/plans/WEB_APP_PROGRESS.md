# Tephra Stage 1 Web App Progress

## Completed

- Added a package-local Vite, React, and TypeScript SPA under `tephra-server/apps/web`.
- Added browser routing and session guards for login, one-time administrator bootstrap, vault listing, settings, and deep-linkable `/v/:vaultId/*` workspace views.
- Added a cookie-credentialed API client with structured `ApiError` handling, network-error handling, URL encoding, text/JSON response handling, and CSRF header support.
- Added vault creation and a responsive, searchable, collapsible file tree built from flat API results.
- Added read-only Markdown viewing using server-rendered HTML, a defensive containment pass that removes executable elements/event handlers, internal-link interception, unresolved-link feedback, index-pending feedback, and a raw-source toggle.
- Added links/backlinks, safe image/PDF/attachment viewing, a lightweight interactive SVG graph, upload-token creation/revocation with display-once secret handling, settings, and logout.
- Added accessible loading, error, retry, empty, indexing, focus, mobile navigation, and read-only states.
- Added Vitest and Testing Library tests for unauthenticated deep-link redirect, file-tree search, rendered-note loading/content state, and token display-once behavior.

## Tests and results

- `prettier --check 'tephra-server/apps/web/**/*.{ts,tsx,css,json,html}' tephra-server/apps/web/vite.config.ts` — passed.
- `git diff --check` — passed.
- `tsc -p tephra-server/apps/web/tsconfig.json --noEmit` — not runnable to completion because this isolated worktree has no `node_modules`; it reported missing Vite/Vitest/Testing Library type packages.
- Vitest/build/lint — not run because dependencies are not installed and the task explicitly prohibited `npm install`.

## API assumptions

- API base path is `/api/v1`, and browser authentication uses cookies accepted via `credentials: 'include'`.
- `GET /auth/me` returns `{ user }`; bootstrap-required is reported as error code `BOOTSTRAP_REQUIRED` or HTTP 503.
- CSRF is exposed in a readable `tephra_csrf` cookie and accepted as `X-CSRF-Token` for state-changing requests.
- Vault endpoints return `{ vault }` or `{ vaults }`; file listing returns `{ revision, files, indexPending? }`.
- Rendered-note responses return `{ html, title?, indexPending? }`; the raw content endpoint returns text.
- Sanitized internal links may use `data-file-id`, `data-tephra-file-id`, or `/file/:fileId`; unresolved links may use `data-unresolved-target` or `data-tephra-unresolved`.
- `GET /vaults/:vaultId/links?fileId=...` returns `{ links, backlinks?, indexPending? }`.
- Token list returns `{ tokens }`; token creation returns token metadata plus a one-time `token` string.
- Timestamps used in web response types are epoch milliseconds.

## Known gaps and integration risks

- API implementation was outside this task and unavailable in this worktree, so response names, bootstrap detection, CSRF cookie/header names, timestamps, and internal-link attributes require contract verification.
- The host serving the production bundle must provide SPA fallback to `index.html` for direct `/v/:vaultId/*` refreshes.
- The SVG graph intentionally provides a basic layout and interaction rather than large-graph pan/zoom; very large vaults may need virtualization or a graph library later.
- Links/backlinks are hidden at narrow mobile widths to preserve note readability and should eventually receive a mobile drawer.
- Sanitized HTML is defensively filtered in the browser, but server-side sanitization remains mandatory.
- Package dependencies were declared without updating the root lockfile, as explicitly required by the task. The integration owner must reconcile the lockfile.

## Exact next steps

1. In the integration worktree, run the approved dependency install/lockfile update for `@tephra/web`.
2. Run `npm run typecheck --workspace=@tephra/web`, `npm run test --workspace=@tephra/web`, `npm run build --workspace=@tephra/web`, and root lint; fix only concrete failures.
3. Compare `src/api/types.ts` and `src/api/client.ts` with the implemented API response schemas and align the assumptions listed above.
4. Exercise login/bootstrap, deep-link refresh, rendered internal/unresolved links, attachments, links/backlinks, graph data, and token revocation against the running API.
5. Configure the production web server/reverse proxy with SPA fallback and the intended content-security policy/content-origin behavior.
