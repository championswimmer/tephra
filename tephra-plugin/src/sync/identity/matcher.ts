import { comparePaths } from '../manifest';
import { mintFileId, randomFileId } from './id-mint';
import type { CurrEntry, MatchResult, PrevEntry } from './types';

export interface MatchOptions {
  /** Durable rename hints as (oldPath, newPath) pairs. Chains are resolved. */
  hints?: ReadonlyArray<readonly [string, string]>;
  /** Frontmatter `tephra-file-id` by current path (mode B, read-only). */
  frontmatterIds?: ReadonlyMap<string, string>;
  /** Salt for path-seeded minting. */
  vaultId: string;
  /** Kind override for minting; defaults to the scan entry's own kind. */
  kindOf?: (path: string) => CurrEntry['kind'];
  /** Ids already claimed outside prev/curr (e.g. the scanner's claimed set). */
  claimedExtra?: ReadonlySet<string>;
}

/**
 * Loader dedupe helper (plan 010, §8.1): a corrupt sidecar can bind the same
 * id to two paths. The code-point-lowest path keeps the binding; the other
 * entry is dropped to unknown (it will re-resolve through the later stages).
 */
export function dedupePrevEntries(prev: readonly PrevEntry[]): PrevEntry[] {
  const byId = new Map<string, PrevEntry[]>();
  for (const entry of prev) {
    const group = byId.get(entry.fileId);
    if (group) group.push(entry);
    else byId.set(entry.fileId, [entry]);
  }
  const deduped: PrevEntry[] = [];
  for (const group of byId.values()) {
    if (group.length === 1) {
      const only = group[0];
      if (only) deduped.push(only);
      continue;
    }
    let winner = group[0];
    for (const candidate of group) {
      if (winner && comparePaths(candidate.path, winner.path) < 0) winner = candidate;
    }
    if (winner) deduped.push(winner);
  }
  return deduped;
}

/** Resolve hint chains to their terminal path: A→B→C yields A→C. */
function resolveHintTerminals(
  hints: ReadonlyArray<readonly [string, string]>,
): Array<[string, string]> {
  const direct = new Map<string, string>();
  for (const [oldPath, newPath] of hints) {
    if (oldPath !== newPath) direct.set(oldPath, newPath);
  }
  const resolved: Array<[string, string]> = [];
  for (const [origin] of direct) {
    let terminal = origin;
    const seen = new Set<string>([origin]);
    let next = direct.get(terminal);
    while (next !== undefined && !seen.has(next)) {
      seen.add(next);
      terminal = next;
      next = direct.get(terminal);
    }
    if (terminal !== origin) resolved.push([origin, terminal]);
  }
  return resolved;
}

/**
 * Pure identity matcher (plan 010, §8). Stages run in strict precedence
 * order, each consuming from `unmatchedPrev` / `unmatchedCurr`:
 *
 * - Stage 0: durable rename hints (chains resolved to the terminal path).
 * - Stage 1: exact path match keeps the id, regardless of hash.
 * - Stage 1b: frontmatter ids for residuals, if unclaimed.
 * - Stage 2: hash-grouped positional pairing of residuals (rename/move).
 * - Stage 3 (implicit): unresolvable residuals become delete + mint.
 * - Stage 4: mint against the claimed set, random-UUID fallback on collision.
 *
 * Async only because path-seeded minting hashes; no I/O, no Obsidian imports.
 */
