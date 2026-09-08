/**
 * Identity-matching types for the pure matcher (plan 010, §8).
 *
 * `PrevEntry` is the union shape of every identity source the matcher can be
 * fed: the sidecar cache, the server file list (`hash = blobHash`), or the
 * scan cache. `CurrEntry` is the current scan. The matcher never touches
 * Obsidian APIs or the network.
 */
export type VaultFileKind = 'markdown' | 'attachment';

export interface PrevEntry {
  path: string;
  fileId: string;
  hash?: string;
}

export interface CurrEntry {
  path: string;
  hash: string;
  size: number;
  mtime: number;
  kind: VaultFileKind;
}

export type IdentityOrigin = 'hint' | 'path' | 'frontmatter' | 'hash' | 'mint';

export interface MatchResult {
  resolved: Array<CurrEntry & { fileId: string; origin: IdentityOrigin }>;
  deletedIds: string[];
  /** Paths present in both prev and curr whose id differs — churn-guard input. */
  identityChanged: string[];
}
