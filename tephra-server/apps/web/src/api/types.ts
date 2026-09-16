export interface User {
  id: string;
  email: string;
}
export interface Vault {
  id: string;
  name: string;
  latestRevision: number;
  updatedAt?: number;
}
export interface VaultFile {
  fileId: string;
  path: string;
  kind: 'markdown' | 'attachment';
  mimeType?: string;
  size: number;
  mtime: number;
  // Present at runtime: the server's `vaultFileSchema` carries the content
  // hash for every file. The web file list only needs it when editing, so
  // it stays optional here rather than forcing every mock to carry it.
  blobHash?: string;
}
export interface FilesResponse {
  revision: number;
  files: VaultFile[];
  indexPending?: boolean;
}
export interface RenderedNote {
  html: string;
  title?: string | null;
  raw?: string;
  indexPending?: boolean;
}
export interface NoteLink {
  sourceFileId: string;
  sourcePath?: string;
  targetFileId?: string | null;
  targetPath?: string | null;
  displayText?: string | null;
  rawText?: string;
}
export interface LinksResponse {
  links: NoteLink[];
  backlinks?: NoteLink[];
  indexPending?: boolean;
}
export type {
  GraphEdgeDto as GraphEdge,
  GraphNodeDto as GraphNode,
  GraphNodeKind,
  GraphResponse,
} from '@tephra/protocol';
export type ResolveMatch = 'exact' | 'case' | 'normalized' | 'historic';

export interface ResolveResponse {
  match: ResolveMatch;
  requestedPath: string;
  canonicalPath: string;
  file: VaultFile;
  movedFromPath?: string;
  movedAtRevision?: number;
}

export interface ApiToken {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt?: number | null;
  revokedAt?: number | null;
}
export interface CreatedToken extends ApiToken {
  token: string;
}

export type { EditConflictResponse, SaveContentResponse } from '@tephra/protocol';

/** The `current` payload carried by a 409 EDIT_CONFLICT response. */
export interface EditConflictCurrent {
  blobHash: string;
  size: number;
  mtime: number;
  revision: number;
}
