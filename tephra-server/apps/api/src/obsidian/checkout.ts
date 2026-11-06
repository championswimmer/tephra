import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, realpath, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isCanonicalVaultPath, hashManifest, sha256Hex } from '@tephra/protocol';
import { diffRevision, type IncomingVaultFile, type Vault } from '@tephra/vault-model';
import { DEFAULT_BLOB_LIMIT, storeBlobIfAbsent } from '../http/blob-write.js';
import type { ApiDependencies } from '../http/types.js';
import { fail } from '../http/errors.js';
import { nativeFailure, type VaultPaths } from './cli.js';

export function visibleVaultPath(path: string): boolean {
  return isCanonicalVaultPath(path) && path.split('/').every((part) => !part.startsWith('.'));
}

export async function safeDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw nativeFailure('OBSIDIAN_SYNC_FAILED');
}

/** Refuses symlinks at every component, including the checkout root. */
export async function confinedPath(
  root: string,
  path: string,
  createParents = false,
): Promise<string> {
  if (!visibleVaultPath(path))
    fail(400, 'INVALID_PATH', 'A visible canonical vault path is required.');
  await safeDirectory(root);
  const actualRoot = await realpath(root);
  let current = root;
  const parts = path.split('/');
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (createParents)
      await mkdir(current, { recursive: false, mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      });
    await safeDirectory(current);
    if (!(await realpath(current)).startsWith(actualRoot + sep))
      throw nativeFailure('OBSIDIAN_SYNC_FAILED');
  }
  const destination = resolve(root, ...parts);
  if (!destination.startsWith(resolve(root) + sep)) throw nativeFailure('OBSIDIAN_SYNC_FAILED');
  try {
    const info = await lstat(destination);
    if (!info.isFile() || info.isSymbolicLink()) throw nativeFailure('OBSIDIAN_SYNC_FAILED');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return destination;
}

async function readStableFile(
  root: string,
  path: string,
  maxBytes: number,
): Promise<{ bytes: Uint8Array; mtime: number }> {
  const destination = await confinedPath(root, path);
  const handle = await open(destination, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw nativeFailure('OBSIDIAN_SYNC_FAILED');
    // Bounded read even if another writer grows a file between stat/read.
    const bytes = new Uint8Array(before.size);
    let offset = 0;
    while (offset < bytes.length) {
      const result = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (result.bytesRead === 0) throw nativeFailure('OBSIDIAN_SYNC_FAILED');
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const current = await lstat(destination);
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      current.ino !== after.ino ||
      current.isSymbolicLink()
    )
      throw nativeFailure('OBSIDIAN_SYNC_FAILED');
    return { bytes, mtime: Math.max(0, Math.floor(after.mtimeMs)) };
  } finally {
    await handle.close();
  }
}

type ScannedFile = { path: string; bytes: Uint8Array; mtime: number };

async function visitCheckout(
  root: string,
  maxBytes: number,
  visit: (file: ScannedFile) => Promise<void>,
): Promise<void> {
  const walk = async (directory: string, prefix: string) => {
    await safeDirectory(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = prefix + entry.name;
      if (!visibleVaultPath(path) || entry.isSymbolicLink())
        throw nativeFailure('OBSIDIAN_SYNC_FAILED');
      if (entry.isDirectory()) await walk(join(directory, entry.name), path + '/');
      else if (entry.isFile())
        await visit({ path, ...(await readStableFile(root, path, maxBytes)) });
      else throw nativeFailure('OBSIDIAN_SYNC_FAILED');
    }
  };
  await walk(root, '');
}

export async function scanCheckout(root: string, maxBytes: number): Promise<ScannedFile[]> {
  const result: ScannedFile[] = [];
  await visitCheckout(root, maxBytes, async (file) => {
    result.push(file);
  });
  return result;
}

