import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
  await db.users.insert({
    id: 'user-1',
    email: 'one@example.com',
    passwordHash: null,
    createdAt: 1,
    updatedAt: 1,
  });
  await db.vaults.insert({
    id: 'vault-1',
    ownerUserId: 'user-1',
    name: 'Vault',
    latestRevision: 0,
    createdAt: 2,
    updatedAt: 2,
  });
  await db.devices.insert({
    id: 'device-1',
    userId: 'user-1',
    name: 'Phone',
    platform: 'mobile',
    createdAt: 3,
    lastSeenAt: 3,
  });
  await db.blobs.insert({ hash: 'a'.repeat(64), size: 5, mimeType: 'text/markdown', createdAt: 4 });
}

afterEach(async () => {
  while (databases.length > 0) databases.pop()?.close();
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe('SQLite database adapter', () => {
  it('implements repositories and persists data after reopening', async () => {
    const { db, filename } = await database();
    await seed(db);
    await db.sessions.insert({ id: 'session-1', userId: 'user-1', expiresAt: 10, createdAt: 4 });
    await db.apiTokens.insert({
      id: 'token-1',
      userId: 'user-1',
      vaultId: 'vault-1',
      deviceId: 'device-1',
      tokenHash: 'secret-hash',
      name: 'Sync',
      scopes: ['vault:upload', 'vault:read-metadata'],
      createdAt: 5,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    await db.vaultRevisions.insert({
      vaultId: 'vault-1',
      revision: 1,
      manifestHash: 'manifest-1',
      deviceId: 'device-1',
      createdAt: 6,
    });
    await db.vaultFiles.upsert({
      fileId: 'file-1',
      vaultId: 'vault-1',
      path: 'Note.md',
      blobHash: 'a'.repeat(64),
      size: 5,
      mtime: 7,
      mimeType: 'text/markdown',
      kind: 'markdown',
      updatedRevision: 1,
    });
    await db.fileVersions.insertMany([
      {
        id: 'version-1',
        vaultId: 'vault-1',
        fileId: 'file-1',
        revision: 1,
        path: 'Note.md',
        blobHash: 'a'.repeat(64),
        size: 5,
        mtime: 7,
        changeType: 'create',
        createdAt: 6,
      },
    ]);

    const metadata: NoteMetadata = {
      fileId: 'file-1',
      vaultId: 'vault-1',
      indexedBlobHash: 'a'.repeat(64),
      title: 'Note',
      frontmatter: { nested: { enabled: true }, count: 2 },
      headings: [{ text: 'Title' }],
      tags: ['one', 'two'],
      blocks: [{ id: 'block' }],
      indexedAt: 8,
    };
    await db.noteIndex.upsertMetadata(metadata);
    const link: NoteLink = {
      id: 'link-1',
      vaultId: 'vault-1',
      sourceFileId: 'file-1',
      rawText: '[[Note]]',
      linkPath: 'Note',
      subpath: null,
      displayText: null,
      isEmbed: false,
      targetFileId: 'file-1',
      createdAt: 8,
    };
    await db.noteIndex.replaceLinksForSource('vault-1', 'file-1', [link]);
    await db.noteIndex.setState({ vaultId: 'vault-1', indexedRevision: 1, lastError: null });

    expect(await db.users.count()).toBe(1);
    expect(await db.users.findByEmail('one@example.com')).toMatchObject({ id: 'user-1' });
    expect(await db.sessions.findById('session-1')).not.toBeNull();
    expect(await db.vaults.listByOwner('user-1')).toHaveLength(1);
    expect(await db.devices.listByUser('user-1')).toEqual([
      expect.objectContaining({ platform: 'mobile' }),
    ]);
    expect((await db.apiTokens.findByTokenHash('secret-hash'))?.scopes).toEqual([
      'vault:upload',
      'vault:read-metadata',
    ]);
    expect(await db.blobs.findByHashes(['missing', 'a'.repeat(64)])).toHaveLength(1);
    expect(await db.vaultFiles.findByPath('vault-1', 'Note.md')).toMatchObject({
      fileId: 'file-1',
    });
    expect(await db.vaultRevisions.findLatest('vault-1')).toMatchObject({ revision: 1 });
    expect(await db.vaultRevisions.findByManifestHash('vault-1', 'manifest-1')).not.toBeNull();
    expect(await db.fileVersions.listByFile('vault-1', 'file-1')).toHaveLength(1);
    expect(await db.noteIndex.findMetadata('file-1')).toEqual(metadata);
    expect(await db.noteIndex.listLinksBySource('vault-1', 'file-1')).toEqual([link]);
    expect(await db.noteIndex.listLinksByTarget('vault-1', 'file-1')).toEqual([link]);
    expect(await db.noteIndex.getState('vault-1')).toEqual({
      vaultId: 'vault-1',
      indexedRevision: 1,
      lastError: null,
    });

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
    await expect(
      db.transaction(async (repositories) => {
        await repositories.users.insert({
          id: 'rollback',
          email: 'rollback@example.com',
          passwordHash: null,
          createdAt: 1,
          updatedAt: 1,
        });
        await Promise.resolve();
        throw new Error('fail');
      }),
    ).rejects.toThrow('fail');
    expect(await db.users.findById('rollback')).toBeNull();
    await expect(
      db.sessions.insert({ id: 'orphan', userId: 'missing', expiresAt: 1, createdAt: 1 }),
    ).rejects.toThrow();
  });

  it('enforces unique identities, paths, token hashes, and manifests', async () => {
    const { db } = await database();
    await seed(db);
    await expect(
      db.users.insert({
        id: 'user-2',
        email: 'one@example.com',
        passwordHash: null,
        createdAt: 1,
        updatedAt: 1,
      }),
    ).rejects.toThrow();
    await db.apiTokens.insert({
      id: 'token-1',
      userId: 'user-1',
      vaultId: 'vault-1',
      deviceId: null,
      tokenHash: 'same',
      name: 'One',
      scopes: [],
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    await expect(
      db.apiTokens.insert({
        id: 'token-2',
        userId: 'user-1',
        vaultId: 'vault-1',
        deviceId: null,
        tokenHash: 'same',
        name: 'Two',
        scopes: [],
        createdAt: 1,
        lastUsedAt: null,
        expiresAt: null,
        revokedAt: null,
      }),
    ).rejects.toThrow();
    await db.vaultFiles.upsert({
      fileId: 'file-1',
      vaultId: 'vault-1',
      path: 'same.md',
      blobHash: 'a'.repeat(64),
      size: 5,
      mtime: 1,
      kind: 'markdown',
      updatedRevision: 1,
    });
    await expect(
      db.vaultFiles.upsert({
        fileId: 'file-2',
        vaultId: 'vault-1',
        path: 'same.md',
        blobHash: 'a'.repeat(64),
        size: 5,
        mtime: 1,
        kind: 'markdown',
        updatedRevision: 1,
      }),
    ).rejects.toThrow();
    await db.vaultRevisions.insert({
      vaultId: 'vault-1',
      revision: 1,
      manifestHash: 'same-manifest',
      deviceId: 'device-1',
      createdAt: 1,
    });
    // Since 005 the manifest hash is a plain index, not UNIQUE: a later
    // revision may reproduce an earlier vault state (edit-then-revert), and
    // findByManifestHash resolves the duplicate to the newest revision.
    await db.vaultRevisions.insert({
      vaultId: 'vault-1',
      revision: 2,
      manifestHash: 'same-manifest',
      deviceId: 'device-1',
      createdAt: 2,
    });
    expect(await db.vaultRevisions.findByManifestHash('vault-1', 'same-manifest')).toMatchObject({
      revision: 2,
    });
  });

  it('enforces globally unique vault names case-sensitively and resolves by name', async () => {
    const { db } = await database();
    await seed(db);
    expect(await db.vaults.findByName('Vault')).toMatchObject({ id: 'vault-1' });
    expect(await db.vaults.findByName('vault')).toBeNull();
    expect(await db.vaults.findByName('Missing')).toBeNull();
    await expect(
      db.vaults.insert({
        id: 'vault-2',
        ownerUserId: 'user-1',
        name: 'Vault',
        latestRevision: 0,
        createdAt: 3,
        updatedAt: 3,
      }),
    ).rejects.toThrow();
    // Case variants are distinct names (BINARY collation).
    await db.vaults.insert({
      id: 'vault-3',
      ownerUserId: 'user-1',
      name: 'vault',
      latestRevision: 0,
      createdAt: 3,
      updatedAt: 3,
    });
    expect(await db.vaults.findByName('vault')).toMatchObject({ id: 'vault-3' });
  });

  it('cascades vault deletion to vault-scoped rows', async () => {
    const { db } = await database();
    await seed(db);
    await db.apiTokens.insert({
      id: 'token-1',
      userId: 'user-1',
      vaultId: 'vault-1',
      deviceId: 'device-1',
      tokenHash: 'secret-hash',
      name: 'Sync',
      scopes: ['vault:upload'],
      createdAt: 5,
      lastUsedAt: null,
      expiresAt: null,
      revokedAt: null,
    });
    await db.vaultRevisions.insert({
      vaultId: 'vault-1',
      revision: 1,
      manifestHash: 'manifest-1',
      deviceId: 'device-1',
      createdAt: 6,
    });
    await db.vaultFiles.upsert({
      fileId: 'file-1',
      vaultId: 'vault-1',
      path: 'Note.md',
      blobHash: 'a'.repeat(64),
      size: 5,
      mtime: 7,
      mimeType: 'text/markdown',
      kind: 'markdown',
      updatedRevision: 1,
    });
    await db.fileVersions.insertMany([
      {
        id: 'version-1',
        vaultId: 'vault-1',
        fileId: 'file-1',
        revision: 1,
        path: 'Note.md',
        blobHash: 'a'.repeat(64),
        size: 5,
        mtime: 7,
        changeType: 'create',
        createdAt: 6,
      },
    ]);
    await db.noteIndex.upsertMetadata({
      fileId: 'file-1',
      vaultId: 'vault-1',
      indexedBlobHash: 'a'.repeat(64),
      title: 'Note',
      frontmatter: {},
      headings: [],
      tags: [],
      blocks: [],
      indexedAt: 8,
    });
    await db.noteIndex.replaceLinksForSource('vault-1', 'file-1', [
      {
        id: 'link-1',
        vaultId: 'vault-1',
        sourceFileId: 'file-1',
        rawText: '[[Note]]',
        linkPath: 'Note',
        subpath: null,
        displayText: null,
        isEmbed: false,
        targetFileId: 'file-1',
        createdAt: 8,
      },
    ]);
    await db.noteIndex.setState({ vaultId: 'vault-1', indexedRevision: 1, lastError: null });

    await db.vaults.delete('vault-1');

    expect(await db.vaults.findById('vault-1')).toBeNull();
    expect(await db.apiTokens.findById('token-1')).toBeNull();
    expect(await db.vaultFiles.findById('vault-1', 'file-1')).toBeNull();
    expect(await db.vaultRevisions.findLatest('vault-1')).toBeNull();
    expect(await db.fileVersions.listByFile('vault-1', 'file-1')).toEqual([]);
    expect(await db.noteIndex.findMetadata('file-1')).toBeNull();
    expect(await db.noteIndex.listLinksBySource('vault-1', 'file-1')).toEqual([]);
    expect(await db.noteIndex.getState('vault-1')).toBeNull();
    expect(await db.blobs.findByHash('a'.repeat(64))).not.toBeNull();
  });

  it('serializes vault transactions', async () => {
    const { db } = await database();
    await seed(db);
    const events: string[] = [];
    let release!: () => void;
    let markStarted!: () => void;
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
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
    await db.vaultFiles.upsert({
      fileId: 'file-1',
      vaultId: 'vault-1',
      path: 'Note.md',
      blobHash: referenced,
      size: 1,
      mtime: 1,
      kind: 'markdown',
      updatedRevision: 1,
    });
    await db.vaultRevisions.insert({
      vaultId: 'vault-1',
      revision: 1,
      manifestHash: 'manifest-1',
      deviceId: 'device-1',
      createdAt: 11,
    });
    await db.fileVersions.insertMany([
      {
        id: 'version-1',
        vaultId: 'vault-1',
        fileId: 'file-9',
        revision: 1,
        path: 'Old.md',
        blobHash: versionOnly,
        size: 1,
        mtime: 1,
        changeType: 'create',
        createdAt: 11,
      },
    ]);

    // Cutoff 50: 'a' (seeded orphan, created_at 4) and the old orphan qualify;
    // current-file, version-only, and recent blobs are excluded.
    expect((await db.blobs.findUnreferencedOlderThan(50, 10)).map((item) => item.hash)).toEqual([
      'a'.repeat(64),
      oldOrphan,
    ]);
    expect((await db.blobs.findUnreferencedOlderThan(50, 1)).map((item) => item.hash)).toEqual([
      'a'.repeat(64),
    ]);
    expect(await db.blobs.findUnreferencedOlderThan(50, 0)).toEqual([]);
    expect(await db.blobs.findUnreferencedOlderThan(4, 10)).toEqual([]);
  });

  it('isolates the same file_id across vaults under the composite key', async () => {
    const { db } = await database();
    await seed(db);
    await db.vaults.insert({
      id: 'vault-2',
      ownerUserId: 'user-1',
      name: 'Second',
      latestRevision: 0,
      createdAt: 3,
      updatedAt: 3,
    });
    await db.vaultFiles.upsert({
      fileId: 'file-1',
      vaultId: 'vault-1',
      path: 'Note.md',
      blobHash: 'a'.repeat(64),
      size: 5,
      mtime: 1,
      kind: 'markdown',
      updatedRevision: 1,
    });
    await db.vaultFiles.upsert({
      fileId: 'file-1',
      vaultId: 'vault-2',
      path: 'Note.md',
      blobHash: 'a'.repeat(64),
      size: 5,
      mtime: 1,
      kind: 'markdown',
      updatedRevision: 1,
    });
    expect(await db.vaultFiles.findById('vault-1', 'file-1')).toMatchObject({
      vaultId: 'vault-1',
      path: 'Note.md',
    });
    expect(await db.vaultFiles.findById('vault-2', 'file-1')).toMatchObject({
      vaultId: 'vault-2',
      path: 'Note.md',
    });
    // Updating one vault's row leaves the other untouched.
    await db.vaultFiles.upsert({
      fileId: 'file-1',
      vaultId: 'vault-1',
      path: 'Renamed.md',
      blobHash: 'a'.repeat(64),
      size: 5,
      mtime: 2,
      kind: 'markdown',
      updatedRevision: 2,
    });
    expect(await db.vaultFiles.findById('vault-1', 'file-1')).toMatchObject({ path: 'Renamed.md' });
    expect(await db.vaultFiles.findById('vault-2', 'file-1')).toMatchObject({ path: 'Note.md' });
    // Scoped delete only removes the requested vault's row.
    await db.vaultFiles.delete('vault-1', 'file-1');
    expect(await db.vaultFiles.findById('vault-1', 'file-1')).toBeNull();
    expect(await db.vaultFiles.findById('vault-2', 'file-1')).not.toBeNull();
  });

  it('finds files by case-folded path and versions by latest path', async () => {
    const { db } = await database();
    await seed(db);
    await db.vaultFiles.upsert({
      fileId: 'file-1',
      vaultId: 'vault-1',
      path: 'Notes/Hello.md',
      blobHash: 'a'.repeat(64),
      size: 5,
      mtime: 1,
      kind: 'markdown',
      updatedRevision: 1,
    });
    await db.vaultFiles.upsert({
      fileId: 'file-2',
      vaultId: 'vault-1',
      path: 'NOTES/HELLO.md',
      blobHash: 'a'.repeat(64),
      size: 5,
      mtime: 1,
      kind: 'markdown',
      updatedRevision: 1,
    });
    expect(
      (await db.vaultFiles.findByPathFold('vault-1', 'notes/hello.md'))
        .map((file) => file.fileId)
        .sort(),
    ).toEqual(['file-1', 'file-2']);
    expect(await db.vaultFiles.findByPathFold('vault-1', 'notes/missing.md')).toEqual([]);
    await db.vaultRevisions.insert({
      vaultId: 'vault-1',
      revision: 1,
      manifestHash: 'manifest-1',
      deviceId: 'device-1',
      createdAt: 5,
    });
    await db.vaultRevisions.insert({
      vaultId: 'vault-1',
      revision: 2,
      manifestHash: 'manifest-2',
      deviceId: 'device-1',
      createdAt: 6,
    });
    await db.fileVersions.insertMany([
      {
        id: 'version-1',
        vaultId: 'vault-1',
        fileId: 'file-1',
        revision: 1,
        path: 'Old.md',
        blobHash: 'a'.repeat(64),
        size: 5,
        mtime: 1,
        changeType: 'create',
        createdAt: 5,
      },
      {
        id: 'version-2',
        vaultId: 'vault-1',
        fileId: 'file-1',
        revision: 2,
        path: 'Old.md',
        blobHash: 'a'.repeat(64),
        size: 5,
        mtime: 1,
        changeType: 'rename',
        createdAt: 6,
      },
    ]);
    expect(await db.fileVersions.findLatestByPath('vault-1', 'Old.md')).toMatchObject({
      id: 'version-2',
      revision: 2,
    });
    expect(await db.fileVersions.findLatestByPath('vault-1', 'Missing.md')).toBeNull();
  });

  it('round-trips the materialized graph cache row per vault', async () => {
    const { db } = await database();
    await seed(db);
    expect(await db.graphCache.find('vault-1')).toBeNull();
    const entry = { vaultId: 'vault-1', revision: 1, indexedRevision: 1, etag: 'W/"1-1-graph-v2"', payloadJson: '{"revision":1}', updatedAt: 9 };
    await db.graphCache.upsert(entry);
    expect(await db.graphCache.find('vault-1')).toEqual(entry);
    // A rebuild for a newer revision overwrites the row.
    await db.graphCache.upsert({ ...entry, revision: 2, indexedRevision: 2, etag: 'W/"2-2-graph-v2"' });
    expect(await db.graphCache.find('vault-1')).toMatchObject({ revision: 2, indexedRevision: 2 });
    await db.graphCache.deleteByVault('vault-1');
    expect(await db.graphCache.find('vault-1')).toBeNull();
  });

  it('upgrades a pre-path_fold v2 database so sync commits stop crashing', async () => {
    // Production regression: databases live at user_version 1/2 were
    // created before path_fold existed, so sync commit crashed with
    // `table vault_files has 9 columns but 10 values were supplied`.
    // Simulate that state by dropping the column and re-stamping v2.
    const { db, filename } = await database();
    await seed(db);
    await db.vaultFiles.upsert({
      fileId: 'file-1',
      vaultId: 'vault-1',
      path: 'Notes/Hello.md',
      blobHash: 'a'.repeat(64),
      size: 5,
      mtime: 1,
      kind: 'markdown',
      updatedRevision: 1,
    });
    db.close();
    databases.splice(databases.indexOf(db), 1);
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(filename);
    raw.exec('DROP INDEX IF EXISTS vault_files_path_fold_idx');
    raw.exec('ALTER TABLE vault_files DROP COLUMN path_fold');
    raw.exec('PRAGMA user_version = 2');
    const legacy = raw.prepare('PRAGMA table_info(vault_files)').all() as Array<{ name: string }>;
    expect(legacy.map((column) => column.name)).not.toContain('path_fold');
    raw.close();

    const upgraded = openSqliteDatabase(filename);
    databases.push(upgraded);
    // The previously crashing upsert now works and the fold is backfilled.
    await upgraded.vaultFiles.upsert({
      fileId: 'file-2',
      vaultId: 'vault-1',
      path: 'Notes/World.md',
      blobHash: 'a'.repeat(64),
      size: 5,
      mtime: 2,
      kind: 'markdown',
      updatedRevision: 2,
    });
    expect(await upgraded.vaultFiles.findByPath('vault-1', 'Notes/Hello.md')).toMatchObject({
      fileId: 'file-1',
    });
    expect(
      (await upgraded.vaultFiles.findByPathFold('vault-1', 'notes/hello.md')).map(
        (file) => file.fileId,
      ),
    ).toEqual(['file-1']);
    expect(
      (await upgraded.vaultFiles.findByPathFold('vault-1', 'notes/world.md')).map(
        (file) => file.fileId,
      ),
    ).toEqual(['file-2']);
  });

  it.each([1, 2, 3, 4])(
    'upgrades a user_version %i database through 005 with foreign_key_check clean',
    async (startVersion) => {
      // Build a genuinely old database by applying migrations 001..N with a
      // raw connection (openSqliteDatabase would migrate straight to
      // latest), seed parent + FK-child rows, stamp the old version, then
      // reopen through the real runner. 005 rebuilds vault_revisions while
      // file_versions holds a composite FK onto it — the rows must survive.
      const migrationFiles: Record<number, string> = {
        1: '001_initial.sql',
        2: '002_vault_name_unique.sql',
        3: '003_vault_files_path_fold.sql',
        4: '004_graph_cache.sql',
      };
      const directory = await mkdtemp(join(tmpdir(), 'tephra-sqlite-005-'));
      directories.push(directory);
      const filename = join(directory, 'tephra.db');
      const { DatabaseSync } = await import('node:sqlite');
      const legacy = new DatabaseSync(filename);
      const hash1 = 'a1'.repeat(32);
      const hash2 = 'b2'.repeat(32);
      const blob = 'c3'.repeat(32);
      legacy.exec('PRAGMA foreign_keys = ON');
      for (let version = 1; version <= startVersion; version++) {
        const sql = readFileSync(
          fileURLToPath(
            new URL(
              `../../../../migrations/sqlite/${migrationFiles[version]}`,
              import.meta.url,
            ),
          ),
          'utf8',
        );
        legacy.exec(sql);
      }
      // Explicit column lists: vault_files has no path_fold at v1/v2 and
      // gains it (with DEFAULT '') at v3, so one shape fits every version.
      legacy.exec(
        `INSERT INTO users VALUES ('user-1', 'one@example.com', NULL, 1, 1);
         INSERT INTO vaults VALUES ('vault-1', 'user-1', 'Vault', 2, 2, 2);
         INSERT INTO devices VALUES ('device-1', 'user-1', 'Phone', 'mobile', 3, 3);
         INSERT INTO blobs VALUES ('${blob}', 5, 'text/markdown', 4);
         INSERT INTO vault_revisions VALUES ('vault-1', 1, '${hash1}', 'device-1', 5);
         INSERT INTO vault_revisions VALUES ('vault-1', 2, '${hash2}', 'device-1', 6);
         INSERT INTO file_versions
           (id, vault_id, file_id, revision, path, blob_hash, size, mtime, change_type, created_at)
           VALUES ('version-1', 'vault-1', 'file-1', 1, 'Note.md', '${blob}', 5, 7, 'create', 5),
                  ('version-2', 'vault-1', 'file-1', 2, 'Note.md', '${blob}', 6, 8, 'modify', 6);
         INSERT INTO vault_files
           (file_id, vault_id, path, blob_hash, size, mtime, mime_type, kind, updated_revision)
           VALUES ('file-1', 'vault-1', 'Note.md', '${blob}', 6, 8, 'text/markdown', 'markdown', 2);
         PRAGMA user_version = ${startVersion};`,
      );
      legacy.close();

      const upgraded = openSqliteDatabase(filename);
      databases.push(upgraded);
      // Nothing cascade-deleted by the 005 rebuild.
      expect(await upgraded.vaultRevisions.list('vault-1')).toHaveLength(2);
      expect(await upgraded.fileVersions.listByRevision('vault-1', 1)).toHaveLength(1);
      expect(await upgraded.fileVersions.listByRevision('vault-1', 2)).toHaveLength(1);
      expect(await upgraded.vaultFiles.findById('vault-1', 'file-1')).toMatchObject({
        path: 'Note.md',
        updatedRevision: 2,
      });
      // The relaxed constraint: a later revision may reproduce an earlier
      // manifest hash (edit-then-revert), and the lookup is newest-wins.
      await upgraded.vaultRevisions.insert({
        vaultId: 'vault-1',
        revision: 3,
        manifestHash: hash1,
        deviceId: 'device-1',
        createdAt: 30,
      });
      expect(await upgraded.vaultRevisions.findByManifestHash('vault-1', hash1)).toMatchObject({
        revision: 3,
      });
      expect(await upgraded.vaultRevisions.findByManifestHash('vault-1', hash2)).toMatchObject({
        revision: 2,
      });
      upgraded.close();
      databases.splice(databases.indexOf(upgraded), 1);

      const raw = new DatabaseSync(filename);
      try {
        expect(
          (raw.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
        ).toBe(5);
        expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
        expect(
          raw
            .prepare(
              "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'vault_revisions_manifest_idx'",
            )
            .all(),
        ).toHaveLength(1);
        const revisionIndexes = raw
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'vault_revisions'",
          )
          .all() as Array<{ sql: string | null }>;
        expect(revisionIndexes.some((row) => row.sql?.includes('UNIQUE'))).toBe(false);
      } finally {
        raw.close();
      }
    },
  );
});
