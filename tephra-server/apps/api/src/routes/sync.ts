import { z } from 'zod';
import { tokenIsActive } from '@tephra/auth';
import { sha256Hex, sha256Schema, syncCommitBodySchema, syncPlanBodySchema } from '@tephra/protocol';
import { diffRevision } from '@tephra/vault-model';
import { fail } from '../http/errors.js';
import { jsonBody } from '../http/body.js';
import { findVaultByIdOrName, ownedVault } from '../http/auth.js';
import { DEFAULT_BLOB_LIMIT, storeBlobIfAbsent } from '../http/blob-write.js';
import type { ApiApp, ApiDependencies } from '../http/types.js';
import { requireBlobs, syncProtocolFields, verifyManifest } from './sync-support.js';

export function registerSyncRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  app.post('/api/v1/vaults/:vaultId/sync/plan', async (c) => {
    const body = await jsonBody(c, syncPlanBodySchema);
    Object.assign(c.get('logContext'), {
      device_id: body.deviceId,
      manifest_hash: body.manifestHash,
      changed_file_count: body.files.length,
    });
    await verifyManifest(body.files, body.manifestHash);
    const vault = await ownedVault(c, dependencies, 'vault:upload');
    Object.assign(c.get('logContext'), { vault_id: vault.id });
    const existing = await dependencies.database.vaultRevisions.findByManifestHash(
      vault.id,
      body.manifestHash,
    );
    if (existing) {
      Object.assign(c.get('logContext'), { revision: existing.revision });
      return c.json({
        status: 'up-to-date',
        latestRevision: existing.revision,
        missingBlobs: [],
        ...syncProtocolFields(),
      });
    }
    const metadata = new Map(
      (await dependencies.database.blobs.findByHashes(body.files.map((file) => file.hash))).map(
        (blob) => [blob.hash, blob],
      ),
    );
    const missingBlobs = [];
    for (const file of new Map(body.files.map((entry) => [entry.hash, entry])).values()) {
      const blob = metadata.get(file.hash);
      if (!blob || blob.size !== file.size || !(await dependencies.blobStore.has(file.hash)))
        missingBlobs.push({ hash: file.hash, size: file.size });
    }
    Object.assign(c.get('logContext'), { revision: vault.latestRevision });
    return c.json({
      status: 'upload-required',
      latestRevision: vault.latestRevision,
      missingBlobs,
      ...syncProtocolFields(),
    });
  });

  app.put('/api/v1/vaults/:vaultId/blobs/:hash', async (c) => {
    const uploadVault = await ownedVault(c, dependencies, 'vault:upload');
    Object.assign(c.get('logContext'), { vault_id: uploadVault.id });
    const hash = sha256Schema.parse(c.req.param('hash'));
    const max = dependencies.maxBlobBytes ?? DEFAULT_BLOB_LIMIT;
    const declaredText = c.req.header('x-tephra-blob-size');
    const declared =
      declaredText === undefined ? Number(c.req.header('content-length')) : Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared < 0)
      fail(400, 'INVALID_MANIFEST', 'A valid blob size is required.');
    if (declared > max) fail(413, 'BLOB_TOO_LARGE', 'Blob exceeds the configured size limit.');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength !== declared)
      fail(400, 'BLOB_HASH_MISMATCH', 'Uploaded size does not match the declared size.');
    if (bytes.byteLength > max)
      fail(413, 'BLOB_TOO_LARGE', 'Blob exceeds the configured size limit.');
    if ((await sha256Hex(bytes)) !== hash)
      fail(400, 'BLOB_HASH_MISMATCH', 'Uploaded content does not match the declared SHA-256 hash.');
    const mimeType = c.req.header('content-type');
    const { stored } = await storeBlobIfAbsent(dependencies, {
      hash,
      bytes,
      ...(mimeType === undefined ? {} : { mimeType }),
    });
    Object.assign(c.get('logContext'), { uploaded_blob_count: stored ? 1 : 0 });
    return c.json({ hash, stored });
  });


  app.post('/api/v1/vaults/:vaultId/sync/commit', async (c) => {
    const body = await jsonBody(c, syncCommitBodySchema);
    const vaultIdOrName = z.string().min(1).parse(c.req.param('vaultId'));
    // Resolve the vault id before entering the transaction so plugin clients
    // bound to the internal id keep working while web URLs carry the name.
    const resolved = await findVaultByIdOrName(dependencies.database.vaults, vaultIdOrName);
    if (!resolved) fail(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
    const vaultId = resolved.id;
    Object.assign(c.get('logContext'), {
      vault_id: vaultId,
      device_id: body.deviceId,
      manifest_hash: body.manifestHash,
      changed_file_count: body.files.length,
    });
    await verifyManifest(body.files, body.manifestHash);
    const result = await dependencies.database.transaction(async (repositories) => {
      await repositories.lockVault(vaultId);
      const vault = await repositories.vaults.findById(vaultId);
      if (!vault) fail(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
      const principal = c.get('principal');
      if (principal.kind !== 'token')
        fail(403, 'VAULT_ACCESS_DENIED', 'An upload token is required.');
      const transactionToken = await repositories.apiTokens.findById(principal.token.id);
      if (
        !transactionToken ||
        !tokenIsActive(transactionToken, dependencies.clock.now()) ||
        transactionToken.vaultId !== vaultId ||
        !transactionToken.scopes.includes('vault:upload')
      ) {
        fail(403, 'VAULT_ACCESS_DENIED', 'Upload token cannot access this vault.');
      }
      const existing = await repositories.vaultRevisions.findByManifestHash(
        vaultId,
        body.manifestHash,
      );
      if (existing) {
        await repositories.apiTokens.update({
          ...transactionToken,
          lastUsedAt: dependencies.clock.now(),
        });
        return { status: 'up-to-date' as const, revision: existing.revision };
      }
      await requireBlobs(repositories, dependencies.blobStore, body.files);
      const now = dependencies.clock.now();
      const knownDevice = await repositories.devices.findById(body.deviceId);
      if (!knownDevice) {
        await repositories.devices.insert({
          id: body.deviceId,
          userId: transactionToken.userId,
          name: body.deviceId,
          createdAt: now,
          lastSeenAt: now,
        });
      } else {
        if (knownDevice.userId !== transactionToken.userId) {
          fail(403, 'VAULT_ACCESS_DENIED', 'Device belongs to another user.');
        }
        await repositories.devices.update({ ...knownDevice, lastSeenAt: now });
      }
      const current = await repositories.vaultFiles.listByVault(vaultId);
      const revision = vault.latestRevision + 1;
      const incoming = body.files.map(({ mimeType, ...file }) => ({
        ...file,
        blobHash: file.hash,
        ...(mimeType === undefined ? {} : { mimeType }),
      }));
      const diff = diffRevision({
        vaultId,
        revision,
        createdAt: now,
        current,
        incoming,
        ids: dependencies.ids,
      });
      await repositories.vaultRevisions.insert({
        vaultId,
        revision,
        manifestHash: body.manifestHash,
        deviceId: body.deviceId,
        createdAt: now,
      });
      if (diff.versions.length) await repositories.fileVersions.insertMany(diff.versions);
      for (const file of current)
        if (!body.files.some((incomingFile) => incomingFile.fileId === file.fileId))
          await repositories.vaultFiles.delete(vaultId, file.fileId);
      for (const file of body.files)
        await repositories.vaultFiles.upsert({
          fileId: file.fileId,
          vaultId,
          path: file.path,
          blobHash: file.hash,
          size: file.size,
          mtime: file.mtime,
          ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
          kind: file.kind,
          updatedRevision: revision,
        });
      await repositories.vaults.update({ ...vault, latestRevision: revision, updatedAt: now });
      await repositories.apiTokens.update({ ...transactionToken, lastUsedAt: now });
      return { status: 'committed' as const, revision };
    });
    if (result.status === 'committed' && dependencies.indexService?.indexVault) {
      void dependencies.indexService.indexVault(vaultId, result.revision).catch(() => undefined);
    }
    Object.assign(c.get('logContext'), { revision: result.revision });
    return c.json({ ...result, ...syncProtocolFields() });
  });
}