/** Complete scan before any ledger deletion; immutable blob writes may safely be orphaned on failure. */
export async function importCheckout(
  dependencies: ApiDependencies,
  vault: Vault,
  paths: VaultPaths,
): Promise<number> {
  const previous = new Map(
    (await dependencies.database.vaultFiles.listByVault(vault.id)).map((file) => [file.path, file]),
  );
  const incoming: IncomingVaultFile[] = [];
  // Retain at most one file body in memory while scanning large vaults.
  await visitCheckout(
    paths.vault,
    dependencies.maxBlobBytes ?? DEFAULT_BLOB_LIMIT,
    async (entry) => {
      const blobHash = await sha256Hex(entry.bytes);
      const old = previous.get(entry.path);
      const kind = /\.md$/i.test(entry.path) ? 'markdown' : 'attachment';
      const mimeType = kind === 'markdown' ? 'text/markdown' : attachmentMime(entry.path);
      await storeBlobIfAbsent(dependencies, { hash: blobHash, bytes: entry.bytes, mimeType });
      incoming.push({
        fileId: old?.fileId ?? dependencies.ids.generate(),
        path: entry.path,
        blobHash,
        size: entry.bytes.byteLength,
        mtime: old?.blobHash === blobHash ? old.mtime : entry.mtime,
        kind,
        mimeType,
      });
    },
  );
  const result = await dependencies.database.transaction(async (repositories) => {
    await repositories.lockVault(vault.id);
    const fresh = await repositories.vaults.findById(vault.id);
    if (!fresh || fresh.syncMode !== 'obsidian') throw nativeFailure('OBSIDIAN_SYNC_FAILED');
    const current = await repositories.vaultFiles.listByVault(vault.id);
    const next = fresh.latestRevision + 1;
    const now = dependencies.clock.now();
    const diff = diffRevision({
      vaultId: vault.id,
      revision: next,
      createdAt: now,
      current,
      incoming,
      ids: dependencies.ids,
    });
    if (diff.isNoOp) return { revision: fresh.latestRevision, changed: false };
    const deviceId = `obsidian:${vault.id}`;
    if (!(await repositories.devices.findById(deviceId)))
      await repositories.devices.insert({
        id: deviceId,
        userId: fresh.ownerUserId,
        name: 'Obsidian Sync',
        platform: 'obsidian-headless',
        createdAt: now,
        lastSeenAt: now,
      });
    await repositories.vaultRevisions.insert({
      vaultId: vault.id,
      revision: next,
      deviceId,
      manifestHash: await hashManifest(
        incoming.map(({ blobHash: hash, ...entry }) => ({ ...entry, hash })),
      ),
      createdAt: now,
    });
    await repositories.fileVersions.insertMany(diff.versions);
    const ids = new Set(incoming.map((file) => file.fileId));
    for (const file of current)
      if (!ids.has(file.fileId)) await repositories.vaultFiles.delete(vault.id, file.fileId);
    for (const file of incoming)
      await repositories.vaultFiles.upsert({ ...file, vaultId: vault.id, updatedRevision: next });
    await repositories.vaults.update({ ...fresh, latestRevision: next, updatedAt: now });
    return { revision: next, changed: true };
  });
  const { revision } = result;
  if (result.changed) await dependencies.database.graphCache.deleteByVault(vault.id);
  const indexState = await dependencies.database.noteIndex.getState(vault.id);
  if (indexState?.indexedRevision !== revision && dependencies.indexService?.indexVault)
    await dependencies.indexService.indexVault(vault.id, revision);
  return revision;
}

function attachmentMime(path: string): string {
  const ext = path.split('.').at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    wav: 'audio/wav',
    mp4: 'video/mp4',
    webm: 'video/webm',
  };
  return (ext && types[ext]) || 'application/octet-stream';
}

export async function atomicNoteWrite(
  paths: VaultPaths,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  const destination = await confinedPath(paths.vault, path, true);
  await safeDirectory(paths.tmp);
  const temporary = join(paths.tmp, randomUUID());
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await confinedPath(paths.vault, path);
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true });
  }
  // Both directories must be on the same persistent filesystem (rename is atomic).
  const directory = await open(dirname(destination), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
