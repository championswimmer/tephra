// Generates fixture.db + fixture.expected.json with the TS SQLite adapter.
// Needs packages/database/sqlite built (npm run build -w @tephra/database-sqlite).
// Run: node internal/db/sqlite/testdata/gen-fixture.mjs   (from tephra-server/go)
import { rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openSqliteDatabase } from '../../../../../packages/database/sqlite/dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const file = join(here, 'fixture.db');
for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(file + suffix, { force: true });
const db = openSqliteDatabase(file);
const h = (c) => c.repeat(64);

await db.users.insert({ id: 'user-1', email: 'one@example.com', passwordHash: 'scrypt$hash', createdAt: 1, updatedAt: 2 });
await db.users.insert({ id: 'user-2', email: 'two@example.com', passwordHash: null, createdAt: 3, updatedAt: 3 });
await db.sessions.insert({ id: 'session-1', userId: 'user-1', expiresAt: 100, createdAt: 4 });
await db.vaults.insert({ id: 'vault-1', ownerUserId: 'user-1', name: 'Vault <&> ünï', latestRevision: 2, createdAt: 5, updatedAt: 6 });
await db.vaults.insert({ id: 'vault-2', ownerUserId: 'user-1', name: 'Native', latestRevision: 0, createdAt: 5, updatedAt: 5, syncMode: 'obsidian' });
await db.devices.insert({ id: 'device-1', userId: 'user-1', name: 'Phone', platform: 'mobile', createdAt: 7, lastSeenAt: 8 });
await db.devices.insert({ id: 'device-2', userId: 'user-1', name: 'Anon', createdAt: 7, lastSeenAt: 9 });
await db.apiTokens.insert({ id: 'token-1', userId: 'user-1', vaultId: 'vault-1', deviceId: 'device-1', tokenHash: 'hash-1', name: 'Sync', scopes: ['vault:upload', 'vault:read-metadata', 'vault:write'], createdAt: 10, lastUsedAt: 11, expiresAt: 5000, revokedAt: null });
await db.apiTokens.insert({ id: 'token-2', userId: 'user-1', vaultId: null, deviceId: null, tokenHash: 'hash-2', name: 'Global', scopes: [], createdAt: 10, lastUsedAt: null, expiresAt: null, revokedAt: 12 });
await db.oauthCodes.insert({ codeHash: 'code-1', userId: 'user-1', vaultId: 'vault-1', clientId: 'c', clientName: 'Claude Code', redirectUri: 'http://127.0.0.1:1/cb', codeChallenge: 'x'.repeat(43), scopes: ['vault:read-metadata'], createdAt: 10, expiresAt: 70 });
await db.blobs.insert({ hash: h('a'), size: 5, mimeType: 'text/markdown', createdAt: 13 });
await db.blobs.insert({ hash: h('b'), size: 0, mimeType: null, createdAt: 14 });
await db.blobs.insert({ hash: h('c'), size: 9, mimeType: 'image/png', createdAt: 15 });
await db.vaultRevisions.insert({ vaultId: 'vault-1', revision: 1, manifestHash: 'm1', deviceId: 'device-1', createdAt: 16 });
await db.vaultRevisions.insert({ vaultId: 'vault-1', revision: 2, manifestHash: 'm1', deviceId: 'device-2', createdAt: 17 });
await db.vaultFiles.upsert({ fileId: 'file-1', vaultId: 'vault-1', path: 'Notes/Ünï.md', blobHash: h('a'), size: 5, mtime: 18, mimeType: 'text/markdown', kind: 'markdown', updatedRevision: 1 });
await db.vaultFiles.upsert({ fileId: 'file-2', vaultId: 'vault-1', path: 'img/pic.png', blobHash: h('c'), size: 9, mtime: 19, kind: 'attachment', updatedRevision: 2 });
await db.fileVersions.insertMany([
  { id: 'v-1', vaultId: 'vault-1', fileId: 'file-1', revision: 1, path: 'Notes/Ünï.md', blobHash: h('a'), size: 5, mtime: 18, changeType: 'create', createdAt: 16 },
  { id: 'v-2', vaultId: 'vault-1', fileId: 'file-2', revision: 2, path: 'img/pic.png', blobHash: h('c'), size: 9, mtime: 19, changeType: 'create', createdAt: 17 },
  { id: 'v-3', vaultId: 'vault-1', fileId: 'file-3', revision: 2, path: 'gone.md', blobHash: null, size: null, mtime: null, changeType: 'delete', createdAt: 17 },
]);
await db.noteIndex.upsertMetadata({ fileId: 'file-1', vaultId: 'vault-1', indexedBlobHash: h('a'), title: 'Ünï <b>', frontmatter: { nested: { enabled: true }, count: 2, list: [1, 'x', null] }, headings: [{ text: 'Title', level: 1 }], tags: ['one', 'two'], blocks: [{ id: 'block' }], indexedAt: 20 });
await db.noteIndex.upsertMetadata({ fileId: 'file-2', vaultId: 'vault-1', indexedBlobHash: h('c'), title: null, frontmatter: {}, headings: [], tags: [], blocks: [], indexedAt: 21 });
await db.noteIndex.replaceLinksForSource('vault-1', 'file-1', [
  { id: 'link-1', vaultId: 'vault-1', sourceFileId: 'file-1', rawText: '[[pic#x|P]]', linkPath: 'pic', subpath: '#x', displayText: 'P', isEmbed: true, targetFileId: 'file-2', createdAt: 22 },
  { id: 'link-2', vaultId: 'vault-1', sourceFileId: 'file-1', rawText: '[[Nope]]', linkPath: 'Nope', subpath: null, displayText: null, isEmbed: false, targetFileId: null, createdAt: 22 },
]);
await db.noteIndex.setState({ vaultId: 'vault-1', indexedRevision: 2, lastError: 'boom' });
await db.graphCache.upsert({ vaultId: 'vault-1', revision: 2, indexedRevision: 2, etag: 'W/"2-2-graph-v2"', payloadJson: '{"revision":2}', updatedAt: 23 });
await db.obsidianSync.upsert({ vaultId: 'vault-2', enabled: true, remoteVaultId: 'remote-1', mode: 'pull-only', phase: 'error', lastErrorCode: 'E1', hasSynced: false, lastSyncedAt: 12345 });

