# Reimagine Tephra Obsidian Plugin: Cloud Control & Optional Sync

> Status: implementation plan
> Target: `007-REIMAGINED_OBSIDIAN_PLUGIN.md`
> Depends on: `001-TEPHRA_STAGE1_PLAN.md`, `006-HEADLESS_OBSIDIAN_SYNC.md`
> Follows: `002-AUTHENTICATION_MODES.md`
> Packages: `tephra-plugin`, `tephra-server/apps/api`, `packages/auth`, `packages/protocol`
> Last updated: 2026-09-06

---

## 1. Context and User Outcome

### Context
Originally, the `tephra-plugin` was built solely as an eager, background synchronization worker. It required users to manually visit the Tephra web UI, create a vault, create an upload token, copy raw secret tokens and UUIDs into Obsidian plugin settings, and let a background watcher run continuously.

With the introduction of the headless Obsidian Sync sidecar (`006-HEADLESS_OBSIDIAN_SYNC.md`), many users now sync their vaults using Obsidian's official sync or other sync sidecars directly to the Tephra server host. For these users, running an aggressive background sync loop in the Obsidian plugin is redundant, wastes network/battery, and can cause sync conflicts.

Furthermore, the manual configuration flow (copying vault IDs, device IDs, and tokens from the web UI to Obsidian) is cumbersome, error-prone, and poor UX.

### User Outcome
The Tephra Obsidian plugin is reimagined as the **primary companion and control center for your Tephra cloud instance** directly inside Obsidian:

1. **Streamlined Connect & Login**:
   - The user enters the Tephra server URL and logs in with their credentials (email and password).
   - No copy-pasting of opaque tokens or vault UUIDs is required.
   - The plugin authenticates with Tephra and establishes an authenticated session.

2. **Tephra Cloud Instance Control & Automated Vault Provisioning**:
   - The plugin queries the Tephra instance, displaying server connection health, account status, and available vaults.
   - The user can select an existing vault to bind to the current Obsidian workspace, **or create a new vault on the Tephra cloud instance directly from the Obsidian plugin** (with a single click, pre-filling the local Obsidian vault name).
   - Upon selecting or creating a vault, the plugin automatically calls the Tephra API to mint a vault-scoped upload token for this device, binding it into the plugin's configuration immediately.
   - The user can manage remote vault settings (view latest revision, token list, open web mirror).

3. **Decoupled & Optional Direct Sync**:
   - Direct sync is an **optional mode** (`enableSync: boolean`), not mandatory.
   - **When disabled (e.g. Sidecar Mode)**: The plugin operates in "Control / Sidecar" mode. All vault file system watchers, debounce buffers, and interval reconciliation timers are completely disarmed. The status bar indicates that Tephra is connected in sidecar/external sync mode.
   - **When enabled (Direct Sync Mode)**: The plugin actively watches vault changes, calculates hashes, and synchronizes natively with the Tephra server via `/sync/plan`, `/blobs/:hash`, and `/sync/commit`.

---

## 2. Scope and Explicit Non-Goals

### In Scope
- **Server API enhancements**:
  - Allow `POST /api/v1/auth/login` to return `sessionToken` in the response body (in addition to setting cookies for browsers) for client applications.
  - Enhance API authentication middleware to accept `Authorization: Bearer <sessionToken>` for session-scoped endpoints (`/api/v1/vaults`, `/api/v1/vaults/:vaultId/tokens`, etc.).
  - Ensure API endpoints accessed with `Authorization: Bearer` bypass cookie-based CSRF checks (CSRF protections apply to ambient browser cookie credentials, not explicit bearer tokens).
- **Plugin State & Storage**:
  - Expand `TephraSettings` and `TephraPluginState` to store auth session info (`sessionToken`, `userEmail`, `userId`), vault metadata (`vaultName`), and sync mode toggle (`enableSync`).
- **Plugin API Client**:
  - Add management methods to `TephraClient`: `login`, `logout`, `getMe`, `listVaults`, `createVault`, `createVaultToken`, `getVault`.
- **Plugin Sync Lifecycle**:
  - Dynamically arm and disarm vault watchers (`vault.on('create'|'modify'|'delete'|'rename')`), event buffer, and periodic reconciliation interval based on `enableSync` and binding status.
  - Update status bar component to reflect the active mode: "Sync Disabled (Sidecar Mode)", "Idle", "Syncing", "Offline", "Auth Error".
