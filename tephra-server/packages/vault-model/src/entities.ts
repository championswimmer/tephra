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

export type ApiTokenScope = 'vault:read-metadata' | 'vault:upload' | 'vault:write';

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
