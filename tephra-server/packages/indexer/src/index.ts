import type { ParsedNote } from '@tephra/markdown';
import { createVaultPathIndex, resolveLink, type VaultPathEntry } from '@tephra/link-resolver';
import type { CurrentVaultFile, NoteLink, NoteMetadata } from '@tephra/vault-model';

export interface ParsedVaultNote {
  fileId: string;
  parsed: ParsedNote;
}

export interface IndexRows {
  metadata: NoteMetadata[];
  links: NoteLink[];
  reindexedSourceFileIds: string[];
}

export interface GraphNode {
  id: string;
  path: string;
  title: string;
}

export interface GraphEdge {
  source: string;
  target: string;
  count: number;
  embedCount: number;
}

export interface NoteGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface LinkReindexPlan {
  sourceFileIds: string[];
  resolutionMayHaveChanged: boolean;
}

const pathEntries = (files: readonly CurrentVaultFile[]): VaultPathEntry[] => files.map((file) => ({
  fileId: file.fileId,
  path: file.path,
  kind: file.kind,
}));

function titleFor(file: CurrentVaultFile, parsed: ParsedNote): string | null {
  const title = parsed.frontmatter.title;
  if (typeof title === 'string' && title.trim() !== '') return title.trim();
  if (parsed.headings[0]?.text) return parsed.headings[0].text;
  return file.path.split('/').at(-1)?.replace(/\.md$/i, '') ?? null;
}

/**
 * Build replaceable derived rows from a complete current-vault snapshot.
 * All links are resolved again so a newly created/renamed/deleted target cannot
 * leave stale target_file_id values behind.
 */
