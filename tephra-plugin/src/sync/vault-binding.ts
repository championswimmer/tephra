import type { RemoteVault } from '../api/client';

/**
 * Name-based vault binding (vault-name URLs, plan 012).
 *
 * The web mirror addresses vaults by their globally-unique name
 * (`/v/:vaultName`) while the API `:vaultId` segment accepts either the
 * internal id or the name. The plugin stores both: `vaultId` is the stable
 * identity namespace (file-id minting, sidecar key) and `vaultName` is the
 * web slug. Either field may go stale or hold the other kind of identifier
 * (e.g. a name pasted into the manual vault-ID override), so every sync
 * canonicalizes the stored binding through `GET /vaults/:idOrName` before
 * doing any work.
 */

/** Minimal settings surface needed for binding resolution. */
export interface VaultBindingSettings {
  serverUrl: string;
  vaultId: string;
  vaultName?: string | undefined;
  uploadToken: string;
  auth?: { sessionToken: string } | undefined;
}

/** Minimal client surface: vault lookup by id-or-name. */
export interface VaultBindingResolver {
  getVault(slug: string, tokenOverride?: string): Promise<RemoteVault>;
}

export interface VaultBindingResult {
  /**
   * True when the server confirmed the binding — or when there was nothing
   * to resolve (no URL/identifier configured). False when resolution was
   * skipped (no credentials) or failed (offline, revoked token, unknown
   * vault): the caller must keep the stored binding untouched.
   */
  resolved: boolean;
  /** True when `vaultId` or `vaultName` was updated and must be persisted. */
  changed: boolean;
  /**
   * True only when the canonical vault id changed. The sidecar cache is
   * keyed by vault id, so the caller must reload it; the miss then queues
   * the standard server repair instead of churning identities.
   */
  idChanged: boolean;
}

/**
 * Best-effort canonicalization of the stored vault binding. Mutates
 * `settings` in place on success; never throws and never clears stored
 * values on failure.
 */
export async function ensureVaultBinding(
  settings: VaultBindingSettings,
  makeClient: (serverUrl: string) => VaultBindingResolver,
): Promise<VaultBindingResult> {
  const slug = settings.vaultId || settings.vaultName || '';
  if (!settings.serverUrl || !slug) return { resolved: true, changed: false, idChanged: false };
  // A session token resolves any owned vault by id or name (rebind and
  // manual-entry cases); the vault-scoped upload token only resolves the
  // vault it was provisioned for.
  const token = settings.auth?.sessionToken || settings.uploadToken || undefined;
  if (!token) return { resolved: false, changed: false, idChanged: false };
  let vault: RemoteVault;
  try {
    vault = await makeClient(settings.serverUrl).getVault(slug, token);
  } catch {
    return { resolved: false, changed: false, idChanged: false };
  }
  let changed = false;
  let idChanged = false;
  if (vault.id !== settings.vaultId) {
    settings.vaultId = vault.id;
    changed = true;
    idChanged = true;
  }
  if ((vault.name ?? '') !== (settings.vaultName ?? '')) {
    settings.vaultName = vault.name;
    changed = true;
  }
  return { resolved: true, changed, idChanged };
}
