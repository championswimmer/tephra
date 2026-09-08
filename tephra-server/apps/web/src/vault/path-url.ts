/**
 * Path-addressed hash URLs (`#/path/to/file.md`).
 *
 * The vault path lives in the URL fragment so note paths are never sent to
 * the server and stay out of access logs. Each `/`-separated segment is
 * encoded with `encodeURIComponent` (NFC-normalized first); `/` stays
 * literal so the URL still reads like a path.
 */

/** Normalize to NFC, then percent-encode every `/`-separated segment. */
export function encodePathForHash(path: string): string {
  return path
    .normalize('NFC')
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** Build the `#/...` fragment for a vault-relative path. */
export function hashForPath(path: string): string {
  return `#/${encodePathForHash(path)}`;
}

/**
 * Parse a `location.hash` value back into a vault-relative path.
 * Returns `undefined` for an empty hash (`''`, `'#'`, `'#/'`).
 */
export function decodeHashToPath(hash: string): string | undefined {
  const stripped = hash.startsWith('#') ? hash.slice(1) : hash;
  const withoutSlash = stripped.startsWith('/') ? stripped.slice(1) : stripped;
  if (!withoutSlash) return undefined;
  const segments = withoutSlash.split('/');
  const decoded: string[] = [];
  for (const segment of segments) {
    try {
      decoded.push(decodeURIComponent(segment));
    } catch {
      return undefined;
    }
  }
  const path = decoded.join('/');
  return path ? path : undefined;
}

export type HashView = { type: 'home' | 'graph' | 'tokens' | 'file'; path?: string };

/**
 * Map the `*` splat (vault-level views) plus `location.hash` (note address)
 * onto a view. Non-file views stay path-routed; notes are hash-routed.
 */
export function parseHashView(rest: string | undefined, hash: string): HashView {
  if (rest === 'graph') return { type: 'graph' };
  if (rest === 'tokens') return { type: 'tokens' };
  const path = decodeHashToPath(hash);
  if (path === undefined) return { type: 'home' };
  return { type: 'file', path };
}
