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
export interface GraphResponse {
  revision: number;
  nodes: { id: string; path: string; title: string | null }[];
  edges: { source: string; target: string; count: number }[];
  indexPending?: boolean;
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
