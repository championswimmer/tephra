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
