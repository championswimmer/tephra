import type { DatabaseSync } from 'node:sqlite';

import type { GraphCacheEntry } from '@tephra/database-core';
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
  VaultRevision,
} from '@tephra/vault-model';

const TOKEN_SCOPES = new Set<ApiTokenScope>(['vault:read-metadata', 'vault:upload', 'vault:write']);

export type Row = Record<string, unknown>;
export type SqliteValue = string | number | bigint | null | Uint8Array;

export function requiredString(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== 'string') throw new Error(`Invalid SQLite value for ${key}`);
  return value;
}
export function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`Invalid SQLite value for ${key}`);
  return value;
}
export function requiredNumber(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`Invalid SQLite value for ${key}`);
  }
  return value;
}
export function nullableNumber(row: Row, key: string): number | null {
  return row[key] === null ? null : requiredNumber(row, key);
}
export function rows(value: unknown[]): Row[] {
  return value as Row[];
}
export function json(value: unknown, field: string): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new TypeError(`${field} is not JSON serializable`);
  return serialized;
}
export function parseJson(value: string, field: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`Invalid JSON stored in ${field}`, { cause: error });
  }
}
export function isTokenScopes(value: unknown): value is ApiTokenScope[] {
  return Array.isArray(value) && value.every(
    (scope) => typeof scope === 'string' && TOKEN_SCOPES.has(scope as ApiTokenScope),
  );
}
export function scopesJson(value: ApiTokenScope[]): string {
  if (!isTokenScopes(value)) throw new TypeError('Invalid API token scopes');
  return json(value, 'token scopes');
}
export function scopesFromRow(row: Row): ApiTokenScope[] {
  const value = parseJson(requiredString(row, 'scopes_json'), 'api_tokens.scopes_json');
  if (!isTokenScopes(value)) throw new Error('Invalid JSON stored in api_tokens.scopes_json');
  return value;
}
export function metadataJson<T>(row: Row, key: string, valid: (value: unknown) => boolean): T {
  const value = parseJson(requiredString(row, key), `note_metadata.${key}`);
  if (!valid(value)) throw new Error(`Invalid JSON stored in note_metadata.${key}`);
  return value as T;
}

