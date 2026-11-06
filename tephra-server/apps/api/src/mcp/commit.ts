import { requireObsidianService } from '../routes/obsidian-sync.js';
import { hashManifest, sha256Hex } from '@tephra/protocol';
import { diffRevision, type CurrentVaultFile, type Vault } from '@tephra/vault-model';
import { fail } from '../http/errors.js';
import { DEFAULT_BLOB_LIMIT, storeBlobIfAbsent } from '../http/blob-write.js';
import type { ApiDependencies } from '../http/types.js';

export type NoteCommitResult =
  | { status: 'committed' | 'up-to-date'; revision: number; file: CurrentVaultFile }
  | { status: 'conflict'; current: CurrentVaultFile }
  | { status: 'exists'; current: CurrentVaultFile };

type Plan =
  | { kind: 'create'; path: string }
  | { kind: 'update'; fileId: string; baseHash: string };

/**
 * Commits one Markdown note as exactly one vault revision, mirroring the web
 * edit path (server-computed hash, vault lock, `diffRevision` ledger row).
 */
export async function commitNote(
  dependencies: ApiDependencies,
  input: { vault: Vault; userId: string; plan: Plan; text: string },
): Promise<NoteCommitResult> {
  if (input.vault.syncMode === 'obsidian') return requireObsidianService(dependencies).writeNote(input.vault, input.plan, input.text);
  const bytes = new TextEncoder().encode(input.text);
  if (bytes.byteLength > (dependencies.maxBlobBytes ?? DEFAULT_BLOB_LIMIT))
    fail(413, 'BLOB_TOO_LARGE', 'Content exceeds the configured size limit.');
  const hash = await sha256Hex(bytes);
  const { vault, plan } = input;
  if (plan.kind === 'update') {
    const pre = await dependencies.database.vaultFiles.findById(vault.id, plan.fileId);
    if (pre && pre.blobHash === hash && pre.blobHash === plan.baseHash)
      return { status: 'up-to-date', revision: vault.latestRevision, file: pre };
  }
  await storeBlobIfAbsent(dependencies, { hash, bytes, mimeType: 'text/markdown; charset=utf-8' });

  const result = await dependencies.database.transaction(async (repositories) => {
    await repositories.lockVault(vault.id);
    const fresh = await repositories.vaults.findById(vault.id);
    if (!fresh) fail(404, 'VAULT_NOT_FOUND', 'Vault was not found.');
    const files = await repositories.vaultFiles.listByVault(vault.id);
    const now = dependencies.clock.now();
    let target: CurrentVaultFile;
    if (plan.kind === 'create') {
      const lower = plan.path.toLowerCase();
      const clash = files.find((file) => file.path.toLowerCase() === lower);
      if (clash) return { status: 'exists' as const, current: clash };
      target = {
        fileId: dependencies.ids.generate(),
        vaultId: vault.id,
        path: plan.path,
        blobHash: hash,
        size: bytes.byteLength,
        mtime: now,
        mimeType: 'text/markdown',
        kind: 'markdown',
        updatedRevision: fresh.latestRevision + 1,
      };
    } else {
      const current = files.find((file) => file.fileId === plan.fileId);
      if (!current) fail(404, 'VAULT_NOT_FOUND', 'File was not found.');
      if (current.blobHash !== plan.baseHash) return { status: 'conflict' as const, current };
      target = {
        ...current,
        blobHash: hash,
        size: bytes.byteLength,
        mtime: Math.max(now, current.mtime + 1),
        updatedRevision: fresh.latestRevision + 1,
      };
    }
    const revision = fresh.latestRevision + 1;
    const deviceId = `mcp:${input.userId}`;
    if ((await repositories.devices.findById(deviceId)) === null) {
      await repositories.devices.insert({
        id: deviceId,
        userId: input.userId,
        name: 'Tephra MCP',
        platform: 'mcp',
        createdAt: now,
        lastSeenAt: now,
      });
    }
    const toEntry = (file: CurrentVaultFile) => ({
      fileId: file.fileId,
      path: file.path,
      blobHash: file.blobHash,
      size: file.size,
      mtime: file.mtime,
      ...(file.mimeType === undefined ? {} : { mimeType: file.mimeType }),
      kind: file.kind,
    });
    const incoming = [
      ...files.filter((file) => file.fileId !== target.fileId).map(toEntry),
      toEntry(target),
    ];
    const diff = diffRevision({
      vaultId: vault.id,
      revision,
      createdAt: now,
      current: files,
      incoming,
      ids: dependencies.ids,
    });
    await repositories.vaultRevisions.insert({
      vaultId: vault.id,
      revision,
      manifestHash: await hashManifest(
        incoming.map(({ blobHash, ...entry }) => ({ ...entry, hash: blobHash })),
      ),
      deviceId,
      createdAt: now,
    });
    if (diff.versions.length) await repositories.fileVersions.insertMany(diff.versions);
    await repositories.vaultFiles.upsert(target);
    await repositories.vaults.update({ ...fresh, latestRevision: revision, updatedAt: now });
    return { status: 'committed' as const, revision, file: target };
  });

  if (result.status === 'committed') {
    await dependencies.database.graphCache.deleteByVault(vault.id).catch(() => undefined);
    if (dependencies.indexService?.indexVault)
      void dependencies.indexService.indexVault(vault.id, result.revision).catch(() => undefined);
  }
  return result;
}
