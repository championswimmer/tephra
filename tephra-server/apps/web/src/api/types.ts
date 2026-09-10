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
export type GraphNodeKind = 'note' | 'attachment' | 'tag' | 'unresolved';
export interface GraphNode {
  /** File id for note/attachment nodes; `tag:<name>` / `unresolved:<path>` otherwise. */
  id: string;
  /** Canonical vault path for files; tag name / raw link path for synthesized nodes. */
  path: string;
  title: string | null;
  kind: GraphNodeKind;
  tags: string[];
  createdAt: number;
}
export interface GraphEdge {
  /** Index into `nodes`. */
  s: number;
  /** Index into `nodes`. */
  t: number;
  count: number;
  embeds: number;
}
export interface GraphResponse {
  revision: number;
  truncated: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  indexPending?: boolean;
}
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