const expected = {
  users: [await db.users.findByEmail('one@example.com'), await db.users.findByEmail('two@example.com')],
  userCount: await db.users.count(),
  session: await db.sessions.findById('session-1'),
  vaults: await db.vaults.listByOwner('user-1'),
  devices: await db.devices.listByUser('user-1'),
  tokens: [...await db.apiTokens.listByVault('vault-1'), await db.apiTokens.findByTokenHash('hash-2')],
  oauthCode: { codeHash: 'code-1', userId: 'user-1', vaultId: 'vault-1', clientId: 'c', clientName: 'Claude Code', redirectUri: 'http://127.0.0.1:1/cb', codeChallenge: 'x'.repeat(43), scopes: ['vault:read-metadata'], createdAt: 10, expiresAt: 70 },
  blobs: await db.blobs.findByHashes([h('c'), h('a'), h('b'), 'missing']),
  files: await db.vaultFiles.listByVault('vault-1'),
  fileFold: await db.vaultFiles.findByPathFold('vault-1', 'notes/ünï.md'),
  revisions: await db.vaultRevisions.list('vault-1'),
  latestByManifest: await db.vaultRevisions.findByManifestHash('vault-1', 'm1'),
  versions: await db.fileVersions.listSince('vault-1', 0, 100),
  metadata: await db.noteIndex.listMetadata('vault-1'),
  links: await db.noteIndex.listLinks('vault-1'),
  state: await db.noteIndex.getState('vault-1'),
  graph: await db.graphCache.find('vault-1'),
  obsidian: await db.obsidianSync.list(),
};
writeFileSync(join(here, 'fixture.expected.json'), JSON.stringify(expected, null, 2) + '\n');
db.close();
