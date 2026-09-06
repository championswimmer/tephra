import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

import type {
  Database,
  Repositories,
  TransactionRepositories,
} from '@tephra/database-core';
import type {
  ApiToken,
  ApiTokenScope,
  BlobMetadata,
  CurrentVaultFile,
  Device,
  FileChangeType,
  FileVersion,
  NoteLink,
  NoteMetadata,
  Session,
  User,
  Vault,
  VaultFileKind,
  VaultIndexState,
  VaultRevision,
} from '@tephra/vault-model';

const MIGRATION_URL = new URL('../../../../migrations/sqlite/001_initial.sql', import.meta.url);
const TOKEN_SCOPES = new Set<ApiTokenScope>(['vault:read-metadata', 'vault:upload']);

type Row = Record<string, unknown>;
type SqliteValue = string | number | bigint | null | Uint8Array;

function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid SQLite value for ${key}`);
  return value;
}
function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid SQLite value for ${key}`);
  return value;
}
function requiredNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid SQLite value for ${key}`);
  }
  return value;
}
function nullableNumber(row: Row, key: string): number | null {
  return row[key] === null ? null : requiredNumber(row, key);
}
function rows(value: unknown[]): Row[] {
  return value as Row[];
}
function json(value: unknown, field: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${field} is not JSON serializable`);
  return serialized;
}
function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON stored in ${field}`, { cause: error });
  }
}
function isTokenScopes(value: unknown): value is ApiTokenScope[] {
  return Array.isArray(value) && value.every(
    (scope) => typeof scope === 'string' && TOKEN_SCOPES.has(scope as ApiTokenScope),
  );
}
function scopesJson(value: ApiTokenScope[]): string {
  if (!isTokenScopes(value)) throw new TypeError('Invalid API token scopes');
  return json(value, 'token scopes');
}
function scopesFromRow(row: Row): ApiTokenScope[] {
  const value = parseJson(requiredString(row, 'scopes_json'), 'api_tokens.scopes_json');
  if (!isTokenScopes(value)) throw new Error('Invalid JSON stored in api_tokens.scopes_json');
  return value;
}
function metadataJson<T>(row: Row, key: string, valid: (value: unknown) => boolean): T {
  const value = parseJson(requiredString(row, key), `note_metadata.${key}`);
  if (!valid(value)) throw new Error(`Invalid JSON stored in note_metadata.${key}`);
  return value as T;
}

function user(row: Row): User {
  return { id: requiredString(row, 'id'), email: requiredString(row, 'email'), passwordHash: nullableString(row, 'password_hash'), createdAt: requiredNumber(row, 'created_at'), updatedAt: requiredNumber(row, 'updated_at') };
}
function session(row: Row): Session {
  return { id: requiredString(row, 'id'), userId: requiredString(row, 'user_id'), expiresAt: requiredNumber(row, 'expires_at'), createdAt: requiredNumber(row, 'created_at') };
}
function vault(row: Row): Vault {
  return { id: requiredString(row, 'id'), ownerUserId: requiredString(row, 'owner_user_id'), name: requiredString(row, 'name'), latestRevision: requiredNumber(row, 'latest_revision'), createdAt: requiredNumber(row, 'created_at'), updatedAt: requiredNumber(row, 'updated_at') };
}
function device(row: Row): Device {
  const result: Device = { id: requiredString(row, 'id'), userId: requiredString(row, 'user_id'), name: requiredString(row, 'name'), createdAt: requiredNumber(row, 'created_at'), lastSeenAt: requiredNumber(row, 'last_seen_at') };
  const platform = nullableString(row, 'platform');
  if (platform !== null) result.platform = platform;
  return result;
}
function token(row: Row): ApiToken {
  return { id: requiredString(row, 'id'), userId: requiredString(row, 'user_id'), vaultId: nullableString(row, 'vault_id'), deviceId: nullableString(row, 'device_id'), tokenHash: requiredString(row, 'token_hash'), name: requiredString(row, 'name'), scopes: scopesFromRow(row), createdAt: requiredNumber(row, 'created_at'), lastUsedAt: nullableNumber(row, 'last_used_at'), expiresAt: nullableNumber(row, 'expires_at'), revokedAt: nullableNumber(row, 'revoked_at') };
}
function blob(row: Row): BlobMetadata {
  return { hash: requiredString(row, 'hash'), size: requiredNumber(row, 'size'), mimeType: nullableString(row, 'mime_type'), createdAt: requiredNumber(row, 'created_at') };
}
function vaultFile(row: Row): CurrentVaultFile {
  const result: CurrentVaultFile = { fileId: requiredString(row, 'file_id'), vaultId: requiredString(row, 'vault_id'), path: requiredString(row, 'path'), blobHash: requiredString(row, 'blob_hash'), size: requiredNumber(row, 'size'), mtime: requiredNumber(row, 'mtime'), kind: requiredString(row, 'kind') as VaultFileKind, updatedRevision: requiredNumber(row, 'updated_revision') };
  const mimeType = nullableString(row, 'mime_type');
  if (mimeType !== null) result.mimeType = mimeType;
  return result;
}
function revision(row: Row): VaultRevision {
  return { vaultId: requiredString(row, 'vault_id'), revision: requiredNumber(row, 'revision'), manifestHash: requiredString(row, 'manifest_hash'), deviceId: requiredString(row, 'device_id'), createdAt: requiredNumber(row, 'created_at') };
}
function fileVersion(row: Row): FileVersion {
  return { id: requiredString(row, 'id'), vaultId: requiredString(row, 'vault_id'), fileId: requiredString(row, 'file_id'), revision: requiredNumber(row, 'revision'), path: requiredString(row, 'path'), blobHash: nullableString(row, 'blob_hash'), size: nullableNumber(row, 'size'), mtime: nullableNumber(row, 'mtime'), changeType: requiredString(row, 'change_type') as FileChangeType, createdAt: requiredNumber(row, 'created_at') };
}
function noteMetadata(row: Row): NoteMetadata {
  return { fileId: requiredString(row, 'file_id'), vaultId: requiredString(row, 'vault_id'), indexedBlobHash: requiredString(row, 'indexed_blob_hash'), title: nullableString(row, 'title'), frontmatter: metadataJson<Record<string, unknown>>(row, 'frontmatter_json', (v) => typeof v === 'object' && v !== null && !Array.isArray(v)), headings: metadataJson<unknown[]>(row, 'headings_json', Array.isArray), tags: metadataJson<string[]>(row, 'tags_json', (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')), blocks: metadataJson<unknown[]>(row, 'blocks_json', Array.isArray), indexedAt: requiredNumber(row, 'indexed_at') };
}
function noteLink(row: Row): NoteLink {
  return { id: requiredString(row, 'id'), vaultId: requiredString(row, 'vault_id'), sourceFileId: requiredString(row, 'source_file_id'), rawText: requiredString(row, 'raw_text'), linkPath: requiredString(row, 'link_path'), subpath: nullableString(row, 'subpath'), displayText: nullableString(row, 'display_text'), isEmbed: requiredNumber(row, 'is_embed') === 1, targetFileId: nullableString(row, 'target_file_id'), createdAt: requiredNumber(row, 'created_at') };
}

function first(db: DatabaseSync, sql: string, ...params: SqliteValue[]): Row | null {
  return (db.prepare(sql).get(...params) as Row | undefined) ?? null;
}
function all(db: DatabaseSync, sql: string, ...params: SqliteValue[]): Row[] {
  return rows(db.prepare(sql).all(...params));
}

function makeRepositories(db: DatabaseSync): TransactionRepositories {
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
      async findById(id) { const row = first(db, 'SELECT * FROM vault_files WHERE file_id=?', id); return row && vaultFile(row); },
      async findByPath(vaultId, path) { const row = first(db, 'SELECT * FROM vault_files WHERE vault_id=? AND path=?', vaultId, path); return row && vaultFile(row); },
      async listByVault(id) { return all(db, 'SELECT * FROM vault_files WHERE vault_id=? ORDER BY path', id).map(vaultFile); },
      async upsert(v) { db.prepare(`INSERT INTO vault_files VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(file_id) DO UPDATE SET vault_id=excluded.vault_id,path=excluded.path,blob_hash=excluded.blob_hash,size=excluded.size,mtime=excluded.mtime,mime_type=excluded.mime_type,kind=excluded.kind,updated_revision=excluded.updated_revision`).run(v.fileId, v.vaultId, v.path, v.blobHash, v.size, v.mtime, v.mimeType ?? null, v.kind, v.updatedRevision); },
      async delete(id) { db.prepare('DELETE FROM vault_files WHERE file_id=?').run(id); },
    },
    vaultRevisions: {
      async find(vaultId, rev) { const row = first(db, 'SELECT * FROM vault_revisions WHERE vault_id=? AND revision=?', vaultId, rev); return row && revision(row); },
      async findLatest(id) { const row = first(db, 'SELECT * FROM vault_revisions WHERE vault_id=? ORDER BY revision DESC LIMIT 1', id); return row && revision(row); },
      async findByManifestHash(id, hash) { const row = first(db, 'SELECT * FROM vault_revisions WHERE vault_id=? AND manifest_hash=?', id, hash); return row && revision(row); },
      async list(id) { return all(db, 'SELECT * FROM vault_revisions WHERE vault_id=? ORDER BY revision', id).map(revision); },
      async insert(v) { db.prepare('INSERT INTO vault_revisions VALUES (?, ?, ?, ?, ?)').run(v.vaultId, v.revision, v.manifestHash, v.deviceId, v.createdAt); },
    },
    fileVersions: {
      async listByRevision(vaultId, rev) { return all(db, 'SELECT * FROM file_versions WHERE vault_id=? AND revision=? ORDER BY id', vaultId, rev).map(fileVersion); },
      async listByFile(vaultId, fileId) { return all(db, 'SELECT * FROM file_versions WHERE vault_id=? AND file_id=? ORDER BY revision, id', vaultId, fileId).map(fileVersion); },
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
    async lockVault(vaultId) { const row = first(db, 'SELECT id FROM vaults WHERE id=?', vaultId); if (row === null) throw new Error(`Vault not found: ${vaultId}`); },
  };
}

class SerialExecutor {
  private tail: Promise<void> = Promise.resolve();
  run<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
}
function serialized<T extends object>(repository: T, executor: SerialExecutor): T {
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver) as unknown;
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => executor.run(() => Reflect.apply(value, target, args) as Promise<unknown>);
    },
  });
}

export interface SqliteDatabase extends Database {
  close(): void;
}
export interface OpenSqliteDatabaseOptions {
  filename: string;
  migrationFile?: string | URL;
}

function migrate(db: DatabaseSync, migrationFile: string | URL): void {
  const versionRow = first(db, 'PRAGMA user_version');
  const version = versionRow ? requiredNumber(versionRow, 'user_version') : 0;
  if (version > 1) throw new Error(`SQLite schema version ${version} is newer than supported version 1`);
  if (version === 1) return;
  const sql = readFileSync(migrationFile instanceof URL ? fileURLToPath(migrationFile) : migrationFile, 'utf8');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(sql);
    db.exec('PRAGMA user_version = 1');
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function openSqliteDatabase(options: OpenSqliteDatabaseOptions | string): SqliteDatabase {
  const normalized = typeof options === 'string' ? { filename: options } : options;
  const connection = new DatabaseSync(normalized.filename);
  try {
    connection.exec('PRAGMA foreign_keys = ON');
    connection.exec('PRAGMA busy_timeout = 5000');
    migrate(connection, normalized.migrationFile ?? MIGRATION_URL);
  } catch (error) {
    connection.close();
    throw error;
  }
  const direct = makeRepositories(connection);
  const executor = new SerialExecutor();
  const exposed = Object.fromEntries(Object.entries(direct).filter(([key]) => key !== 'lockVault').map(([key, repository]) => [key, serialized(repository as object, executor)])) as unknown as Repositories;
  let closed = false;
  return {
    ...exposed,
    transaction<T>(operation: (repositories: TransactionRepositories) => Promise<T>): Promise<T> {
      return executor.run(async () => {
        connection.exec('BEGIN IMMEDIATE');
        try {
          const result = await operation(direct);
          connection.exec('COMMIT');
          return result;
        } catch (error) {
          connection.exec('ROLLBACK');
          throw error;
        }
      });
    },
    close() {
      if (!closed) {
        connection.close();
        closed = true;
      }
    },
  };
}

export const createSqliteDatabase = openSqliteDatabase;
