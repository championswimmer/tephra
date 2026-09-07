# Replace Hand-Rolled Infrastructure and Parsing

> **Status:** Proposed implementation plan
>
> **Scope:** Stage 1 maintainability and protocol-hardening refactor
>
> **Last updated:** 2026-09-07

## 1. Context and user outcome

Tephra already uses Hono for the API, React Router for the browser application,
Zod for part of the wire protocol, and Obsidian APIs in the plugin. Several
adjacent concerns nevertheless bypass those facilities or recreate mature
parsers:

- `apps/api/src/app.ts` manually reads, size-checks, parses, and validates JSON;
  parses bearer and cookie headers; and repeats route-local validation.
- both browser and plugin clients cast untrusted JSON to TypeScript types, and
  the plugin reparses error response text even though Obsidian's HTTP adapter
  already exposes decoded JSON.
- `apps/web/src/routes/VaultWorkspace.tsx` interprets the wildcard tail of a URL,
  while `NoteViewer.tsx` uses a regular expression to rediscover a route
  parameter from an anchor URL.
- `packages/markdown` implements YAML frontmatter, CommonMark/GFM block and
  inline parsing, links, tables, HTML generation, and URL sanitization with
  regular expressions and string concatenation.
- the plugin has a second frontmatter parser/writer as a fallback around
  Obsidian's metadata and `processFrontMatter` APIs.
- MIME types are maintained as a small handwritten extension table.

The outcome is to make framework and library boundaries explicit, replace
generic infrastructure with maintained implementations, and retain custom code
only for Tephra-specific semantics (vault paths, immutable blobs, revisions,
Obsidian wikilinks/callouts/block IDs, link resolution, and authorization
policy). This is an incremental refactor: every phase must preserve Stage 1
observable behavior before the old path is removed.

## 2. Audit decisions and selected libraries

### 2.1 Adopt Hono middleware and helpers

Use Hono's official `bodyLimit`, cookie helpers, and bearer parsing facilities,
plus `@hono/zod-validator` for request JSON, route params, and query strings.
Build small Tephra adapters around validator hooks so all validation failures
retain the existing `{ error: { code, message } }` envelope.

Do **not** replace `createApp` with another HTTP server or introduce a second
router. Hono already owns dispatch, middleware composition, response creation,
and the Node adapter. Database-backed dual authentication, authorization by
vault and scope, CSRF policy, transactional commit logic, request IDs, and the
redacted log allowlist remain application code because they are Tephra policy,
not HTTP parsing.

The API must use Hono route groups for authenticated and vault-scoped routes so
the ownership boundary is structural rather than a broad wildcard plus handler
convention. Static web fallback remains in the Node composition root.

### 2.2 Make Zod schemas the runtime wire contract

Expand `@tephra/protocol` with schemas for every request, success response, and
error response shared by server, web, and plugin. Infer public DTO types from
those schemas instead of maintaining parallel interfaces in
`apps/web/src/api/types.ts` or using `as` casts after `response.json()`.

Use a small fetch/request adapter in each runtime (browser `fetch`; Obsidian
`requestUrl`) rather than adding a general-purpose HTTP client. Those platform
APIs already handle transport correctly; the missing capability is shared
runtime validation. The adapters will accept an output Zod schema, normalize
network/non-JSON/API/contract errors, and return parsed values. Use Hono's typed
client only if a spike confirms it can describe the binary blob endpoints and
remain usable from the Obsidian bundle without importing server code; otherwise
prefer protocol schemas over coupling clients to the server package.

### 2.3 Use React Router for the complete browser route tree

Replace the `/v/:vaultId/*` wildcard parser with nested routes:

- `/v/:vaultId`
- `/v/:vaultId/graph`
- `/v/:vaultId/tokens`
- `/v/:vaultId/file/:fileId`

Use route params and `generatePath`/relative navigation for creation and
interpretation of internal URLs. Render Tephra file links with their file ID in
a `data-file-id` attribute and use DOM traversal (`closest`) in delegated click
handling; never extract application state from an `href` regular expression.
Unknown nested vault URLs must reach the normal not-found view rather than
silently becoming vault home.

### 2.4 Replace the generic Markdown stack with unified

Use the established unified syntax-tree pipeline:

- `unified` and `remark-parse` for CommonMark parsing,
- `remark-gfm` for tables, task lists, autolinks, and GFM constructs,
- `remark-frontmatter` plus `yaml` for YAML properties,
- `remark-rehype` and `rehype-stringify` for HTML generation,
- `rehype-sanitize` with an explicit Tephra schema as the final security
  boundary.

