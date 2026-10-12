import { z } from 'zod';
import { hashManifest, sha256Hex, sha256Schema } from '@tephra/protocol';
import { diffRevision } from '@tephra/vault-model';
import { fail } from '../http/errors.js';
import { ownedVault } from '../http/auth.js';
import { DEFAULT_BLOB_LIMIT, storeBlobIfAbsent } from '../http/blob-write.js';
import type { ApiApp, ApiDependencies } from '../http/types.js';


/**
 * Parses the If-Match precondition for the web content write endpoint. The
 * client must state the blob hash it based its edit on, either bare or
 * wrapped as `<hash>` (a quoted `"<hash>"` is accepted for tolerance);
 * a missing or malformed value is a 400, never an unconditional overwrite.
 */
function parseIfMatch(header: string | undefined): string {
  if (header === undefined)
    fail(400, 'INVALID_MANIFEST', 'An If-Match header with the base content hash is required.');
  let value = header.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"'))
    value = value.slice(1, -1);
  try {
    return sha256Schema.parse(value);
  } catch {
    fail(400, 'INVALID_MANIFEST', 'If-Match must be a SHA-256 hash of the base content.');
  }
}

export function registerWebEditRoutes(app: ApiApp, dependencies: ApiDependencies): void {
  // Web editing write path (plan 017, Phase 2): one saved markdown file
  // becomes one server revision in the same file_versions ledger plugin
  // commits use. Optimistic concurrency via the required If-Match header.
  app.put('/api/v1/vaults/:vaultId/files/:fileId/content', async (c) => {
    const vault = await ownedVault(c, dependencies, 'vault:write');
    const fileId = z.string().min(1).parse(c.req.param('fileId'));
    // Pre-lock read is validation only; the authoritative read happens
    // inside the transaction after lockVault (step 6 of the plan).
    const preLock = await dependencies.database.vaultFiles.findById(vault.id, fileId);
    if (!preLock) fail(404, 'VAULT_NOT_FOUND', 'File was not found.');
    if (preLock.kind !== 'markdown')
      fail(400, 'INVALID_MANIFEST', 'Only Markdown files can be edited from the web.');
    const ifMatch = parseIfMatch(c.req.header('if-match'));
    const max = dependencies.maxBlobBytes ?? DEFAULT_BLOB_LIMIT;
    const declaredText = c.req.header('x-tephra-content-size');
    const declared =
      declaredText === undefined
        ? Number(c.req.header('content-length'))
        : Number(declaredText);
    if (!Number.isSafeInteger(declared) || declared < 0)
      fail(400, 'INVALID_MANIFEST', 'A valid content size is required.');
    if (declared > max) fail(413, 'BLOB_TOO_LARGE', 'Content exceeds the configured size limit.');
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength !== declared)
      fail(400, 'INVALID_MANIFEST', 'Uploaded size does not match the declared size.');
    if (bytes.byteLength > max)
      fail(413, 'BLOB_TOO_LARGE', 'Content exceeds the configured size limit.');
    // Server-computed digest (invariant I3): never trust a client digest.
    const hash = await sha256Hex(bytes);
    Object.assign(c.get('logContext'), {
      vault_id: vault.id,
      file_id: fileId,
      blob_hash: hash,
      content_bytes: bytes.byteLength,
    });
    // Byte-identical save (invariant I2): identical bytes hash identically,
    // so there is nothing to commit regardless of what the client sent.
    if (hash === preLock.blobHash) {
      Object.assign(c.get('logContext'), { revision: vault.latestRevision });
      return c.json({
        status: 'up-to-date',
        revision: vault.latestRevision,
        blobHash: hash,
        size: preLock.size,
        mtime: preLock.mtime,
      });
    }
    const mimeType = c.req.header('content-type');
    await storeBlobIfAbsent(dependencies, {
      hash,
      bytes,
      ...(mimeType === undefined ? {} : { mimeType }),
    });
    const principal = c.get('principal');
    const result = await dependencies.database.transaction(async (repositories) => {
      await repositories.lockVault(vault.id);
      const fresh = await repositories.vaults.findById(vault.id);
      if (!fresh) fail(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
      const current = await repositories.vaultFiles.findById(vault.id, fileId);
      if (!current) fail(404, 'VAULT_NOT_FOUND', 'File was not found.');
      if (current.kind !== 'markdown')
        fail(400, 'INVALID_MANIFEST', 'Only Markdown files can be edited from the web.');
      if (current.blobHash !== ifMatch) {
        return {
          status: 'conflict' as const,
          current: {
            blobHash: current.blobHash,
            size: current.size,
            mtime: current.mtime,
            revision: current.updatedRevision,
          },
        };
      }
      const now = dependencies.clock.now();
      // A web edit must strictly post-date the content it was based on so
      // the timestamp conflict rule cannot be inverted by a lagging clock.
      const mtime = Math.max(now, current.mtime + 1);
      // Synthetic web device: device_id is NOT NULL, and web saves have no
      // plugin device. Inserted idempotently on first web write per user.
      const deviceId = `web:${principal.user.id}`;
      if ((await repositories.devices.findById(deviceId)) === null) {
        await repositories.devices.insert({
          id: deviceId,
          userId: principal.user.id,
          name: 'Tephra Web',
          platform: 'web',
          createdAt: now,
          lastSeenAt: now,
        });
      }
      const files = await repositories.vaultFiles.listByVault(vault.id);
      const revision = fresh.latestRevision + 1;
      const incoming = files.map((entry) =>
        entry.fileId === fileId
          ? {
              fileId: entry.fileId,
              path: entry.path,
              blobHash: hash,
              size: bytes.byteLength,
              mtime,
              ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
              kind: entry.kind,
            }
          : {
              fileId: entry.fileId,
              path: entry.path,
              blobHash: entry.blobHash,
              size: entry.size,
              mtime: entry.mtime,
              ...(entry.mimeType === undefined ? {} : { mimeType: entry.mimeType }),
              kind: entry.kind,
            },
      );
      // The ledger row comes from the same diffRevision code path as a
      // plugin commit rather than a hand-written row: exactly one modify.
      const diff = diffRevision({
        vaultId: vault.id,
        revision,
        createdAt: now,
        current: files,
        incoming,
        ids: dependencies.ids,
      });
      // Reuse the canonical manifest hash so vault_revisions.manifest_hash
      // stays meaningful for both writers.
      const manifestHash = await hashManifest(
        incoming.map(({ blobHash, ...entry }) => ({ ...entry, hash: blobHash })),
      );
      await repositories.vaultRevisions.insert({
        vaultId: vault.id,
        revision,
        manifestHash,
        deviceId,
        createdAt: now,
      });
      if (diff.versions.length) await repositories.fileVersions.insertMany(diff.versions);
      await repositories.vaultFiles.upsert({
        fileId,
        vaultId: vault.id,
        path: current.path,
        blobHash: hash,
        size: bytes.byteLength,
        mtime,
        ...(current.mimeType === undefined ? {} : { mimeType: current.mimeType }),
        kind: current.kind,
        updatedRevision: revision,
      });
      await repositories.vaults.update({ ...fresh, latestRevision: revision, updatedAt: now });
      return { status: 'committed' as const, revision, size: bytes.byteLength, mtime };
    });
    if (result.status === 'conflict') {
      Object.assign(c.get('logContext'), { revision: result.current.revision });
      return c.json(
        {
          error: { code: 'EDIT_CONFLICT', message: 'The file changed since it was loaded.' },
          current: result.current,
        },
        409,
      );
    }
    // Same post-commit behaviour as a plugin commit: trigger indexing and
    // drop the materialized graph row (deleted first so no stale revision is
    // served; the index service rebuilds it for the new revision).
    await dependencies.database.graphCache.deleteByVault(vault.id).catch(() => undefined);
    if (dependencies.indexService?.indexVault) {
      void dependencies.indexService.indexVault(vault.id, result.revision).catch(() => undefined);
    }
    Object.assign(c.get('logContext'), { revision: result.revision });
    return c.json({
      status: 'committed',
      revision: result.revision,
      blobHash: hash,
      size: result.size,
      mtime: result.mtime,
    });
  });
}
