import { z } from 'zod';
import { createOpaqueToken, hashOpaqueToken } from '@tephra/auth';
import { fail } from '../http/errors.js';
import { jsonBody } from '../http/body.js';
import { ownedVault, requireSession } from '../http/auth.js';
import type { ApiApp, ApiDependencies } from '../http/types.js';

const scopesSchema = z
  .array(z.enum(['vault:read-metadata', 'vault:upload', 'vault:write']))
  .min(1)
  .max(3);
const tokenSchema = z.strictObject({
  name: z.string().trim().min(1).max(200),
  deviceId: z.string().min(1).max(200).optional(),
  deviceName: z.string().trim().min(1).max(200).optional(),
  platform: z.string().max(100).optional(),
  scopes: scopesSchema.default(['vault:read-metadata', 'vault:upload']),
  expiresAt: z.number().int().positive().safe().nullable().default(null),
});

export function registerTokenRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  app.get('/api/v1/vaults/:vaultId/tokens', async (c) => {
    requireSession(c);
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const tokens = await dependencies.database.apiTokens.listByVault(vault.id);
    return c.json({
      tokens: tokens.map((token) => {
        const { tokenHash, ...publicToken } = token;
        void tokenHash;
        return publicToken;
      }),
    });
  });
  app.post('/api/v1/vaults/:vaultId/tokens', async (c) => {
    const principal = requireSession(c);
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const body = await jsonBody(c, tokenSchema);
    const now = dependencies.clock.now();
    let deviceId = body.deviceId ?? null;
    if (deviceId) {
      const existingDevice = await dependencies.database.devices.findById(deviceId);
      if (existingDevice) {
        if (existingDevice.userId !== principal.user.id) {
          fail(403, 'VAULT_ACCESS_DENIED', 'Device belongs to another user.');
        }
        await dependencies.database.devices.update({
          ...existingDevice,
          ...(body.deviceName ? { name: body.deviceName } : {}),
          ...(body.platform === undefined ? {} : { platform: body.platform }),
          lastSeenAt: now,
        });
      } else {
        await dependencies.database.devices.insert({
          id: deviceId,
          userId: principal.user.id,
          name: body.deviceName ?? deviceId,
          ...(body.platform === undefined ? {} : { platform: body.platform }),
          createdAt: now,
          lastSeenAt: now,
        });
      }
    } else if (body.deviceName) {
      deviceId = dependencies.ids.generate();
      await dependencies.database.devices.insert({
        id: deviceId,
        userId: principal.user.id,
        name: body.deviceName,
        ...(body.platform === undefined ? {} : { platform: body.platform }),
        createdAt: now,
        lastSeenAt: now,
      });
    }
    const raw = createOpaqueToken('tpt');
    const token = {
      id: dependencies.ids.generate(),
      userId: principal.user.id,
      vaultId: vault.id,
      deviceId,
      tokenHash: await hashOpaqueToken(raw),
      name: body.name,
      scopes: body.scopes,
      createdAt: now,
      lastUsedAt: null,
      expiresAt: body.expiresAt,
      revokedAt: null,
    };
    await dependencies.database.apiTokens.insert(token);
    return c.json(
      {
        token: { id: token.id, name: token.name, scopes: token.scopes, expiresAt: token.expiresAt },
        value: raw,
      },
      201,
    );
  });
  app.delete('/api/v1/vaults/:vaultId/tokens/:tokenId', async (c) => {
    requireSession(c);
    const vault = await ownedVault(c, dependencies, 'vault:read-metadata');
    const token = await dependencies.database.apiTokens.findById(c.req.param('tokenId'));
    if (!token || token.vaultId !== vault.id)
      fail(404, 'VAULT_NOT_FOUND', 'Token was not found.');
    await dependencies.database.apiTokens.update({ ...token, revokedAt: dependencies.clock.now() });
    return c.body(null, 204);
  });
}