Implement only Obsidian-specific syntax as focused micromark/mdast plugins:
wikilinks and embeds, callouts, block IDs, and tags. Prefer documented unified
extension points and syntax-tree visitors over preprocessing Markdown with
regular expressions. A single parsed tree should feed both `parseNote` metadata
extraction and `renderMarkdown`, preventing indexing and rendering from
disagreeing. Preserve the public `@tephra/markdown` interfaces initially so the
indexer and API can migrate without an API flag day.

Sanitization is fail-closed. The explicit schema may allow only required HTML
elements, safe URL protocols, and known Tephra `class`/`data-*` attributes. Raw
HTML from a vault is not enabled in this plan. External links keep safe `rel`
values, attachment URLs must remain same-origin API paths, and generated HTML
must never contain event handlers or active-content URLs.

### 2.5 Use Obsidian APIs as the plugin frontmatter authority

Continue reading cached metadata through `metadataCache` and writing valid YAML
through `fileManager.processFrontMatter`. Remove the regex-based direct-content
fallback. If Obsidian cannot parse a note's YAML, store/reuse its stable file ID
in plugin state (the existing attachment-ID sidecar mechanism can be generalized)
and leave the original note bytes untouched. This makes invalid or templated
frontmatter non-destructive and avoids maintaining a partial YAML rewriter.

If tests establish that a standalone parser is still needed outside Obsidian,
use the same `yaml` package and its document API; do not add another regex
grammar. Preserve line endings and comments in any AST-based edit.

### 2.6 Adopt a maintained MIME database

Use `mime` (browser-safe lookup API) for extension-to-content-type lookup, with
`text/markdown` as the explicit Tephra override and `undefined` for unknown
types. Keep MIME values advisory: attachment serving must retain its download
and active-content protections.

### 2.7 Deliberately retain domain and adapter code

The following findings are not candidates for generic replacement in this
refactor:

- canonical vault-path checks and vault-link resolution encode cross-platform
  Obsidian semantics and security invariants;
- manifest canonicalization and SHA-256 verification are protocol primitives;
- parameterized SQLite repository queries implement the existing database
  interface and transaction model; an ORM would be a separate storage migration,
  not a parsing fix;
- scrypt invocation and constant-time comparison already delegate cryptography
  to Node; Tephra's encoded password format needs strict local validation;
- filesystem traversal, reconciliation, immutable blob storage, and revision
  diffs are product logic;
- observability serialization is structured output, not response parsing.

Revisit these only in focused proposals with measurable safety or maintenance
benefits; do not combine an ORM, auth product, logging framework, or sync engine
migration with this work.

## 3. Scope

### In scope

- API request body limits, JSON decoding, cookies/bearer extraction, route
  grouping, params, queries, and validation.
- Shared runtime schemas and typed decoding for all Stage 1 JSON endpoints.
- Browser route declaration/navigation and link-click interpretation.
- Markdown/frontmatter parsing, HTML generation, and sanitization.
- Plugin file-ID behavior when frontmatter cannot be processed.
- MIME lookup.
- Characterization, compatibility, and security regression tests, dependency
  manifests/lockfile, and relevant README/compatibility documentation.

### Explicit non-goals

- Web-to-vault writes, conflict merging, or third-party Obsidian plugin
  execution.
- Changes to endpoint paths, auth modes, token scopes, sync ordering, manifest
  hashing, blob immutability, revision semantics, or database schema.
- Rendering arbitrary HTML or aiming for complete Obsidian compatibility.
- Replacing Hono, React Router, Zod, Obsidian APIs, Node SQLite, or repository
  interfaces.
- Introducing an ORM, OpenAPI code generator, hosted service, or new runtime.
- Opportunistic visual redesign.

## 4. Invariants and security constraints

1. Original uploaded bytes remain canonical; parsing/rendering never rewrites a
   server blob. Blob hashes are still recomputed and checked before immutable
   storage, and successful vault commits remain revisioned.
2. Stage 1 remains one-way: only the Obsidian plugin may mutate its local vault,
   and invalid frontmatter must now fall back to sidecar state rather than a raw
   text rewrite.
3. Every untrusted boundary is runtime-validated: incoming API data, persisted
   JSON read from SQLite, and JSON received by both clients.
4. JSON limits apply to actual streamed/read bytes, not only `Content-Length`.
   Oversized, malformed, empty, and wrong-content-type requests return stable
   Tephra errors without exposing parser details.
