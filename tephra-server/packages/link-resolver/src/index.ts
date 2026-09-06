export interface VaultPathEntry {
  fileId: string;
  path: string;
  kind: 'markdown' | 'attachment';
}

export interface VaultPathIndex {
  files: readonly VaultPathEntry[];
}

export type LinkResolutionStatus = 'resolved' | 'unresolved' | 'ambiguous';

export interface ResolveLinkResult {
  targetFileId: string | null;
  targetPath: string | null;
  targetKind: 'markdown' | 'attachment' | null;
  subpath: string | null;
  status: LinkResolutionStatus;
  unresolved: boolean;
  ambiguous: boolean;
  candidates: readonly string[];
}

export function createVaultPathIndex(files: readonly VaultPathEntry[]): VaultPathIndex {
  return { files: [...files].sort((left, right) => left.path.localeCompare(right.path)) };
}

function decode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function normalize(value: string): string | null {
  const decoded = decode(value).replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
  const output: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      if (output.length === 0) return null;
      output.pop();
    } else output.push(segment);
  }
  return output.join('/');
}

function noteComparisonPath(path: string, kind: VaultPathEntry['kind']): string {
  return kind === 'markdown' ? path.replace(/\.md$/i, '') : path;
}

function splitSubpath(input: string): { path: string; subpath: string | null } {
  const hash = input.indexOf('#');
  if (hash < 0) return { path: input, subpath: null };
  return { path: input.slice(0, hash), subpath: decode(input.slice(hash + 1)) || null };
}

function result(status: LinkResolutionStatus, entry: VaultPathEntry | undefined, subpath: string | null, candidates: readonly VaultPathEntry[] = []): ResolveLinkResult {
  return {
    targetFileId: entry?.fileId ?? null,
    targetPath: entry?.path ?? null,
    targetKind: entry?.kind ?? null,
    subpath,
    status,
    unresolved: status !== 'resolved',
    ambiguous: status === 'ambiguous',
    candidates: candidates.map((candidate) => candidate.path),
  };
}

function choose(matches: readonly VaultPathEntry[], subpath: string | null): ResolveLinkResult | undefined {
  if (matches.length === 1) return result('resolved', matches[0], subpath);
  if (matches.length > 1) return result('ambiguous', undefined, subpath, matches);
  return undefined;
}

/** Resolve an Obsidian target against a snapshot of current vault paths. */
export function resolveLink(sourcePath: string, rawLinkPath: string, index: VaultPathIndex): ResolveLinkResult {
  const split = splitSubpath(rawLinkPath);
  const target = normalize(split.path);
  if (target === null) return result('unresolved', undefined, split.subpath);
  const entries = index.files.map((entry) => ({ entry, comparison: noteComparisonPath(normalize(entry.path) ?? entry.path, entry.kind) }));
  if (target === '') {
    const normalizedSource = normalize(sourcePath);
    const source = entries.find(({ entry }) => normalize(entry.path) === normalizedSource)?.entry;
    return source ? result('resolved', source, split.subpath) : result('unresolved', undefined, split.subpath);
  }
  const targetWithoutMd = target.replace(/\.md$/i, '');

  // Explicit root-relative path has priority.
  const exact = choose(entries.filter(({ entry, comparison }) => comparison === targetWithoutMd || normalize(entry.path) === target).map(({ entry }) => entry), split.subpath);
  if (exact) return exact;

  const sourceFolder = (normalize(sourcePath) ?? sourcePath).split('/').slice(0, -1).join('/');
  const relative = normalize(sourceFolder === '' ? target : `${sourceFolder}/${target}`);
  if (relative !== null) {
    const relativeWithoutMd = relative.replace(/\.md$/i, '');
    const match = choose(entries.filter(({ entry, comparison }) => comparison === relativeWithoutMd || normalize(entry.path) === relative).map(({ entry }) => entry), split.subpath);
    if (match) return match;
  }

  // Folder-qualified links may omit leading folders. They resolve only when unique.
  if (targetWithoutMd.includes('/')) {
    const suffix = choose(entries.filter(({ comparison }) => comparison === targetWithoutMd || comparison.endsWith(`/${targetWithoutMd}`)).map(({ entry }) => entry), split.subpath);
    if (suffix) return suffix;
  }

  // Obsidian's shortest-link behavior: a basename is safe only if unique.
  const basename = targetWithoutMd.split('/').at(-1)?.toLocaleLowerCase() ?? '';
  const basenameMatches = entries.filter(({ comparison }) => comparison.split('/').at(-1)?.toLocaleLowerCase() === basename).map(({ entry }) => entry);
  if (basenameMatches.length === 1) return result('resolved', basenameMatches[0], split.subpath);
  if (basenameMatches.length > 1) {
    const sourceFolders = sourceFolder.split('/').filter(Boolean);
    const ranked = basenameMatches.map((entry) => {
      const folders = (normalize(entry.path) ?? entry.path).split('/').slice(0, -1);
      let common = 0;
      while (sourceFolders[common] === folders[common] && common < sourceFolders.length && common < folders.length) common += 1;
      return { entry, common, distance: sourceFolders.length + folders.length - (2 * common) };
    }).sort((left, right) => right.common - left.common || left.distance - right.distance || left.entry.path.localeCompare(right.entry.path));
    const first = ranked[0];
    const second = ranked[1];
    if (first && second && (first.common !== second.common || first.distance !== second.distance)) return result('resolved', first.entry, split.subpath);
    return result('ambiguous', undefined, split.subpath, ranked.map(({ entry }) => entry));
  }
  return result('unresolved', undefined, split.subpath);
}

export function isAttachmentEmbed(input: { isEmbed: boolean; resolution: ResolveLinkResult }): boolean {
  return input.isEmbed && input.resolution.status === 'resolved' && input.resolution.targetKind === 'attachment';
}
