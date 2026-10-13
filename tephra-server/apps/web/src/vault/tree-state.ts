/**
 * Persisted file-tree expansion state. Folders are collapsed by default; only
 * the set of *expanded* folder paths is stored, per vault, in localStorage.
 * Stored data is untrusted: malformed values are discarded and paths that no
 * longer exist in the vault are pruned silently.
 */
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export function treeStateKey(vaultId: string): string {
  return `tephra:tree:${vaultId}`;
}

function defaultStorage(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function sanitizeExpanded(raw: unknown): Set<string> {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as { expanded?: unknown }).expanded
      : undefined;
  if (!Array.isArray(source)) return new Set();
  return new Set(source.filter((value): value is string => typeof value === 'string' && !!value));
}

export function loadExpandedFolders(
  vaultId: string,
  storage: StorageLike | null = defaultStorage(),
): Set<string> {
  try {
    const raw = storage?.getItem(treeStateKey(vaultId));
    return sanitizeExpanded(raw ? JSON.parse(raw) : null);
  } catch {
    return new Set();
  }
}

export function saveExpandedFolders(
  vaultId: string,
  expanded: ReadonlySet<string>,
  storage: StorageLike | null = defaultStorage(),
): void {
  try {
    storage?.setItem(treeStateKey(vaultId), JSON.stringify({ expanded: [...expanded].sort() }));
  } catch {
    // Storage may be unavailable (private mode); tree state simply doesn't persist.
  }
}

/** Drop paths that are not current folders; returns the input when nothing changed. */
export function pruneExpanded(
  expanded: ReadonlySet<string>,
  folders: ReadonlySet<string>,
): ReadonlySet<string> {
  let stale = false;
  for (const path of expanded) {
    if (!folders.has(path)) {
      stale = true;
      break;
    }
  }
  if (!stale) return expanded;
  return new Set([...expanded].filter((path) => folders.has(path)));
}