5. Cookie, bearer, CSRF, vault ownership, and token-scope behavior must be byte-
   for-byte compatible from a client's perspective. No token, cookie, password,
   note body, or vault content may be logged.
6. Rendered HTML is sanitized after all transformations. Tests must cover mixed-
   case and entity/whitespace-obfuscated protocols, raw HTML, SVG, event handlers,
   malformed Markdown, and malicious labels/attributes.
7. Shared packages remain browser-safe. Node-only Hono adapters, filesystem APIs,
   and process access stay in API entrypoints/adapters. Markdown dependencies
   must be verified not to pull Node built-ins into the shared bundle.
8. URL parameters are decoded exactly once by React Router/Hono. Malformed
   encodings produce controlled 4xx/not-found behavior rather than uncaught
   exceptions.

## 5. Affected packages and ownership boundaries

| Area      | Expected files                                                                                                     | Ownership boundary                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Protocol  | `tephra-server/packages/protocol/src/index.ts`, tests, package manifest                                            | Runtime schemas and inferred wire DTOs only; no Node APIs        |
| API       | `tephra-server/apps/api/src/app.ts`, tests, package manifest                                                       | Hono composition, policy middleware, protocol-to-domain mapping  |
| Web       | `tephra-server/apps/web/src/app/App.tsx`, `routes/VaultWorkspace.tsx`, `components/NoteViewer.tsx`, `api/*`, tests | React routing and browser transport; no duplicated wire types    |
| Markdown  | `tephra-server/packages/markdown/src/index.ts`, new focused plugin modules, tests, package manifest                | Browser-safe Markdown AST parsing/rendering/sanitization         |
| Indexer   | `tephra-server/packages/indexer/src/index.ts`, compatibility tests                                                 | Consume stable parsed-note contract; keep vault resolution logic |
| Plugin    | `tephra-plugin/src/api/client.ts`, `sync/scanner.ts`, state and tests, package manifest                            | Obsidian transport/API integration and durable sidecar IDs       |
| Docs      | `docs/COMPATIBILITY.md`, relevant READMEs, `PROGRESS.md` only after verification                                   | Describe actual behavior and supported syntax                    |
| Workspace | `package-lock.json`                                                                                                | Pin and audit the selected dependencies                          |

## 6. Ordered implementation

### Phase 0 — Freeze behavior and evaluate dependencies

1. Add characterization fixtures for every currently promised Markdown feature,
   route, request failure, and client response shape before changing code.
2. Add adversarial fixtures for malformed JSON, chunked oversized JSON, encoded
   route parameters, malformed YAML, raw HTML, unsafe URLs, and copied file IDs.
3. Record current API status/error envelopes and normalized Markdown metadata;
   assert semantics rather than incidental whitespace except where HTML snapshots
   intentionally form a compatibility contract.
4. Verify release cadence, TypeScript/ESM support, browser bundles, licenses, and
   transitive dependency footprint of each proposed package. Pin compatible
   versions in the lockfile; reject abandoned Obsidian-specific Markdown plugins
   in favor of small local unified extensions.

**Exit criterion:** the old implementation passes the characterization suite,
and dependency review finds no Node built-ins in shared browser bundles.

### Phase 1 — Complete protocol schemas and client decoding

1. Inventory every JSON route in `createApp`; add strict input/output/error Zod
   schemas and inferred types to `@tephra/protocol`. Split the source into schema
   modules if needed while preserving package exports.
2. Replace the web's parallel API DTOs and unchecked generic `response.json()`
   casts with protocol schemas and a schema-driven browser transport.
3. Replace plugin response casts and manual error-text `JSON.parse` with the same
   response/error schemas over `requestUrl().json`. Treat a success payload that
   fails validation as a contract error distinct from an HTTP error.
4. Test non-JSON errors, invalid success bodies, extra/missing fields, network
   failures, and all sync response versions in both clients.

**Exit criterion:** no production client casts unknown response JSON to an API
DTO, and sync protocol schemas remain importable in Web Crypto-only environments.

### Phase 2 — Move HTTP mechanics into Hono

1. Install the official Hono Zod validator integration. Create common validator
   hooks that translate issues to existing Tephra error codes without reflecting
   sensitive values.
2. Replace `jsonBody` with `bodyLimit` plus JSON validation. Ensure the limit
   counts bytes when `Content-Length` is missing or false, and retain the separate
   configurable streaming limit for binary blob uploads.