export function user(row: Row): User {
  return { id: requiredString(row, 'id'), email: requiredString(row, 'email'), passwordHash: nullableString(row, 'password_hash'), createdAt: requiredNumber(row, 'created_at'), updatedAt: requiredNumber(row, 'updated_at') };
}
export function session(row: Row): Session {
  return { id: requiredString(row, 'id'), userId: requiredString(row, 'user_id'), expiresAt: requiredNumber(row, 'expires_at'), createdAt: requiredNumber(row, 'created_at') };
}
export function vault(row: Row): Vault {
  return { id: requiredString(row, 'id'), ownerUserId: requiredString(row, 'owner_user_id'), name: requiredString(row, 'name'), latestRevision: requiredNumber(row, 'latest_revision'), createdAt: requiredNumber(row, 'created_at'), updatedAt: requiredNumber(row, 'updated_at') };
}
export function device(row: Row): Device {
  const result: Device = { id: requiredString(row, 'id'), userId: requiredString(row, 'user_id'), name: requiredString(row, 'name'), createdAt: requiredNumber(row, 'created_at'), lastSeenAt: requiredNumber(row, 'last_seen_at') };
  const platform = nullableString(row, 'platform');
  if (platform !== null) result.platform = platform;
  return result;
}
export function token(row: Row): ApiToken {
  return { id: requiredString(row, 'id'), userId: requiredString(row, 'user_id'), vaultId: nullableString(row, 'vault_id'), deviceId: nullableString(row, 'device_id'), tokenHash: requiredString(row, 'token_hash'), name: requiredString(row, 'name'), scopes: scopesFromRow(row), createdAt: requiredNumber(row, 'created_at'), lastUsedAt: nullableNumber(row, 'last_used_at'), expiresAt: nullableNumber(row, 'expires_at'), revokedAt: nullableNumber(row, 'revoked_at') };
}
export function blob(row: Row): BlobMetadata {
  return { hash: requiredString(row, 'hash'), size: requiredNumber(row, 'size'), mimeType: nullableString(row, 'mime_type'), createdAt: requiredNumber(row, 'created_at') };
}
export function vaultFile(row: Row): CurrentVaultFile {
  const result: CurrentVaultFile = { fileId: requiredString(row, 'file_id'), vaultId: requiredString(row, 'vault_id'), path: requiredString(row, 'path'), blobHash: requiredString(row, 'blob_hash'), size: requiredNumber(row, 'size'), mtime: requiredNumber(row, 'mtime'), kind: requiredString(row, 'kind') as VaultFileKind, updatedRevision: requiredNumber(row, 'updated_revision') };
  const mimeType = nullableString(row, 'mime_type');
  if (mimeType !== null) result.mimeType = mimeType;
  return result;
}
export function revision(row: Row): VaultRevision {
  return { vaultId: requiredString(row, 'vault_id'), revision: requiredNumber(row, 'revision'), manifestHash: requiredString(row, 'manifest_hash'), deviceId: requiredString(row, 'device_id'), createdAt: requiredNumber(row, 'created_at') };
}
export function fileVersion(row: Row): FileVersion {
  return { id: requiredString(row, 'id'), vaultId: requiredString(row, 'vault_id'), fileId: requiredString(row, 'file_id'), revision: requiredNumber(row, 'revision'), path: requiredString(row, 'path'), blobHash: nullableString(row, 'blob_hash'), size: nullableNumber(row, 'size'), mtime: nullableNumber(row, 'mtime'), changeType: requiredString(row, 'change_type') as FileChangeType, createdAt: requiredNumber(row, 'created_at') };
}
export function noteMetadata(row: Row): NoteMetadata {
  return { fileId: requiredString(row, 'file_id'), vaultId: requiredString(row, 'vault_id'), indexedBlobHash: requiredString(row, 'indexed_blob_hash'), title: nullableString(row, 'title'), frontmatter: metadataJson<Record<string, unknown>>(row, 'frontmatter_json', (v) => typeof v === 'object' && v !== null && !Array.isArray(v)), headings: metadataJson<unknown[]>(row, 'headings_json', Array.isArray), tags: metadataJson<string[]>(row, 'tags_json', (v) => Array.isArray(v) && v.every((x) => typeof x === 'string')), blocks: metadataJson<unknown[]>(row, 'blocks_json', Array.isArray), indexedAt: requiredNumber(row, 'indexed_at') };
}
export function graphCache(row: Row): GraphCacheEntry {
  return { vaultId: requiredString(row, 'vault_id'), revision: requiredNumber(row, 'revision'), indexedRevision: requiredNumber(row, 'indexed_revision'), etag: requiredString(row, 'etag'), payloadJson: requiredString(row, 'payload_json'), updatedAt: requiredNumber(row, 'updated_at') };
}
export function noteLink(row: Row): NoteLink {
  return { id: requiredString(row, 'id'), vaultId: requiredString(row, 'vault_id'), sourceFileId: requiredString(row, 'source_file_id'), rawText: requiredString(row, 'raw_text'), linkPath: requiredString(row, 'link_path'), subpath: nullableString(row, 'subpath'), displayText: nullableString(row, 'display_text'), isEmbed: requiredNumber(row, 'is_embed') === 1, targetFileId: nullableString(row, 'target_file_id'), createdAt: requiredNumber(row, 'created_at') };
}

export function first(db: DatabaseSync, sql: string, ...params: SqliteValue[]): Row | null {
  return (db.prepare(sql).get(...params) as Row | undefined) ?? null;
}
export function all(db: DatabaseSync, sql: string, ...params: SqliteValue[]): Row[] {
  return rows(db.prepare(sql).all(...params));
}
