import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { openSqliteDatabase, type SqliteDatabase } from '../src/index.js';
import type { NoteLink, NoteMetadata } from '@tephra/vault-model';

const directories: string[] = [];
const databases: SqliteDatabase[] = [];

async function database(): Promise<{ db: SqliteDatabase; filename: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'tephra-sqlite-'));
  directories.push(directory);
  const filename = join(directory, 'tephra.db');
  const db = openSqliteDatabase(filename);
  databases.push(db);
  return { db, filename };
}

async function seed(db: SqliteDatabase): Promise<void> {
  await db.users.insert({ id: 'user-1', email: 'one@example.com', passwordHash: null, createdAt: 1, updatedAt: 1 });
  await db.vaults.insert({ id: 'vault-1', ownerUserId: 'user-1', name: 'Vault', latestRevision: 0, createdAt: 2, updatedAt: 2 });
  await db.devices.insert({ id: 'device-1', userId: 'user-1', name: 'Phone', platform: 'mobile', createdAt: 3, lastSeenAt: 3 });
  await db.blobs.insert({ hash: 'a'.repeat(64), size: 5, mimeType: 'text/markdown', createdAt: 4 });
}

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('SQLite database adapter', () => {
  it('implements repositories and persists data after reopening', async () => {
    const { db, filename } = await database();
    await seed(db);
    await db.sessions.insert({ id: 'session-1', userId: 'user-1', expiresAt: 10, createdAt: 4 });
    await db.apiTokens.insert({ id: 'token-1', userId: 'user-1', vaultId: 'vault-1', deviceId: 'device-1', tokenHash: 'secret-hash', name: 'Sync', scopes: ['vault:upload', 'vault:read-metadata'], createdAt: 5, lastUsedAt: null, expiresAt: null, revokedAt: null });
    await db.vaultRevisions.insert({ vaultId: 'vault-1', revision: 1, manifestHash: 'manifest-1', deviceId: 'device-1', createdAt: 6 });
    await db.vaultFiles.upsert({ fileId: 'file-1', vaultId: 'vault-1', path: 'Note.md', blobHash: 'a'.repeat(64), size: 5, mtime: 7, mimeType: 'text/markdown', kind: 'markdown', updatedRevision: 1 });
    await db.fileVersions.insertMany([{ id: 'version-1', vaultId: 'vault-1', fileId: 'file-1', revision: 1, path: 'Note.md', blobHash: 'a'.repeat(64), size: 5, mtime: 7, changeType: 'create', createdAt: 6 }]);

    const metadata: NoteMetadata = { fileId: 'file-1', vaultId: 'vault-1', indexedBlobHash: 'a'.repeat(64), title: 'Note', frontmatter: { nested: { enabled: true }, count: 2 }, headings: [{ text: 'Title' }], tags: ['one', 'two'], blocks: [{ id: 'block' }], indexedAt: 8 };
    await db.noteIndex.upsertMetadata(metadata);
    const link: NoteLink = { id: 'link-1', vaultId: 'vault-1', sourceFileId: 'file-1', rawText: '[[Note]]', linkPath: 'Note', subpath: null, displayText: null, isEmbed: false, targetFileId: 'file-1', createdAt: 8 };
    await db.noteIndex.replaceLinksForSource('vault-1', 'file-1', [link]);
    await db.noteIndex.setState({ vaultId: 'vault-1', indexedRevision: 1, lastError: null });

    expect(await db.users.count()).toBe(1);
    expect(await db.users.findByEmail('one@example.com')).toMatchObject({ id: 'user-1' });
    expect(await db.sessions.findById('session-1')).not.toBeNull();
    expect(await db.vaults.listByOwner('user-1')).toHaveLength(1);
    expect(await db.devices.listByUser('user-1')).toEqual([expect.objectContaining({ platform: 'mobile' })]);
    expect((await db.apiTokens.findByTokenHash('secret-hash'))?.scopes).toEqual(['vault:upload', 'vault:read-metadata']);
    expect(await db.blobs.findByHashes(['missing', 'a'.repeat(64)])).toHaveLength(1);
    expect(await db.vaultFiles.findByPath('vault-1', 'Note.md')).toMatchObject({ fileId: 'file-1' });
    expect(await db.vaultRevisions.findLatest('vault-1')).toMatchObject({ revision: 1 });
    expect(await db.vaultRevisions.findByManifestHash('vault-1', 'manifest-1')).not.toBeNull();
    expect(await db.fileVersions.listByFile('vault-1', 'file-1')).toHaveLength(1);
    expect(await db.noteIndex.findMetadata('file-1')).toEqual(metadata);
    expect(await db.noteIndex.listLinksBySource('vault-1', 'file-1')).toEqual([link]);
    expect(await db.noteIndex.listLinksByTarget('vault-1', 'file-1')).toEqual([link]);
    expect(await db.noteIndex.getState('vault-1')).toEqual({ vaultId: 'vault-1', indexedRevision: 1, lastError: null });

    db.close();
    databases.splice(databases.indexOf(db), 1);
    const reopened = openSqliteDatabase(filename);
    databases.push(reopened);
    expect(await reopened.users.findById('user-1')).toMatchObject({ email: 'one@example.com' });
    expect(await reopened.noteIndex.listMetadata('vault-1')).toEqual([metadata]);
    expect(await reopened.vaultRevisions.list('vault-1')).toHaveLength(1);
  });

  it('rolls back the complete async transaction and enforces foreign keys', async () => {
    const { db } = await database();
    await expect(db.transaction(async (repositories) => {
      await repositories.users.insert({ id: 'rollback', email: 'rollback@example.com', passwordHash: null, createdAt: 1, updatedAt: 1 });
      await Promise.resolve();
      throw new Error('fail');
    })).rejects.toThrow('fail');
    expect(await db.users.findById('rollback')).toBeNull();
    await expect(db.sessions.insert({ id: 'orphan', userId: 'missing', expiresAt: 1, createdAt: 1 })).rejects.toThrow();
  });

  it('enforces unique identities, paths, token hashes, and manifests', async () => {
    const { db } = await database();
    await seed(db);
    await expect(db.users.insert({ id: 'user-2', email: 'one@example.com', passwordHash: null, createdAt: 1, updatedAt: 1 })).rejects.toThrow();
    await db.apiTokens.insert({ id: 'token-1', userId: 'user-1', vaultId: 'vault-1', deviceId: null, tokenHash: 'same', name: 'One', scopes: [], createdAt: 1, lastUsedAt: null, expiresAt: null, revokedAt: null });
    await expect(db.apiTokens.insert({ id: 'token-2', userId: 'user-1', vaultId: 'vault-1', deviceId: null, tokenHash: 'same', name: 'Two', scopes: [], createdAt: 1, lastUsedAt: null, expiresAt: null, revokedAt: null })).rejects.toThrow();
    await db.vaultFiles.upsert({ fileId: 'file-1', vaultId: 'vault-1', path: 'same.md', blobHash: 'a'.repeat(64), size: 5, mtime: 1, kind: 'markdown', updatedRevision: 1 });
    await expect(db.vaultFiles.upsert({ fileId: 'file-2', vaultId: 'vault-1', path: 'same.md', blobHash: 'a'.repeat(64), size: 5, mtime: 1, kind: 'markdown', updatedRevision: 1 })).rejects.toThrow();
    await db.vaultRevisions.insert({ vaultId: 'vault-1', revision: 1, manifestHash: 'same-manifest', deviceId: 'device-1', createdAt: 1 });
    await expect(db.vaultRevisions.insert({ vaultId: 'vault-1', revision: 2, manifestHash: 'same-manifest', deviceId: 'device-1', createdAt: 2 })).rejects.toThrow();
  });

  it('serializes vault transactions', async () => {
    const { db } = await database();
    await seed(db);
    const events: string[] = [];
    let release!: () => void;
    let markStarted!: () => void;
    const pause = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const first = db.transaction(async (repositories) => {
      await repositories.lockVault('vault-1');
      events.push('first-start');
      markStarted();
      await pause;
      events.push('first-end');
    });
    const second = db.transaction(async (repositories) => {
      await repositories.lockVault('vault-1');
      events.push('second');
    });
    await started;
    expect(events).toEqual(['first-start']);
    release();
    await Promise.all([first, second]);
    expect(events).toEqual(['first-start', 'first-end', 'second']);
  });

  it('deletes expired sessions and replaces note links atomically inside a transaction', async () => {
    const { db } = await database();
    await seed(db);
    await db.sessions.insert({ id: 'old', userId: 'user-1', expiresAt: 5, createdAt: 1 });
    await db.sessions.insert({ id: 'new', userId: 'user-1', expiresAt: 15, createdAt: 1 });
    expect(await db.sessions.deleteExpired(5)).toBe(1);
    expect(await db.sessions.findById('new')).not.toBeNull();
  });

  it('lists only old blobs that are unreferenced by files or versions', async () => {
    const { db } = await database();
    await seed(db);
    const referenced = 'b'.repeat(64);
    const oldOrphan = 'c'.repeat(64);
    const recentOrphan = 'd'.repeat(64);
    const versionOnly = 'e'.repeat(64);
    await db.blobs.insert({ hash: referenced, size: 1, mimeType: null, createdAt: 10 });
    await db.blobs.insert({ hash: oldOrphan, size: 1, mimeType: null, createdAt: 10 });
    await db.blobs.insert({ hash: recentOrphan, size: 1, mimeType: null, createdAt: 100 });
    await db.blobs.insert({ hash: versionOnly, size: 1, mimeType: null, createdAt: 10 });
    await db.vaultFiles.upsert({ fileId: 'file-1', vaultId: 'vault-1', path: 'Note.md', blobHash: referenced, size: 1, mtime: 1, kind: 'markdown', updatedRevision: 1 });
    await db.vaultRevisions.insert({ vaultId: 'vault-1', revision: 1, manifestHash: 'manifest-1', deviceId: 'device-1', createdAt: 11 });
    await db.fileVersions.insertMany([{ id: 'version-1', vaultId: 'vault-1', fileId: 'file-9', revision: 1, path: 'Old.md', blobHash: versionOnly, size: 1, mtime: 1, changeType: 'create', createdAt: 11 }]);

    // Cutoff 50: 'a' (seeded orphan, created_at 4) and the old orphan qualify;
    // current-file, version-only, and recent blobs are excluded.
    expect((await db.blobs.findUnreferencedOlderThan(50, 10)).map((item) => item.hash)).toEqual([
      'a'.repeat(64),
      oldOrphan,
    ]);
    expect((await db.blobs.findUnreferencedOlderThan(50, 1)).map((item) => item.hash)).toEqual(['a'.repeat(64)]);
    expect(await db.blobs.findUnreferencedOlderThan(50, 0)).toEqual([]);
    expect(await db.blobs.findUnreferencedOlderThan(4, 10)).toEqual([]);
  });
});