export function buildIndexRows(input: {
  vaultId: string;
  files: readonly CurrentVaultFile[];
  notes: readonly ParsedVaultNote[];
  indexedAt: number;
  generateId: () => string;
}): IndexRows {
  const filesById = new Map(input.files.map((file) => [file.fileId, file]));
  const index = createVaultPathIndex(pathEntries(input.files));
  const metadata: NoteMetadata[] = [];
  const links: NoteLink[] = [];
  const reindexedSourceFileIds: string[] = [];

  for (const note of input.notes) {
    const file = filesById.get(note.fileId);
    if (!file || file.kind !== 'markdown') continue;
    reindexedSourceFileIds.push(file.fileId);
    metadata.push({
      fileId: file.fileId,
      vaultId: input.vaultId,
      indexedBlobHash: file.blobHash,
      title: titleFor(file, note.parsed),
      frontmatter: note.parsed.frontmatter,
      headings: note.parsed.headings,
      tags: note.parsed.tags,
      blocks: note.parsed.blocks,
      indexedAt: input.indexedAt,
    });
    for (const link of note.parsed.links) {
      const resolution = resolveLink(file.path, `${link.linkPath}${link.subpath ? `#${link.subpath}` : ''}`, index);
      // External Markdown URLs are metadata, but never graph-resolvable vault links.
      const external = link.syntax === 'markdown' && (/^[a-z][a-z\d+.-]*:/i.test(link.linkPath) || link.linkPath.startsWith('//'));
      links.push({
        id: input.generateId(),
        vaultId: input.vaultId,
        sourceFileId: file.fileId,
        rawText: link.raw,
        linkPath: link.linkPath,
        subpath: link.subpath ?? null,
        displayText: link.displayText ?? null,
        isEmbed: link.isEmbed,
        targetFileId: external ? null : resolution.targetFileId,
        createdAt: input.indexedAt,
      });
    }
  }
  return { metadata, links, reindexedSourceFileIds };
}

/**
 * Resolution depends on the complete path set, not only source contents. Any
 * path-set change therefore schedules every current Markdown source for cheap
 * link-row replacement. Blob-only changes reindex only changed notes.
 */
export function planLinkReindex(input: {
  previousFiles: readonly CurrentVaultFile[];
  currentFiles: readonly CurrentVaultFile[];
  changedMarkdownFileIds?: readonly string[];
}): LinkReindexPlan {
  const signature = (files: readonly CurrentVaultFile[]): string => files
    .map((file) => `${file.fileId}\u0000${file.path}\u0000${file.kind}`)
    .sort()
    .join('\u0001');
  const resolutionMayHaveChanged = signature(input.previousFiles) !== signature(input.currentFiles);
  const sourceFileIds = resolutionMayHaveChanged
    ? input.currentFiles.filter((file) => file.kind === 'markdown').map((file) => file.fileId)
    : [...new Set(input.changedMarkdownFileIds ?? [])];
  sourceFileIds.sort();
  return { sourceFileIds, resolutionMayHaveChanged };
}

export const GRAPH_NODE_LIMIT = 10_000;

export interface GraphPayloadNode {
  id: string;
  path: string;
  title: string | null;
  kind: 'note' | 'attachment' | 'tag' | 'unresolved';
  tags: string[];
  createdAt: number;
}

export interface GraphPayloadEdge {
  s: number;
  t: number;
  count: number;
  embeds: number;
}

export interface GraphPayload {
  revision: number;
  truncated: boolean;
  indexPending?: boolean;
  nodes: GraphPayloadNode[];
  edges: GraphPayloadEdge[];
}

/**
 * Build the GET /vaults/:vaultId/graph payload v2 (plan 011): markdown
 * notes plus synthesized attachment, tag, and unresolved-link nodes; edges
 * reference nodes by array index to keep the payload small at ~30k edges.
 * Pure derived state of the three inputs plus the two revisions.
 */
export function buildGraphPayload(input: {
  files: readonly CurrentVaultFile[];
  metadataRows: readonly NoteMetadata[];
  links: readonly NoteLink[];
  latestRevision: number;
  indexedRevision: number;
}): GraphPayload {
  const metadata = new Map(input.metadataRows.map((item) => [item.fileId, item]));

  type NodeSeed = {
    id: string;
    path: string;
    title: string | null;
    kind: 'note' | 'attachment' | 'tag' | 'unresolved';
    tags: string[];
    createdAt: number;
  };
  // Ordering doubles as the trim preference: markdown notes first, then
  // attachments, then synthesized tag/unresolved nodes.
  const notes: NodeSeed[] = [];
  const attachments: NodeSeed[] = [];
  for (const file of input.files) {
    const meta = metadata.get(file.fileId);
    const seed: NodeSeed = {
      id: file.fileId,
      path: file.path,
      title: meta?.title ?? null,
      kind: file.kind === 'markdown' ? 'note' : 'attachment',
      tags: file.kind === 'markdown' ? (meta?.tags ?? []) : [],
      createdAt: file.mtime,
    };
    (file.kind === 'markdown' ? notes : attachments).push(seed);
  }
  notes.sort((left, right) => left.path.localeCompare(right.path));
  attachments.sort((left, right) => left.path.localeCompare(right.path));

  // Tag nodes are synthesized from indexed note metadata; their createdAt
  // inherits the oldest tagged note so time-lapse reveals them with it.
  const tagCreatedAt = new Map<string, number>();
  for (const note of notes)
    for (const tag of note.tags) {
      const current = tagCreatedAt.get(tag);
      if (current === undefined || note.createdAt < current)
        tagCreatedAt.set(tag, note.createdAt);
    }
  const tags: NodeSeed[] = [...tagCreatedAt.keys()].sort().map((name) => ({
    id: `tag:${name}`,
    path: name,
    title: `#${name}`,
    kind: 'tag',
    tags: [],
    createdAt: tagCreatedAt.get(name) ?? 0,
  }));

  // Unresolved nodes come from links with a null target, deduped by the
  // normalized raw link path.
  const mtimeByFileId = new Map(input.files.map((file) => [file.fileId, file.mtime]));
  const unresolved = new Map<string, NodeSeed>();
  for (const link of input.links) {
    if (link.targetFileId !== null) continue;
    const key = link.linkPath.normalize('NFC').trim();
    if (key.length === 0) continue;
    const sourceCreatedAt = mtimeByFileId.get(link.sourceFileId) ?? 0;
    const existing = unresolved.get(key);
    if (existing) {
      if (sourceCreatedAt > 0 && (existing.createdAt === 0 || sourceCreatedAt < existing.createdAt))
        existing.createdAt = sourceCreatedAt;
    } else {
      unresolved.set(key, {
        id: `unresolved:${key}`,
        path: key,
        title: key.split('/').at(-1) ?? key,
        kind: 'unresolved',
        tags: [],
        createdAt: sourceCreatedAt,
      });
    }
  }
  const unresolvedNodes = [...unresolved.values()].sort((left, right) =>
    left.path.localeCompare(right.path),
  );

  const all = [...notes, ...attachments, ...tags, ...unresolvedNodes];
  const truncated = all.length > GRAPH_NODE_LIMIT;
  const nodes = all.slice(0, GRAPH_NODE_LIMIT);
  const indexById = new Map(nodes.map((node, index) => [node.id, index]));

  const edgeMap = new Map<string, { s: number; t: number; count: number; embeds: number }>();
  const addEdge = (s: number, t: number, embed: boolean) => {
    const key = `${s}\0${t}`;
    const existing = edgeMap.get(key);
    if (existing) {
      existing.count += 1;
      if (embed) existing.embeds += 1;
    } else {
      edgeMap.set(key, { s, t, count: 1, embeds: embed ? 1 : 0 });
    }
  };
  for (const link of input.links) {
    const s = indexById.get(link.sourceFileId);
    if (s === undefined) continue;
    const targetId =
      link.targetFileId ?? `unresolved:${link.linkPath.normalize('NFC').trim()}`;
    const t = indexById.get(targetId);
    if (t !== undefined) addEdge(s, t, link.isEmbed);
  }
  for (const note of notes) {
    const s = indexById.get(note.id);
    if (s === undefined) continue;
    for (const tag of note.tags) {
      const t = indexById.get(`tag:${tag}`);
      if (t !== undefined) addEdge(s, t, false);
    }
  }

  return {
    revision: input.latestRevision,
    truncated,
    ...(input.indexedRevision < input.latestRevision ? { indexPending: true } : {}),
    nodes,
    edges: [...edgeMap.values()],
  };
}

export function buildGraph(input: {
  files: readonly CurrentVaultFile[];
  metadata: readonly NoteMetadata[];
  links: readonly NoteLink[];
}): NoteGraph {
  const markdownIds = new Set(input.files.filter((file) => file.kind === 'markdown').map((file) => file.fileId));
  const metadataById = new Map(input.metadata.map((row) => [row.fileId, row]));
  const nodes = input.files
    .filter((file) => file.kind === 'markdown')
    .map((file) => ({ id: file.fileId, path: file.path, title: metadataById.get(file.fileId)?.title ?? file.path.split('/').at(-1)?.replace(/\.md$/i, '') ?? file.path }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const aggregated = new Map<string, GraphEdge>();
  for (const link of input.links) {
    if (link.targetFileId === null || !markdownIds.has(link.sourceFileId) || !markdownIds.has(link.targetFileId)) continue;
    const key = `${link.sourceFileId}\u0000${link.targetFileId}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.count += 1;
      if (link.isEmbed) existing.embedCount += 1;
    } else {
      aggregated.set(key, { source: link.sourceFileId, target: link.targetFileId, count: 1, embedCount: link.isEmbed ? 1 : 0 });
    }
  }
  const edges = [...aggregated.values()].sort((left, right) => left.source.localeCompare(right.source) || left.target.localeCompare(right.target));
  return { nodes, edges };
}
