import type { Vault } from '@tephra/vault-model';
import { fail } from './errors.js';

/** Pausing the official client must not permit a second sync source. */
export function requireTephraSync(vault: Vault): void {
  if (vault.syncMode === 'obsidian')
    fail(
      409,
      'VAULT_SYNC_MODE_MISMATCH',
      'Official Obsidian Sync is enabled for this vault. Direct device sync (plan, upload, and commit) is disabled. Use Obsidian Sync on your devices.',
    );
}
