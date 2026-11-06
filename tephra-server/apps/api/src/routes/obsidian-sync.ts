import { z } from 'zod';
import { ownedVault, requireSession } from '../http/auth.js';
import { jsonBody } from '../http/body.js';
import { fail } from '../http/errors.js';
import type { ApiApp, ApiDependencies } from '../http/types.js';
import type { ObsidianSyncService } from '../obsidian/types.js';

const loginSchema = z.strictObject({
  email: z.email().max(320),
  password: z.string().min(1).max(4096),
  mfa: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
const setupSchema = z.strictObject({
  remoteVaultId: z.string().min(1).max(256),
  encryptionPassword: z.string().max(4096).optional(),
  mode: z.enum(['bidirectional', 'pull-only']).default('bidirectional'),
});
const enabledSchema = z.strictObject({ enabled: z.boolean() });

export function requireObsidianService(dependencies: ApiDependencies): ObsidianSyncService {
  if (!dependencies.obsidianSync)
    fail(503, 'OBSIDIAN_UNAVAILABLE', 'Obsidian Sync is disabled on this server.');
  return dependencies.obsidianSync;
}

export function registerObsidianCapabilityRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  app.get('/api/v1/obsidian-sync', (c) => {
    requireSession(c);
    return c.json({ available: Boolean(dependencies.obsidianSync) });
  });
  app.get('/api/v1/obsidian-sync/account', async (c) => {
    const principal = requireSession(c);
    return c.json({ account: await requireObsidianService(dependencies).accountStatus(principal.user.id) });
  });
  app.post('/api/v1/obsidian-sync/account/login', async (c) => {
    const principal = requireSession(c);
    return c.json({ account: await requireObsidianService(dependencies).accountLogin(principal.user.id, await jsonBody(c, loginSchema)) });
  });
}
export function registerObsidianSyncRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  const owner = async (c: Parameters<typeof requireSession>[0]) => {
    requireSession(c);
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    if (vault.syncMode !== 'obsidian')
      fail(
        409,
        'VAULT_SYNC_MODE_MISMATCH',
        'This vault uses the Tephra sync plugin and its sync method is fixed. Create a new Obsidian Sync vault on the vaults page.',
      );
    return vault;
  };
  const base = '/api/v1/vaults/:vaultId/obsidian-sync';
  app.get(base, async (c) => {
    const vault = await owner(c);
    return c.json({ settings: await requireObsidianService(dependencies).status(vault) });
  });
  app.post(`${base}/login`, async (c) => {
    const vault = await owner(c);
    await requireObsidianService(dependencies).login(vault, await jsonBody(c, loginSchema));
    return c.json({ settings: await requireObsidianService(dependencies).status(vault) });
  });
  app.get(`${base}/remotes`, async (c) => {
    const vault = await owner(c);
    return c.json({ vaults: await requireObsidianService(dependencies).remotes(vault) });
  });
  app.post(`${base}/setup`, async (c) => {
    const vault = await owner(c);
    await requireObsidianService(dependencies).setup(vault, await jsonBody(c, setupSchema));
    return c.json({ settings: await requireObsidianService(dependencies).status(vault) }, 202);
  });
  app.put(base, async (c) => {
    const vault = await owner(c);
    const { enabled } = await jsonBody(c, enabledSchema);
    await requireObsidianService(dependencies).enable(vault, enabled);
    return c.json({ settings: await requireObsidianService(dependencies).status(vault) });
  });
}
