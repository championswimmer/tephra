import type { Vault } from '@tephra/vault-model';
import { initialObsidianSettings } from '../obsidian/types.js';
import { requireObsidianService } from './obsidian-sync.js';
import { z } from 'zod';
import { fail } from '../http/errors.js';
import { jsonBody } from '../http/body.js';
import { ownedVault, requireSession } from '../http/auth.js';
import type { ApiApp, ApiDependencies } from '../http/types.js';

const vaultNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .refine(
    (name) =>
      !name.includes('/') &&
      !name.includes('\\') &&
      name !== '.' &&
      name !== '..' &&
      // eslint-disable-next-line no-control-regex
      !/[\u0000-\u001f\u007f-\u009f]/.test(name),
    { message: 'Vault name must not contain slashes or control characters.' },
  );
const vaultSchema = z.strictObject({ name: vaultNameSchema, syncMode: z.enum(['tephra', 'obsidian']).default('tephra') });
const deleteVaultSchema = z.strictObject({ confirmation: z.string().max(200) });

function isVaultNameConflict(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const record = error as { code?: unknown; message?: unknown };
  // node:sqlite surfaces UNIQUE violations as ERR_SQLITE_ERROR with
  // "UNIQUE constraint failed: vaults.name"; other drivers use
  // SQLITE_CONSTRAINT_UNIQUE. Match on the vaults.name target in both.
  if (typeof record.message === 'string' && record.message.includes('vaults.name'))
    return true;
  return (
    typeof record.code === 'string' &&
    (record.code === 'SQLITE_CONSTRAINT_UNIQUE' ||
      record.code === 'SQLITE_CONSTRAINT_PRIMARYKEY')
  );
}

async function publicVault(vault: Vault, dependencies: ApiDependencies) {
  if (vault.syncMode !== 'obsidian') return vault;
  const settings = (await dependencies.database.obsidianSync.find(vault.id)) ?? initialObsidianSettings(vault.id);
  return {
    ...vault,
    readOnly: !dependencies.obsidianSync || !settings.enabled || settings.phase !== 'running' || settings.mode !== 'bidirectional',
    obsidianSync: {
      enabled: settings.enabled,
      phase: dependencies.obsidianSync ? settings.phase : 'unavailable' as const,
      lastErrorCode: settings.lastErrorCode,
      lastSyncedAt: settings.lastSyncedAt,
    },
  };
}

export function registerVaultListRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  app.get('/api/v1/vaults', async (c) => {
    const principal = requireSession(c);
    return c.json({ vaults: await Promise.all((await dependencies.database.vaults.listByOwner(principal.user.id)).map(vault => publicVault(vault, dependencies))) });
  });
  app.post('/api/v1/vaults', async (c) => {
    const principal = requireSession(c);
    const body = await jsonBody(c, vaultSchema);
    const now = dependencies.clock.now();
    const vault = {
      id: dependencies.ids.generate(),
      ownerUserId: principal.user.id,
      name: body.name,
      syncMode: body.syncMode,
      latestRevision: 0,
      createdAt: now,
      updatedAt: now,
    };
    if ((await dependencies.database.vaults.findByName(vault.name)) !== null)
      fail(409, 'VAULT_NAME_TAKEN', 'A vault with this name already exists.');
    try {
      const native = vault.syncMode === 'obsidian' ? requireObsidianService(dependencies) : undefined;
      const account = native ? await native.accountStatus(principal.user.id) : undefined;
      await dependencies.database.transaction(async repositories => {
        await repositories.vaults.insert(vault);
        if (native) await repositories.obsidianSync.upsert({ ...initialObsidianSettings(vault.id), ...(account?.authenticated ? { phase: 'pending-remote' as const } : {}) });
      });
    } catch (error) {
      if (isVaultNameConflict(error))
        fail(409, 'VAULT_NAME_TAKEN', 'A vault with this name already exists.');
      throw error;
    }
    return c.json({ vault: await publicVault(vault, dependencies) }, 201);
  });
}

export function registerVaultRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  app.get('/api/v1/vaults/:vaultId', async (c) =>
    c.json({ vault: await publicVault(await ownedVault(c, dependencies, 'vault:read-metadata'), dependencies) }),
  );
  app.delete('/api/v1/vaults/:vaultId', async (c) => {
    requireSession(c);
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const body = await jsonBody(c, deleteVaultSchema);
    if (body.confirmation !== vault.name)
      fail(400, 'VAULT_NAME_MISMATCH', 'Vault name confirmation does not match.');
    if (vault.syncMode === 'obsidian') await requireObsidianService(dependencies).remove(vault);
    await dependencies.database.vaults.delete(vault.id);
    return c.body(null, 204);
  });

}