- **Obsidian Settings UI**:
  - Full redesign of `TephraSettingTab`:
    - Server connection block (URL input, connection test, status indicator).
    - Account authentication block (login form, logged-in status badge, log out).
    - Remote Vault & Instance Control block (linked vault card, vault picker dropdown, create new vault form, open in web mirror).
    - Sync mode block (toggle direct sync, fine-tune debounce/concurrency, manual sync trigger, sync metrics).
    - Advanced / manual fallback block (direct token/vault ID override for air-gapped or restricted setups).

### Explicit Non-Goals
- Two-way merging, conflict resolution, or server-to-vault file writing (Stage 1 read-only mirror invariant holds).
- Re-implementing Obsidian's proprietary sync protocol inside the plugin (the headless sidecar handles official sync on the host).
- Multi-user administrative panels inside Obsidian (e.g., managing other users' accounts).
- Third-party OAuth / SSO providers (single email/password authentication per plan 002).

---

## 3. Architecture and Invariants

### 3.1 Security & Invariants
1. **Bearer Session Security**:
   - `sessionToken` is stored in Obsidian's private plugin data (`data.json`) and never logged or exposed.
   - Tokens use `sha256` hashing on the server side (`hashOpaqueToken`), consistent with existing session and API token storage.
2. **CSRF Scoping**:
   - Browser requests using ambient cookies still strictly require `X-Tephra-CSRF` headers.
   - Bearer-authenticated API requests (`Authorization: Bearer <sessionToken>`) are not subject to CSRF forgery and are permitted directly.
3. **Vault-Scoped Device Tokens**:
   - Even though the user logs in with account credentials to manage vaults, direct synchronization continues to use a dedicated, least-privilege vault-scoped token (`ApiToken` with scopes `['vault:read-metadata', 'vault:upload']`).
   - If direct sync is used on multiple devices, each device has its own device ID and distinct token.
4. **Clean Resource Teardown**:
   - When `enableSync` is set to `false`, zero file system event listeners remain registered on Obsidian's `vault` object, preventing any memory leaks or unnecessary background CPU cycles.

---

## 4. API and Protocol Changes

### 4.1 Server API (`tephra-server/apps/api/src/app.ts`)

#### 1. `POST /api/v1/auth/login`
- **Request**: `{ email: string, password: string }`
- **Response**:
  ```json
  {
    "user": { "id": "string", "email": "string" },
    "sessionToken": "tps_...",
    "csrfToken": "tpc_..."
  }
  ```
- **Cookies**: Continues to set `tephra_session` and `tephra_csrf` for web browsers.

#### 2. Authentication Middleware
Update `authenticate(c, dependencies)`:
1. Check `Authorization: Bearer <rawBearer>`.
2. Compute `hashOpaqueToken(rawBearer)`.
3. Check `dependencies.database.apiTokens.findByTokenHash(hash)`. If found and active, return `{ kind: 'token', token, user }`.
4. If not found in `apiTokens`, check `dependencies.database.sessions.findById(hash)`. If found and active (`expiresAt > now`), return `{ kind: 'session', session, user }`.
5. If neither matches, check cookie `tephra_session`.

#### 3. CSRF Verification
In `/api/v1/*` middleware:
Only verify CSRF if `principal.kind === 'session'` **AND** the request was authenticated via cookie (not Bearer header).

```ts
const isCookieSession = !c.req.header('authorization')?.startsWith('Bearer ');
if (principal.kind === 'session' && isCookieSession && !['GET', 'HEAD', 'OPTIONS'].includes(c.req.method)) {
  // perform CSRF cookie vs header comparison
}
```

---

## 5. Plugin Architecture & Implementation

### 5.1 State Model (`tephra-plugin/src/state/plugin-state.ts`)

```ts
export interface TephraAuthSession {
  sessionToken: string;
  userEmail: string;
  userId: string;
}

export interface TephraSettings {
  serverUrl: string;
  vaultId: string;
  vaultName: string;
  uploadToken: string;
  deviceId: string;
  deviceName: string;
  enableSync: boolean;      // Toggle for direct sync (default: true, disable for sidecar)
  debounceMs: number;
  concurrency: number;
  auth?: TephraAuthSession; // Stored user session
}

export interface TephraPluginState {
  version: 1;
  settings: TephraSettings;
  manifest: Record<string, LocalFileState>;
  attachmentIds: Record<string, string>;
  lastSuccessfulSyncAt?: number;
  lastRemoteRevision?: number;
}
```

### 5.2 Extended Client (`tephra-plugin/src/api/client.ts`)

Add full cloud instance control methods alongside sync methods:

```ts
export interface ServerVault {
  id: string;
  name: string;
  latestRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface ServerUser {
  id: string;
  email: string;
}

export class TephraClient implements TephraClientLike {
  // Sync methods (using vaultId & uploadToken)
  plan(body: SyncPlanBody): Promise<SyncPlanResponse>;
  uploadBlob(hash: string, bytes: Uint8Array): Promise<void>;
  commit(body: SyncCommitBody): Promise<SyncCommitResponse>;

  // Management & Auth methods (using serverUrl & sessionToken)
  static login(serverUrl: string, credentials: { email: string; password: string }): Promise<{ user: ServerUser; sessionToken: string }>;
  static testConnection(serverUrl: string): Promise<{ ok: boolean; status: string }>;
  
  listVaults(sessionToken: string): Promise<ServerVault[]>;
  createVault(sessionToken: string, name: string): Promise<ServerVault>;
  createVaultToken(sessionToken: string, vaultId: string, input: {
    name: string;
    deviceId?: string;
    deviceName?: string;
    platform?: string;
  }): Promise<{ token: { id: string; name: string }; value: string }>;
  getVault(sessionToken: string, vaultId: string): Promise<ServerVault>;
  logout(sessionToken: string): Promise<void>;
}
```

### 5.3 Lifecycle & Dynamic Watchers (`tephra-plugin/src/main.ts`)

```text
            +---------------------------+
            |  Plugin Loaded (onload)   |
            +-------------+-------------+
                          |
                          v
         +---------------------------------+
         | Layout Ready & State Initialized|
         +----------------+----------------+
                          |
             Is `enableSync` true AND
             vaultId/uploadToken set?
             /                         \
           YES                          NO
           /                             \
          v                               v
+-----------------------+      +---------------------------+
| Arm Vault Watchers    |      | Disarm Vault Watchers     |
| Start Event Buffer    |      | Stop Event Buffer         |
| Start Reconcile Timer |      | Clear Reconcile Timer     |
| Status: Idle/Synced   |      | Status: Managed (Sync Off)|
+-----------------------+      +---------------------------+
```

Methods in `TephraPlugin`:
- `configureSyncEngine()`: Evaluates `settings.enableSync` and credentials.
  - If `false` or unconfigured: Disposes `eventBuffer`, unregisters vault events (or flags handler as inactive), cancels interval timer.
  - If `true` and configured: Initializes `SyncCoordinator`, sets up `EventBuffer`, hooks `vault.on('create'|'modify'|'delete'|'rename')`, registers reconciliation timer, triggers initial sync.

### 5.4 Settings Tab User Experience (`tephra-plugin/src/ui/settings-tab.ts`)

The settings tab is structured into 4 clean cards:

1. **Server Connection**:
   - Input: Server URL (`https://tephra.example.com`).
   - Button: "Test Connection". Shows badge: `Online` (green) or `Unreachable` (red).

2. **Account & Cloud Instance**:
   - **If Logged Out**:
     - Email and password input fields.
     - "Log In" button.
     - Note with link to the server URL to register/bootstrap if needed.
   - **If Logged In**:
     - Displays "Logged in as `user@example.com`".
     - Button: "Log Out" (clears session token).

3. **Remote Vault Control**:
   - Displays currently bound remote vault name and ID.
   - **Switch Vault**: Dropdown populated dynamically from `listVaults()`. Selecting a vault and clicking "Bind Vault" automatically mints a new device token on the server and updates settings.
   - **Create New Vault**: Input for new vault name (defaulting to current Obsidian vault name, `this.app.vault.getName()`). Clicking "Create & Bind" creates the vault on the Tephra instance, creates the token, binds it, and displays success notice.
   - Button: "Open in Tephra Web Mirror" (`window.open(serverUrl + '/vaults/' + vaultId)`).

4. **Sync Mode & Options**:
   - Toggle: **Enable Direct Plugin Sync**
     - Description: "Sync notes directly from this device to Tephra. Disable this if your server uses the Headless Obsidian Sync sidecar or another external sync service."
   - When enabled:
     - "Sync Now" CTA button.
     - Debounce interval (ms).
     - Upload concurrency (1-10).
     - Last sync timestamp & revision display.
   - Collapsible: **Advanced / Manual Token Override** (allows manual entry of Vault ID and Upload Token without logging into an account).

---

## 6. Ordered Implementation Phases

### Phase 1: Server Authentication & Bearer Session Support
1. Update `tephra-server/apps/api/src/app.ts`:
   - Return `sessionToken` in `POST /api/v1/auth/login`.
   - Update `authenticate` to accept `Authorization: Bearer <sessionToken>` for sessions.
   - Update CSRF middleware to exempt requests bearing explicit `Authorization: Bearer` headers.
2. Add API unit tests in `tephra-server/apps/api/tests/app.test.ts` verifying that:
   - `POST /api/v1/auth/login` returns `sessionToken`.
   - Calling `/api/v1/vaults` and `/api/v1/vaults/:vaultId/tokens` with `Authorization: Bearer <sessionToken>` succeeds without cookies and without CSRF tokens.
3. Verification: `npm test --workspace=@tephra/api`.

### Phase 2: Plugin State & Extended API Client
1. Update `tephra-plugin/src/state/plugin-state.ts`:
   - Add `enableSync`, `auth` (sessionToken, userEmail, userId), `vaultName` to `TephraSettings`.
   - Update `DEFAULT_SETTINGS` (`enableSync: true`).
   - Update `parseState` to migrate existing state backwards-compatibly.
2. Update `tephra-plugin/src/api/client.ts`:
   - Add management methods: `login`, `testConnection`, `listVaults`, `createVault`, `createVaultToken`, `getVault`, `logout`.
   - Implement error parsing and typing.
3. Add client tests in `tephra-plugin/tests/client.test.ts` mocking `requestUrl` responses for login, vault listing, vault creation, and token creation.
4. Verification: `npm test --workspace=@tephra/plugin`.

### Phase 3: Sync Decoupling & Lifecycle Control
1. Update `tephra-plugin/src/main.ts`:
   - Implement clean arm/disarm mechanism for vault file watchers and reconciliation timers.
   - When `enableSync` is false, disarm watchers, stop event buffer, and set status to "Managed (Sync Off)".
   - When `enableSync` is true, arm watchers and coordinator.
   - Handle settings change and live toggle without needing an Obsidian restart.
2. Update `tephra-plugin/src/ui/status.ts`:
   - Add display support for `'sync-disabled'` phase with custom tooltip.
3. Add tests in `tephra-plugin/tests/coordinator.test.ts` checking behavior when sync is enabled vs disabled.
4. Verification: `npm test --workspace=@tephra/plugin`.

### Phase 4: Obsidian Settings UI Redesign
1. Redesign `tephra-plugin/src/ui/settings-tab.ts`:
   - Build modular UI components for Server Connection, Account Login, Vault Management, Sync Options, and Advanced Override.
   - Connect "Create & Bind" button to `createVault` + `createVaultToken` workflow.
   - Connect "Bind Selected" dropdown to `createVaultToken` workflow.
   - Connect "Enable Direct Sync" toggle to dynamic lifecycle reloader.
2. Verification: Build plugin bundle via `npm run build --workspace=@tephra/plugin`.

### Phase 5: Verification & Repository Check
1. Run full typecheck: `npm run typecheck`.
2. Run full workspace tests: `npm run test:workspaces`.
3. Verify plugin bundle generation: `tephra-plugin/main.js` builds without external runtime dependencies (except Obsidian).
4. Update `PROGRESS.md` to reflect the reimagined plugin capabilities.

---

## 7. Risks and Mitigations

| Risk | Mitigation |
| ---- | ---------- |
| Bearer sessions bypassing CSRF weakens security | CSRF only targets ambient cookie credentials. Explicit `Authorization: Bearer` headers cannot be sent cross-site without CORS permission. |
| Existing users updating plugin lose settings | `parseState` initializes `enableSync = true` and preserves all existing `serverUrl`, `vaultId`, and `uploadToken` values. |
| User with Sidecar accidentally runs direct sync | Prominent setting toggle with descriptive note explaining Sidecar Mode. When disabled, zero file watchers run. |
| Obsidian `requestUrl` platform quirks | All requests use standard JSON payloads and bearer headers, fully tested on desktop and mobile shims. |

---

## 8. Verification Commands

```bash
# Verify API tests with bearer session authentication
npm test --workspace=@tephra/api

# Verify plugin unit tests including client, state, coordinator, and lifecycle
npm test --workspace=@tephra/plugin

# Run repository typecheck
npm run typecheck

# Build the Obsidian plugin bundle
npm run build --workspace=@tephra/plugin
```

---

## 9. Completion Checklist

- [ ] `007-REIMAGINED_OBSIDIAN_PLUGIN.md` created in `.agents/plans/`.
- [ ] Server API updated to return `sessionToken` on login and support Bearer session auth for vault/token management.
- [ ] Plugin state updated with `enableSync`, `auth`, `vaultName`.
- [ ] Plugin API client equipped with login, vault listing, vault creation, and token creation.
- [ ] Sync coordinator and watchers decoupled with clean arm/disarm lifecycle.
- [ ] Settings tab redesigned with server connection, account login, vault creation/binding, and sync toggles.
- [ ] All tests passing and bundle verified.