3. Replace cookie serialization/parsing with Hono cookie helpers. Use Hono's
   bearer helper/parser where it does not alter the intentional API-token then
   session-token lookup order; keep database lookup in Tephra middleware.
4. Split the router into public auth, authenticated API, session-only, and
   vault-scoped Hono groups. Validate `vaultId`, `fileId`, `tokenId`, hash, and
   search query through route schemas and expose validated values through the
   Hono context.
5. Run existing concurrency and observability tests to prove middleware order,
   request IDs, CSRF, and log redaction are unchanged.

**Exit criterion:** application code no longer parses HTTP JSON/cookie/bearer
syntax or relies on unvalidated route/query strings.

### Phase 3 — Declare browser routes instead of parsing them

1. Convert the vault wildcard route to nested React Router routes and a shared
   vault layout/data component. Give each view an explicit element.
2. Centralize route builders with `generatePath`; update file tree, graph,
   backlinks, and redirects to use them.
3. Change rendered-note navigation to consume `data-file-id` from the closest
   anchor. External links retain normal browser behavior and unresolved links
   retain their current UI.
4. Add MemoryRouter tests for every nested route, encoded IDs, back/forward
   navigation, unknown tails, and click targets nested inside an anchor.

**Exit criterion:** there is no wildcard-tail parser or regex extraction of a
file route in production web code.

### Phase 4 — Migrate Markdown to syntax trees

1. Introduce unified with CommonMark, GFM, frontmatter, YAML, rehype conversion,
   sanitization, and serialization. Keep it behind the existing `parseNote` and
   `renderMarkdown` API.
2. Write micromark/mdast extensions for wikilinks/embeds, callouts, block IDs,
   and tags. Store Tephra link-resolution metadata on typed nodes rather than in
   placeholder strings.
3. Walk the single mdast tree to produce frontmatter, source-positioned headings,
   tags, blocks, and `ParsedLink` values. Preserve original `raw` link text and
   line numbering used by the index.
4. Transform the same tree to hast, resolve vault links/attachments through the
   existing callback, apply the explicit sanitize schema last, then stringify.
5. Compare all compatibility fixtures, document intentional standards-correct
   differences, and add regressions for constructs the old regex parser confused
   (nested emphasis, escaped delimiters, parentheses/titles in links, nested
   lists/quotes, variable code fences, and complex YAML).
6. Delete the handwritten generic parser, renderer, HTML escaping, and URL
   sanitizer only after parity and security tests pass.

**Exit criterion:** generic Markdown/GFM/YAML/HTML/sanitization behavior comes
from the selected libraries; local parsing code covers only documented Obsidian
extensions and Tephra metadata mapping.

### Phase 5 — Remove plugin fallback parsing and MIME tables

1. Generalize durable plugin sidecar IDs to cover Markdown notes whose
   frontmatter Obsidian cannot process. Define rename/delete reconciliation so
   IDs remain stable without modifying those notes.
2. Remove `extractFrontmatterFileId`, `injectFrontmatterFileId`, and direct vault
   modification fallback. Keep `processFrontMatter` for valid YAML and suppress
   self-generated file events as today.
3. Replace the MIME extension map with `mime`; test case-insensitive known types,
   Markdown override, SVG treatment, and unknown extensions.
4. Update plugin migration tests to load existing state without losing IDs and
   to prove invalid YAML bytes are unchanged across repeated scans.

**Exit criterion:** the plugin contains no YAML/frontmatter regex rewriter and
no generic MIME registry.

### Phase 6 — Documentation, rollout, and cleanup

1. Update compatibility documentation for parser behavior and explicitly list
   supported Obsidian extensions and raw-HTML policy.
2. Update public setup commands only if package/build behavior changed. Update
   `PROGRESS.md` solely for completed and verified phases.
3. Run the full verification matrix, inspect production bundle composition, and
   exercise the sample vault in the running application. Capture a screenshot
   only if rendered output changes perceptibly.
4. Land phases as reviewable commits in dependency order. Do not keep temporary
   dual parsers or fallback flags after final acceptance.

## 7. API, schema, and migration consequences

- **HTTP API:** no planned endpoint, method, status, authentication, or response
  shape changes. Stricter response validation affects clients only when a server
  violates its documented contract. Previously silent unknown nested web routes
  will correctly show not-found.
- **TypeScript API:** API DTO types move to/infer from `@tephra/protocol`.
  `@tephra/markdown` keeps its current exported result shapes during migration;
  internal AST types are not exported.
