import type { IdGenerator } from '@tephra/core';

export interface User {
  id: string;
  email: string;
  passwordHash: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface Vault {
  id: string;
  ownerUserId: string;
  name: string;
  latestRevision: number;
  createdAt: number;
  updatedAt: number;
}

export interface Device {
  id: string;
  userId: string;
  name: string;
  platform?: string;
  createdAt: number;
  lastSeenAt: number;
}

export interface Session {
  id: string;
  userId: string;
  expiresAt: number;
  createdAt: number;
}

export type ApiTokenScope = 'vault:read-metadata' | 'vault:upload';

export interface ApiToken {
  id: string;
  userId: string;
  vaultId: string | null;
  deviceId: string | null;
  tokenHash: string;
  name: string;
  scopes: ApiTokenScope[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
}

export interface BlobMetadata {
  hash: string;
  size: number;
  mimeType: string | null;
  createdAt: number;
}

export type VaultFileKind = 'markdown' | 'attachment';

export interface CurrentVaultFile {
  fileId: string;
  vaultId: string;
  path: string;
  blobHash: string;
  size: number;
  mtime: number;
  mimeType?: string;
  kind: VaultFileKind;
  updatedRevision: number;
}

export interface VaultRevision {
  vaultId: string;
  revision: number;
  manifestHash: string;
  deviceId: string;
  createdAt: number;
}

export type FileChangeType = 'create' | 'modify' | 'rename' | 'delete';

export interface FileVersion {
  id: string;
  vaultId: string;
  fileId: string;
  revision: number;
  path: string;
  blobHash: string | null;
  size: number | null;
  mtime: number | null;
  changeType: FileChangeType;
  createdAt: number;
}

export interface NoteMetadata {
  fileId: string;
  vaultId: string;
  indexedBlobHash: string;
  title: string | null;
  frontmatter: Record<string, unknown>;
  headings: unknown[];
  tags: string[];
  blocks: unknown[];
  indexedAt: number;
}

export interface NoteLink {
  id: string;
  vaultId: string;
  sourceFileId: string;
  rawText: string;
  linkPath: string;
  subpath: string | null;
  displayText: string | null;
  isEmbed: boolean;
  targetFileId: string | null;
  createdAt: number;
}

export interface VaultIndexState {
  vaultId: string;
  indexedRevision: number;
  lastError: string | null;
}

export interface IncomingVaultFile {
  fileId: string;
  path: string;
  blobHash: string;
  size: number;
  mtime: number;
  mimeType?: string;
  kind: VaultFileKind;
}

export interface RevisionDiff {
  versions: FileVersion[];
  createdFileIds: string[];
  modifiedFileIds: string[];
  renamedFileIds: string[];
  deletedFileIds: string[];
  isNoOp: boolean;
}

/**
 * Diffs a complete incoming manifest by stable file ID. A simultaneous rename and
 * content change emits both append-only events at the same revision.
 */
export function diffRevision(input: {
  vaultId: string;
  revision: number;
  createdAt: number;
  current: readonly CurrentVaultFile[];
  incoming: readonly IncomingVaultFile[];
  ids: IdGenerator;
}): RevisionDiff {
  const currentById = new Map(input.current.map((file) => [file.fileId, file]));
  const incomingIds = new Set(input.incoming.map((file) => file.fileId));
  const versions: FileVersion[] = [];
  const createdFileIds: string[] = [];
  const modifiedFileIds: string[] = [];
  const renamedFileIds: string[] = [];
  const deletedFileIds: string[] = [];

  const append = (file: IncomingVaultFile, changeType: Exclude<FileChangeType, 'delete'>): void => {
    versions.push({
      id: input.ids.generate(),
      vaultId: input.vaultId,
      fileId: file.fileId,
      revision: input.revision,
      path: file.path,
      blobHash: file.blobHash,
      size: file.size,
      mtime: file.mtime,
      changeType,
      createdAt: input.createdAt,
    });
  };

  for (const file of input.incoming) {
    const previous = currentById.get(file.fileId);
    if (previous === undefined) {
      createdFileIds.push(file.fileId);
      append(file, 'create');
      continue;
    }
    if (previous.path !== file.path) {
      renamedFileIds.push(file.fileId);
      append(file, 'rename');
    }
    if (previous.blobHash !== file.blobHash) {
      modifiedFileIds.push(file.fileId);
      append(file, 'modify');
    }
  }

  for (const file of input.current) {
    if (!incomingIds.has(file.fileId)) {
      deletedFileIds.push(file.fileId);
      versions.push({
        id: input.ids.generate(),
        vaultId: input.vaultId,
        fileId: file.fileId,
        revision: input.revision,
        path: file.path,
        blobHash: null,
        size: null,
        mtime: null,
        changeType: 'delete',
        createdAt: input.createdAt,
      });
    }
  }

  return {
    versions,
    createdFileIds,
    modifiedFileIds,
    renamedFileIds,
    deletedFileIds,
    isNoOp: versions.length === 0,
  };
}
