import type { DatabaseSync } from 'node:sqlite';

import type { TransactionRepositories } from '@tephra/database-core';
import type { VaultIndexState } from '@tephra/vault-model';

import {
  all, blob, device, fileVersion, first, graphCache, json, noteLink, noteMetadata, nullableString,
  requiredNumber, requiredString, revision, scopesJson, session, token, user, vault, vaultFile,
} from './rows.js';

export function makeRepositories(db: DatabaseSync): TransactionRepositories {
  return {
    users: {
      async count() { return requiredNumber(first(db, 'SELECT count(*) AS count FROM users')!, 'count'); },
      async findById(id) { const row = first(db, 'SELECT * FROM users WHERE id = ?', id); return row && user(row); },
      async findByEmail(email) { const row = first(db, 'SELECT * FROM users WHERE email = ?', email); return row && user(row); },
      async insert(v) { db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)').run(v.id, v.email, v.passwordHash, v.createdAt, v.updatedAt); },
      async update(v) { db.prepare('UPDATE users SET email=?, password_hash=?, created_at=?, updated_at=? WHERE id=?').run(v.email, v.passwordHash, v.createdAt, v.updatedAt, v.id); },
    },
    sessions: {
      async findById(id) { const row = first(db, 'SELECT * FROM sessions WHERE id=?', id); return row && session(row); },
      async insert(v) { db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?)').run(v.id, v.userId, v.expiresAt, v.createdAt); },
      async delete(id) { db.prepare('DELETE FROM sessions WHERE id=?').run(id); },
      async deleteExpired(now) { return Number(db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now).changes); },
    },
    vaults: {
      async findById(id) { const row = first(db, 'SELECT * FROM vaults WHERE id=?', id); return row && vault(row); },
      async findByName(name) { const row = first(db, 'SELECT * FROM vaults WHERE name=?', name); return row && vault(row); },
      async listByOwner(id) { return all(db, 'SELECT * FROM vaults WHERE owner_user_id=? ORDER BY created_at, id', id).map(vault); },
      async insert(v) { db.prepare('INSERT INTO vaults VALUES (?, ?, ?, ?, ?, ?)').run(v.id, v.ownerUserId, v.name, v.latestRevision, v.createdAt, v.updatedAt); },
      async update(v) { db.prepare('UPDATE vaults SET owner_user_id=?, name=?, latest_revision=?, created_at=?, updated_at=? WHERE id=?').run(v.ownerUserId, v.name, v.latestRevision, v.createdAt, v.updatedAt, v.id); },
      async delete(id) { db.prepare('DELETE FROM vaults WHERE id=?').run(id); },
    },
    devices: {
      async findById(id) { const row = first(db, 'SELECT * FROM devices WHERE id=?', id); return row && device(row); },
      async listByUser(id) { return all(db, 'SELECT * FROM devices WHERE user_id=? ORDER BY created_at, id', id).map(device); },
      async insert(v) { db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?, ?)').run(v.id, v.userId, v.name, v.platform ?? null, v.createdAt, v.lastSeenAt); },
      async update(v) { db.prepare('UPDATE devices SET user_id=?, name=?, platform=?, created_at=?, last_seen_at=? WHERE id=?').run(v.userId, v.name, v.platform ?? null, v.createdAt, v.lastSeenAt, v.id); },
    },
    apiTokens: {
      async findById(id) { const row = first(db, 'SELECT * FROM api_tokens WHERE id=?', id); return row && token(row); },
      async findByTokenHash(hash) { const row = first(db, 'SELECT * FROM api_tokens WHERE token_hash=?', hash); return row && token(row); },
      async listByVault(id) { return all(db, 'SELECT * FROM api_tokens WHERE vault_id=? ORDER BY created_at, id', id).map(token); },
      async insert(v) { db.prepare('INSERT INTO api_tokens VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(v.id, v.userId, v.vaultId, v.deviceId, v.tokenHash, v.name, scopesJson(v.scopes), v.createdAt, v.lastUsedAt, v.expiresAt, v.revokedAt); },
      async update(v) { db.prepare('UPDATE api_tokens SET user_id=?, vault_id=?, device_id=?, token_hash=?, name=?, scopes_json=?, created_at=?, last_used_at=?, expires_at=?, revoked_at=? WHERE id=?').run(v.userId, v.vaultId, v.deviceId, v.tokenHash, v.name, scopesJson(v.scopes), v.createdAt, v.lastUsedAt, v.expiresAt, v.revokedAt, v.id); },
      async delete(id) { db.prepare('DELETE FROM api_tokens WHERE id=?').run(id); },
    },
    blobs: {
      async findByHash(hash) { const row = first(db, 'SELECT * FROM blobs WHERE hash=?', hash); return row && blob(row); },
      async findByHashes(hashes) { if (hashes.length === 0) return []; const placeholders = hashes.map(() => '?').join(','); return all(db, `SELECT * FROM blobs WHERE hash IN (${placeholders}) ORDER BY hash`, ...hashes).map(blob); },
      async findUnreferencedOlderThan(cutoff, limit) {
        if (!Number.isSafeInteger(limit) || limit <= 0) return [];
        return all(db, `SELECT * FROM blobs WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM vault_files WHERE vault_files.blob_hash = blobs.hash) AND NOT EXISTS (SELECT 1 FROM file_versions WHERE file_versions.blob_hash = blobs.hash) ORDER BY created_at ASC LIMIT ?`, cutoff, limit).map(blob);
      },
      async insert(v) { db.prepare('INSERT INTO blobs VALUES (?, ?, ?, ?)').run(v.hash, v.size, v.mimeType, v.createdAt); },
      async delete(hash) { db.prepare('DELETE FROM blobs WHERE hash=?').run(hash); },
    },
    vaultFiles: {
      async findById(vaultId, fileId) { const row = first(db, 'SELECT * FROM vault_files WHERE vault_id=? AND file_id=?', vaultId, fileId); return row && vaultFile(row); },
      async findByPath(vaultId, path) { const row = first(db, 'SELECT * FROM vault_files WHERE vault_id=? AND path=?', vaultId, path); return row && vaultFile(row); },
      async findByPathFold(vaultId, pathFold) { return all(db, 'SELECT * FROM vault_files WHERE vault_id=? AND path_fold=? ORDER BY path', vaultId, pathFold).map(vaultFile); },
      async listByVault(id) { return all(db, 'SELECT * FROM vault_files WHERE vault_id=? ORDER BY path', id).map(vaultFile); },
      // Explicit column list: migration 003 appends path_fold last on legacy databases while fresh
      // databases define it mid-table, so a positional VALUES would misalign on one of the two.
      async upsert(v) { const pathFold = v.path.normalize('NFC').toLowerCase(); db.prepare(`INSERT INTO vault_files (file_id, vault_id, path, path_fold, blob_hash, size, mtime, mime_type, kind, updated_revision) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(vault_id, file_id) DO UPDATE SET path=excluded.path,path_fold=excluded.path_fold,blob_hash=excluded.blob_hash,size=excluded.size,mtime=excluded.mtime,mime_type=excluded.mime_type,kind=excluded.kind,updated_revision=excluded.updated_revision`).run(v.fileId, v.vaultId, v.path, pathFold, v.blobHash, v.size, v.mtime, v.mimeType ?? null, v.kind, v.updatedRevision); },
      async delete(vaultId, fileId) { db.prepare('DELETE FROM vault_files WHERE vault_id=? AND file_id=?').run(vaultId, fileId); },
    },
    vaultRevisions: {
      async find(vaultId, rev) { const row = first(db, 'SELECT * FROM vault_revisions WHERE vault_id=? AND revision=?', vaultId, rev); return row && revision(row); },
      async findLatest(id) { const row = first(db, 'SELECT * FROM vault_revisions WHERE vault_id=? ORDER BY revision DESC LIMIT 1', id); return row && revision(row); },
      // Newest-wins: since 005 the same manifest hash may appear on several
      // revisions (edit-then-revert), so idempotency checks resolve to the latest.
      async findByManifestHash(id, hash) { const row = first(db, 'SELECT * FROM vault_revisions WHERE vault_id=? AND manifest_hash=? ORDER BY revision DESC LIMIT 1', id, hash); return row && revision(row); },
      async list(id) { return all(db, 'SELECT * FROM vault_revisions WHERE vault_id=? ORDER BY revision', id).map(revision); },
      async insert(v) { db.prepare('INSERT INTO vault_revisions VALUES (?, ?, ?, ?, ?)').run(v.vaultId, v.revision, v.manifestHash, v.deviceId, v.createdAt); },
    },
    fileVersions: {
      async listByRevision(vaultId, rev) { return all(db, 'SELECT * FROM file_versions WHERE vault_id=? AND revision=? ORDER BY id', vaultId, rev).map(fileVersion); },
      async listByFile(vaultId, fileId) { return all(db, 'SELECT * FROM file_versions WHERE vault_id=? AND file_id=? ORDER BY revision, id', vaultId, fileId).map(fileVersion); },
      async findLatestByPath(vaultId, path) { const row = first(db, 'SELECT * FROM file_versions WHERE vault_id=? AND path=? ORDER BY revision DESC LIMIT 1', vaultId, path); return row && fileVersion(row); },
      async listSince(vaultId, sinceRevision, limit) { if (!Number.isSafeInteger(limit) || limit <= 0) return []; return all(db, 'SELECT * FROM file_versions WHERE vault_id=? AND revision>? ORDER BY revision, id LIMIT ?', vaultId, sinceRevision, limit).map(fileVersion); },
      async insertMany(values) { const statement = db.prepare('INSERT INTO file_versions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'); for (const v of values) statement.run(v.id, v.vaultId, v.fileId, v.revision, v.path, v.blobHash, v.size, v.mtime, v.changeType, v.createdAt); },
    },
    noteIndex: {
      async findMetadata(id) { const row = first(db, 'SELECT * FROM note_metadata WHERE file_id=?', id); return row && noteMetadata(row); },
      async listMetadata(id) { return all(db, 'SELECT * FROM note_metadata WHERE vault_id=? ORDER BY file_id', id).map(noteMetadata); },
      async upsertMetadata(v) { db.prepare(`INSERT INTO note_metadata VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET vault_id=excluded.vault_id,indexed_blob_hash=excluded.indexed_blob_hash,title=excluded.title,frontmatter_json=excluded.frontmatter_json,headings_json=excluded.headings_json,tags_json=excluded.tags_json,blocks_json=excluded.blocks_json,indexed_at=excluded.indexed_at`).run(v.fileId, v.vaultId, v.indexedBlobHash, v.title, json(v.frontmatter, 'frontmatter'), json(v.headings, 'headings'), json(v.tags, 'tags'), json(v.blocks, 'blocks'), v.indexedAt); },
      async deleteMetadata(id) { db.prepare('DELETE FROM note_metadata WHERE file_id=?').run(id); },
      async listLinksBySource(vaultId, fileId) { return all(db, 'SELECT * FROM note_links WHERE vault_id=? AND source_file_id=? ORDER BY id', vaultId, fileId).map(noteLink); },
      async listLinksByTarget(vaultId, fileId) { return all(db, 'SELECT * FROM note_links WHERE vault_id=? AND target_file_id=? ORDER BY id', vaultId, fileId).map(noteLink); },
      async listLinks(id) { return all(db, 'SELECT * FROM note_links WHERE vault_id=? ORDER BY id', id).map(noteLink); },
      async replaceLinksForSource(vaultId, sourceFileId, links) { if (links.some((v) => v.vaultId !== vaultId || v.sourceFileId !== sourceFileId)) throw new Error('Link does not belong to requested source'); db.prepare('DELETE FROM note_links WHERE vault_id=? AND source_file_id=?').run(vaultId, sourceFileId); const statement = db.prepare('INSERT INTO note_links VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'); for (const v of links) statement.run(v.id, v.vaultId, v.sourceFileId, v.rawText, v.linkPath, v.subpath, v.displayText, v.isEmbed ? 1 : 0, v.targetFileId, v.createdAt); },
      async getState(id) { const row = first(db, 'SELECT * FROM vault_index_state WHERE vault_id=?', id); return row && { vaultId: requiredString(row, 'vault_id'), indexedRevision: requiredNumber(row, 'indexed_revision'), lastError: nullableString(row, 'last_error') }; },
      async setState(v: VaultIndexState) { db.prepare('INSERT INTO vault_index_state VALUES (?, ?, ?) ON CONFLICT(vault_id) DO UPDATE SET indexed_revision=excluded.indexed_revision,last_error=excluded.last_error').run(v.vaultId, v.indexedRevision, v.lastError); },
    },
    graphCache: {
      async find(vaultId) { const row = first(db, 'SELECT * FROM vault_graph_cache WHERE vault_id=?', vaultId); return row && graphCache(row); },
      async upsert(v) { db.prepare('INSERT INTO vault_graph_cache VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(vault_id) DO UPDATE SET revision=excluded.revision,indexed_revision=excluded.indexed_revision,etag=excluded.etag,payload_json=excluded.payload_json,updated_at=excluded.updated_at').run(v.vaultId, v.revision, v.indexedRevision, v.etag, v.payloadJson, v.updatedAt); },
      async deleteByVault(vaultId) { db.prepare('DELETE FROM vault_graph_cache WHERE vault_id=?').run(vaultId); },
    },
    async lockVault(vaultId) { const row = first(db, 'SELECT id FROM vaults WHERE id=?', vaultId); if (row === null) throw new Error(`Vault not found: ${vaultId}`); },
  };
}
