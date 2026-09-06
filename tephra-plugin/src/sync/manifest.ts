import { canonicalManifestJson, type SyncManifestEntry } from '@tephra/protocol';
import { sha256Hex } from './hasher';

export function comparePaths(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const difference = (a[index]?.codePointAt(0) ?? 0) - (b[index]?.codePointAt(0) ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

export function sortManifest(files: readonly SyncManifestEntry[]): SyncManifestEntry[] {
  return [...files].sort((a, b) => comparePaths(a.path, b.path));
}

export async function manifestHash(files: readonly SyncManifestEntry[]): Promise<string> {
  return sha256Hex(new TextEncoder().encode(canonicalManifestJson(files)));
}