export async function matchIdentities(
  prev: readonly PrevEntry[],
  curr: readonly CurrEntry[],
  opts: MatchOptions,
): Promise<MatchResult> {
  const dedupedPrev = dedupePrevEntries(prev);
  const prevByPath = new Map<string, PrevEntry>();
  for (const entry of dedupedPrev) {
    if (!prevByPath.has(entry.path)) prevByPath.set(entry.path, entry);
  }
  const currByPath = new Map<string, CurrEntry>();
  for (const entry of curr) {
    if (!currByPath.has(entry.path)) currByPath.set(entry.path, entry);
  }

  // Raw prev bindings (pre-dedupe) for the identityChanged comparison.
  const rawPrevByPath = new Map<string, string>();
  for (const entry of prev) {
    if (!rawPrevByPath.has(entry.path)) rawPrevByPath.set(entry.path, entry.fileId);
  }

  // Every prev id is claimed from the start: reusing a deleted id for a new
  // file would silently merge two histories, so Stage 4 must avoid those too.
  const claimed = new Set<string>();
  for (const entry of dedupedPrev) claimed.add(entry.fileId);
  if (opts.claimedExtra) for (const id of opts.claimedExtra) claimed.add(id);

  const resolved: MatchResult['resolved'] = [];
  const hintRebound = new Set<string>();

  // --- Stage 0: rename hints (rebind prev to the terminal path) ---
  for (const [origin, terminal] of resolveHintTerminals(opts.hints ?? [])) {
    const moved = prevByPath.get(origin);
    if (!moved) continue;
    if (prevByPath.has(terminal)) continue;
    if (!currByPath.has(terminal)) continue;
    prevByPath.delete(origin);
    const rebound: PrevEntry = { ...moved, path: terminal };
    prevByPath.set(terminal, rebound);
    hintRebound.add(terminal);
  }

  const unmatchedPrev = new Map(prevByPath);
  const unmatchedCurr = new Map(currByPath);

  const bind = (
    currEntry: CurrEntry,
    fileId: string,
    origin: MatchResult['resolved'][number]['origin'],
  ): void => {
    claimed.add(fileId);
    unmatchedCurr.delete(currEntry.path);
    resolved.push({ ...currEntry, fileId, origin });
  };

  // --- Stage 1: exact path match keeps the id, regardless of hash ---
  for (const entry of curr) {
    const previous = unmatchedPrev.get(entry.path);
    if (!previous) continue;
    unmatchedPrev.delete(entry.path);
    bind(entry, previous.fileId, hintRebound.has(entry.path) ? 'hint' : 'path');
  }

  // --- Stage 1b: frontmatter ids for residuals, if unclaimed ---
  // Winner for a duplicated frontmatter id is the path prev records for that
  // id, else the code-point-lowest claimant; losers fall through.
  const prevIdToPath = new Map<string, string>();
  for (const entry of dedupedPrev) {
    if (!prevIdToPath.has(entry.fileId)) prevIdToPath.set(entry.fileId, entry.path);
  }
  if (opts.frontmatterIds && opts.frontmatterIds.size > 0) {
    const claimants = new Map<string, CurrEntry[]>();
    for (const entry of unmatchedCurr.values()) {
      const claimedId = opts.frontmatterIds.get(entry.path);
      if (!claimedId) continue;
      const group = claimants.get(claimedId);
      if (group) group.push(entry);
      else claimants.set(claimedId, [entry]);
    }
    const fmIds = [...claimants.keys()].sort();
    for (const fmId of fmIds) {
      if (claimed.has(fmId)) continue;
      const group = claimants.get(fmId) ?? [];
      group.sort((a, b) => comparePaths(a.path, b.path));
      const recordedPath = prevIdToPath.get(fmId);
      const recorded =
        recordedPath !== undefined
          ? group.find((c) => c.path === recordedPath)
          : undefined;
      const winner = recorded ?? group[0];
      if (winner) bind(winner, fmId, 'frontmatter');
    }
  }

  // --- Stage 2: hash-grouped positional pairing over residuals ---
  const prevByHash = new Map<string, PrevEntry[]>();
  for (const entry of unmatchedPrev.values()) {
    if (entry.hash === undefined) continue;
    const group = prevByHash.get(entry.hash);
    if (group) group.push(entry);
    else prevByHash.set(entry.hash, [entry]);
  }
  const currByHash = new Map<string, CurrEntry[]>();
  for (const entry of unmatchedCurr.values()) {
    const group = currByHash.get(entry.hash);
    if (group) group.push(entry);
    else currByHash.set(entry.hash, [entry]);
  }
  const hashes = [...currByHash.keys()].sort();
  const deletedIds: string[] = [];
  for (const hash of hashes) {
    const left = prevByHash.get(hash);
    if (!left || left.length === 0) continue;
    const right = currByHash.get(hash) ?? [];
    left.sort((a, b) => comparePaths(a.path, b.path));
    right.sort((a, b) => comparePaths(a.path, b.path));
    const pairs = Math.min(left.length, right.length);
    for (let index = 0; index < pairs; index += 1) {
      const from = left[index];
      const to = right[index];
      if (!from || !to) continue;
      unmatchedPrev.delete(from.path);
      bind(to, from.fileId, 'hash');
    }
  }

  // --- Stage 3 (implicit): leftover prev entries are deletions ---
  const leftoverPrev = [...unmatchedPrev.values()].sort((a, b) =>
    comparePaths(a.path, b.path),
  );
  for (const entry of leftoverPrev) deletedIds.push(entry.fileId);

  // --- Stage 4: mint newcomers against the claimed set ---
  const newcomers = [...unmatchedCurr.values()].sort((a, b) =>
    comparePaths(a.path, b.path),
  );
  for (const entry of newcomers) {
    const kind = opts.kindOf?.(entry.path) ?? entry.kind;
    let fileId = await mintFileId(opts.vaultId, entry.path, kind);
    while (claimed.has(fileId)) fileId = randomFileId();
    bind(entry, fileId, 'mint');
  }

  resolved.sort((a, b) => comparePaths(a.path, b.path));

  const identityChanged: string[] = [];
  for (const entry of resolved) {
    const before = rawPrevByPath.get(entry.path);
    if (before !== undefined && before !== entry.fileId) identityChanged.push(entry.path);
  }
  identityChanged.sort(comparePaths);

  return { resolved, deletedIds, identityChanged };
}
