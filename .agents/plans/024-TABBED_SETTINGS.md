# Tabbed application settings

## Context and outcome

Replace the long application settings page and separate MCP page with one Settings
page containing Appearance, Account, Sync, and MCP tabs, in that order. Each tab
shows only its own settings. The user permits breaking existing settings URLs.

## Scope and non-goals

- Appearance contains the existing device theme selector.
- Account contains the signed-in Tephra identity, session information and sign-out.
- Sync contains the existing Obsidian account/sign-in settings.
- MCP embeds the complete agent setup guides and authorized-agent management.
- Support pointer and keyboard navigation, mobile layouts, reloads and history.
- Update application links to the Sync tab. Remove the standalone MCP route.
- No new account APIs, session management features, sync behavior, MCP protocol
  changes, vault-specific settings changes or backwards-compatible redirects.

## Invariants and ownership

Only `@tephra/web` is affected. Keep authentication, token revocation, Obsidian
credential handling, immutable vault contents and revision semantics unchanged.
Do not log credentials, session data or vault contents. Only mount the active
panel so unrelated tabs do not fetch sync/account/token data. Switching away
from Sync unmounts its credential form rather than retaining secrets in hidden UI.

## Implementation

1. Refactor `SettingsPage.tsx` into a shared heading, accessible tablist and active
   tabpanel. Use `/settings?tab=appearance|account|sync|mcp`; default to Appearance
   for missing/unknown tab values. Use URL history for Back/Forward and reloading.
   Use roving tab stops and Left/Right/Home/End keys with automatic activation.
2. Move the MCP route content to `components/McpSettingsPanel.tsx`, preserving
   the full guides and AuthorizedAgents functionality without a nested main/page.
   Remove `/settings/mcp` from `app/App.tsx`.
3. Update Sync links in the vault library, workspace and sync panel, with their
   existing tests. Add responsive tab styling using existing theme variables.
4. Add settings integration tests for panel isolation, direct URLs/history,
   keyboard navigation, theme changes, sign-out, sync sign-in and MCP behavior.
   Add desktop/mobile Chromium coverage and inspect screenshots.
5. Run `npm run check`, build/serve the web UI following `dev-server`, run the
   browser checks, then update `PROGRESS.md` with verified work and commit locally
   without pushing, following the user's existing preference.

## APIs, migration and compatibility

No API, schema, dependency or migration changes. Old `/settings#obsidian-sync`
links and `/settings/mcp` need not be preserved. Internal Sync links become
`/settings?tab=sync`; MCP is `/settings?tab=mcp`. Existing vault settings URLs
remain unchanged.

## Verification and rollout risks

Run targeted Vitest settings/MCP/sync/vault tests, `npm run check`, and Chromium
desktop/mobile settings tests against the rebuilt web assets. Verify tab ARIA
relationships, keyboard behavior, Back/Forward/reload, theme persistence, account
identity/sign-out, Sync isolation and MCP guides/revocation. Main risks are stale
internal links, duplicate page landmarks, inaccessible navigation, and clipped
tabs on narrow screens. Roll back by reverting the web-only change and rebuilding
the web bundle; no persisted data is affected.

## Completion

- [x] Four settings tabs and embedded MCP panel implemented.
- [x] Internal links and tests updated.
- [x] Repository and browser checks pass; screenshots reviewed.
- [ ] Verified progress recorded; local commit made without pushing.

Delete this implementation plan after the change has been committed, as required
by the planning skill lifecycle.