- **Database:** no SQL schema migration. Plugin settings/state may gain a
  versioned sidecar map for Markdown fallback IDs; migration must be additive and
  preserve existing attachment mappings and prior per-path file state.
- **Rendered HTML:** tag nesting and insignificant whitespace may become
  standards-correct but different. Tephra CSS classes, data attributes, IDs,
  navigation behavior, metadata, and sanitization are compatibility requirements.
- **Dependencies:** new runtime dependencies are localized to their owning
  workspace. Avoid hoisting assumptions; commit the root lockfile.

## 8. Verification

Run after each relevant phase and once from a clean checkout at completion:

```bash
npm run test --workspace=@tephra/protocol
npm run test --workspace=@tephra/api
npm run test --workspace=@tephra/web
npm run test --workspace=@tephra/markdown
npm run test --workspace=@tephra/indexer
npm run test --workspace=@tephra/plugin
npm run build
npm run check
```

Additional focused verification:

- API tests stream a body above the limit without `Content-Length` and verify
  413, error shape, request ID, and redacted logs.
- Contract tests feed malformed success and error bodies to browser and Obsidian
  transports.
- Markdown fixtures assert parsed metadata plus sanitized DOM structure and run
  the existing compatibility vault end to end.
- Plugin tests compare exact bytes before/after scanning malformed YAML and
  verify stable identity through rescan and rename.
- Browser route tests cover direct load, refresh, encoded params, unknown nested
  paths, and delegated note-link clicks.
- `npm audit --omit=dev` is reviewed (not blindly auto-fixed), and production
  bundles are checked for accidental Node built-ins in browser-safe packages.
- Use the `dev-server` skill to run the sample vault flow; if UI output changes,
  execute the Playwright vault flow and capture representative note/table/callout
  screenshots for review.

## 9. Compatibility, deployment, and rollback risks

| Risk                                                           | Mitigation / rollback                                                                                                                      |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Unified output changes CSS-visible DOM                         | Characterization fixtures; preserve stable classes/attributes; land renderer independently so its commit can be reverted                   |
| Sanitizer drops required attributes or allows active content   | Explicit allowlist and adversarial tests; sanitize last; rollback renderer phase without rolling back protocol work                        |
| Hono middleware changes error precedence or consumes streams   | Test malformed/oversized/wrong-content-type bodies and binary uploads before removal of `jsonBody`                                         |
| Strict clients reject older self-hosted servers                | Make only genuinely version-optional fields optional in schemas; fixture supported historical payloads; ship server before or with clients |
| Shared Markdown dependencies import Node APIs or bloat clients | Bundle inspection and browser test before adoption; keep server rendering boundary available; reject unsuitable plugins                    |
| Sidecar IDs change on rename after invalid YAML                | Versioned state migration and rename/event reconciliation tests; retain previous-path state until successful reconciliation                |
| New MIME lookup serves active types inline                     | Preserve attachment disposition/security policy independently of lookup results                                                            |
| Large cross-package rollout is hard to bisect                  | Land phases 1–5 separately in order, with green workspace tests and no long-lived feature flag                                             |

Deployment requires no database or volume migration. Rollback should be by phase:
protocol consumers first, then Hono mechanics, routing, Markdown, and plugin state.
Never roll back to a plugin version that cannot read an already-persisted sidecar
state version; retain backwards-tolerant state decoding for at least one release.

## 10. Completion checklist

- [ ] Characterization and adversarial tests cover all replaced behavior.
- [ ] Dependency review records maintenance, license, browser, and bundle results.
- [ ] All Stage 1 JSON inputs and outputs have shared strict Zod schemas.
- [ ] Browser and plugin validate every untrusted JSON response.
- [ ] Hono owns body limits, JSON decoding, cookies/bearer syntax, route matching,
      and param/query validation.
- [ ] React Router owns the full browser route hierarchy and route generation.
- [ ] Unified libraries own generic Markdown, GFM, YAML, hast conversion, HTML
      serialization, and sanitization.
- [ ] Local Markdown code is limited to tested Obsidian/Tephra extensions.
- [ ] Invalid plugin frontmatter is never rewritten by a fallback parser.
- [ ] MIME lookup uses the maintained database without weakening attachment
      serving policy.
- [ ] Blob immutability, SHA-256 verification, revisions, auth/CSRF, and log
      redaction regressions pass.
- [ ] Shared packages build for browser runtimes with no Node-only imports.
- [ ] Documentation describes only verified behavior.
- [ ] `npm run check` passes from the repository root.
