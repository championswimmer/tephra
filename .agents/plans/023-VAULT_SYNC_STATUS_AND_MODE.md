# Vault sync status and permanent sync methods

## Context and outcome

Headless Obsidian Sync vault cards should show current sync status instead of direct-sync revision metadata. Vault creation must clearly explain that the choice between direct Tephra plugin sync and official headless Obsidian Sync is permanent. The expanded user request also consolidates account, appearance, and Obsidian sign-in/reauthentication into global settings, with sync configuration and revision information in settings for each vault.

## Scope and non-goals

- Include safe headless status summaries in vault API responses and refresh them on the vault list.
- Keep revision metadata for direct plugin vaults.
- Explain the fixed sync method in both existing creation flows; preserve server enforcement and add regression coverage.
- Consolidate global settings into `/settings` and remove the duplicate appearance-only settings entry point.
- Add user-scoped Obsidian sign-in/reauthentication, preserving only official signed-in session artifacts in private server storage; copy only authentication artifacts to isolated vault clients and resume enabled workers after reauth.
- Add `/v/:vaultSlug/settings` for fixed method, sync status, revision, native remote/direction/enable controls, and direct-vault tokens.
- Consolidate method selection at vault creation on the vault list; global account settings and vault settings link to it.
- Preserve direction choices and legacy isolated sessions until explicit global sign-in; do not infer a shared account from potentially different old vault sessions. No changes to plugin code or canonical file storage.

## Invariants

- Sync method is selected at creation and cannot be changed by subsequent API operations.
- Status responses contain only allowlisted public state, never credentials, session tokens, encryption keys, or vault contents.
- Keep ownership checks, immutable verified blobs, and revisioned commits unchanged. Use repository abstractions.

## Affected packages and agent ownership

1. API agent: `tephra-server/apps/api` only. Add `obsidianSync` summary to public vault responses with fields `enabled`, `phase`, `lastErrorCode`, and `lastSyncedAt`; use initial settings fallback when missing and phase `unavailable` if headless service is disabled. Verify existing method immutability and add regression tests.
2. Vault-list agent: `tephra-server/apps/web/src/routes/VaultListPage.tsx`, `src/api/types.ts`, relevant vault-list tests, and narrowly necessary styles only. Render/poll summaries, preserve direct revision cards, and explain direct creation's permanent method.
3. Settings agent: global settings page, AppShell/settings modal consolidation, Obsidian account component, and extraction of a vault-specific native sync panel and its tests. Keep account credentials out of vault configuration.
4. Vault-list agent expansion: creation-time method selection, new vault settings route/page, workspace links and tests. Coordinate native panel props with settings agent and account client methods with API agent.
4. Orchestrator: plan, integration review, full verification, and necessary integration fixes.

## Implementation sequence

1. Agree on additive summary contract before parallel coding.
2. Implement API summary and API immutability regression tests alongside the two UI changes.
3. Review integrated behavior, including status polling cleanup, failed refreshes, pending/error/paused/unavailable states, and creation copy.
4. Run targeted tests and `npm run check`; build and preview the changed UI if local tooling permits.

## API, schema, and migration consequences

Add optional `obsidianSync` public summary only for headless vaults. Existing direct responses and sync mode values remain compatible. Add session-only GET `/api/v1/obsidian-sync/account` and POST `/api/v1/obsidian-sync/account/login`, returning `{account:{authenticated:boolean,email:string|null,lastErrorCode:string|null}}`. Keep existing per-vault APIs for compatibility but route login through the account service and use global auth for newly configured vaults. OfficialClient interface abstracts account artifact checks/transfers. No database migration or mode mutation endpoint is required.

## Verification

- API tests: public summaries, ownership/credential safety, both creation modes, attempted switching and cross-mode operations.
- Web tests: statuses replace revision for headless vaults, direct revisions remain, refreshed state and cleanup, permanent-method copy in both creation flows.
- Account tests: session isolation, no password/2FA persistence or response leakage, reauth updates owned vaults only, deletion does not revoke shared account, legacy sessions continue until explicit sign-in, account survives restart.
- Settings tests: one global entry point, global account login/reauth without choosing vault, vault-local status/revision and controls, direct token access, no existing-vault method selector.
- Required repository command: `npm run check`.

## Rollout risks and rollback

Polling must avoid overlapping requests, stale state updates, and resurrecting deleted cards. Disabled headless support should be explicit. Additive responses allow independent deployment; rollback removes summaries and UI without data migration.
Account reauthentication must serialize with vault setup/deletion, preserve independent sync ledgers and encryption keys, and never revoke a shared session when deleting a vault. Existing users may need to sign in once in global settings to adopt shared authentication; legacy per-vault sessions remain usable meanwhile. Account and vault configuration paths must remain confined and private.

## Completion checklist

- [x] API summary and method-lock regression coverage verified.
- [x] Vault-list headless statuses refresh and direct revisions remain.
- [x] Consolidated creation flow explains the permanent sync method.
- [x] Global account/appearance/Obsidian reauthentication and vault-local settings are separated.
- [x] Integration review, desktop/mobile preview, and `npm run check` pass.
