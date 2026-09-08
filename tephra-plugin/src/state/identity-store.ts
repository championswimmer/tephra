import { comparePaths } from '../sync/manifest';
import { dedupePrevEntries } from '../sync/identity/matcher';

/**
 * Sidecar identity cache: `.tephra/data.json` at the vault root
 * (plan 010, §7). Identity only — no hash/size/mtime, so the file changes on
 * create, rename, and delete, never on edit. A cache, not the source of
 * truth: the server's file table is the identity authority (§9).
 */

export const IDENTITY_DIR = '.tephra';
export const IDENTITY_FILE = '.tephra/data.json';
export const IDENTITY_BACKUP_FILE = '.tephra/data.json.bak';
export const IDENTITY_TMP_FILE = '.tephra/data.json.tmp';
export const ID_SCHEME = 'path-seeded-sha256-v1';

/** Minimal surface of Obsidian's DataAdapter used here (mockable in tests). */
export interface IdentityStoreAdapter {
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export interface LoadedIdentityStore {
  ids: Map<string, string>;
  repairNeeded: boolean;
}

interface SidecarDocument {
  version: 1;
  vaultId: string;
  idScheme: string;
  files: Array<[string, string]>;
}

/**
 * Strict validation mirroring `sidecarSchema` (plan 010, §7.2).
 *
 * Hand-rolled rather than zod: zod is not a dependency of tephra-plugin and
 * the shape is small. Semantics match `z.strictObject` — unknown top-level
 * keys reject, `version` must be exactly 1, every pair must be two
 * non-empty strings.
 */
export function parseSidecarDocument(value: unknown): SidecarDocument | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input).sort();
  if (keys.join(',') !== 'files,idScheme,vaultId,version') return undefined;
  if (input['version'] !== 1) return undefined;
  if (typeof input['vaultId'] !== 'string' || input['vaultId'].length === 0) return undefined;
  if (typeof input['idScheme'] !== 'string' || input['idScheme'].length === 0) return undefined;
  if (!Array.isArray(input['files'])) return undefined;
  const files: Array<[string, string]> = [];
  for (const pair of input['files'] as unknown[]) {
    if (!Array.isArray(pair) || pair.length !== 2) return undefined;
    const [path, id] = pair as unknown[];
    if (typeof path !== 'string' || path.length === 0) return undefined;
    if (typeof id !== 'string' || id.length === 0) return undefined;
    files.push([path, id]);
  }
  return {
    version: 1,
    vaultId: input['vaultId'] as string,
    idScheme: input['idScheme'] as string,
    files,
  };
}

/**
 * Deterministic serialization (plan 010, §7.3): array-of-pairs sorted with
 * the manifest's code-point comparator (immune to JS integer-key hoisting
 * and UTF-16 code-unit ordering), one entry per line, trailing newline.
 */
export function serializeIdentityStore(
  vaultId: string,
  ids: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): string {
  const pairs: Array<[string, string]> =
    ids instanceof Map
      ? [...ids.entries()].map(([path, id]): [string, string] => [path, id])
      : Object.entries(ids).map(([path, id]): [string, string] => [path, id]);
  pairs.sort((a, b) => comparePaths(a[0], b[0]));
  const lines = pairs.map(([path, id]) => `    [${JSON.stringify(path)}, ${JSON.stringify(id)}]`);
  return (
    `{\n  "version": 1,\n  "vaultId": ${JSON.stringify(vaultId)},\n` +
    `  "idScheme": ${JSON.stringify(ID_SCHEME)},\n  "files": [\n${lines.join(',\n')}\n  ]\n}\n`
  );
}

function toIdMap(doc: SidecarDocument): Map<string, string> {
  // Deterministic dedupe of corrupt bindings via the matcher helper (§8.1):
  // the code-point-lowest path keeps the id. Entries are stored sorted by
  // path so iteration order is stable regardless of file order.
  const deduped = dedupePrevEntries(
    doc.files.map(([path, fileId]) => ({ path, fileId })),
  ).sort((a, b) => comparePaths(a.path, b.path));
  const ids = new Map<string, string>();
  for (const entry of deduped) ids.set(entry.path, entry.fileId);
  return ids;
}

async function tryRead(
  adapter: IdentityStoreAdapter,
  path: string,
): Promise<SidecarDocument | undefined> {
  try {
    if (!(await adapter.exists(path))) return undefined;
    return parseSidecarDocument(JSON.parse(await adapter.read(path)));
  } catch {
    return undefined;
  }
}

/**
 * Load the sidecar cache. Never throws: missing, corrupt, or foreign content
 * yields an empty map with `repairNeeded` set, so the coordinator repairs
 * from the server (§9.2). A corrupt `data.json` is preserved for inspection
 * as `data.json.corrupt-<ts>`, archived at most once.
 */
export async function loadIdentityStore(
  adapter: IdentityStoreAdapter,
  vaultId: string,
): Promise<LoadedIdentityStore> {
  try {
    const primary = await tryRead(adapter, IDENTITY_FILE);
    if (primary) {
      if (primary.vaultId !== vaultId) {
        // A valid sidecar belonging to a different vault (rebind, restored
        // backup): preserve it untouched, repair from the server.
        return { ids: new Map(), repairNeeded: true };
      }
      if (primary.idScheme !== ID_SCHEME) {
        return { ids: toIdMap(primary), repairNeeded: true };
      }
      return { ids: toIdMap(primary), repairNeeded: false };
    }

    const backup = await tryRead(adapter, IDENTITY_BACKUP_FILE);
    if (backup) {
      if (backup.vaultId !== vaultId || backup.idScheme !== ID_SCHEME) {
        return { ids: new Map(), repairNeeded: true };
      }
      return { ids: toIdMap(backup), repairNeeded: false };
    }

    // Both files missing or invalid: preserve a corrupt primary for
    // inspection (merge conflicts, iCloud damage), then repair.
    try {
      if (await adapter.exists(IDENTITY_FILE)) {
        await adapter.rename(IDENTITY_FILE, `${IDENTITY_FILE}.corrupt-${Date.now()}`);
      }
    } catch {
      // Archiving is best-effort; the repair flag is what matters.
    }
    return { ids: new Map(), repairNeeded: true };
  } catch {
    return { ids: new Map(), repairNeeded: true };
  }
}

// Last serialized text per vault, for only-if-changed writes.
const lastSerializedByVault = new Map<string, string>();

/** Test hook: clear the only-if-changed memory. */
export function resetIdentityStoreCache(): void {
  lastSerializedByVault.clear();
}

/**
 * Persist the sidecar cache. Writes only when the serialized text changed
 * since the last successful write, via a `.tmp` + `.bak` atomic dance.
 */
export async function saveIdentityStore(
  adapter: IdentityStoreAdapter,
  vaultId: string,
  ids: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): Promise<void> {
  const text = serializeIdentityStore(vaultId, ids);
  if (lastSerializedByVault.get(vaultId) === text) return;
  if (!(await adapter.exists(IDENTITY_DIR))) await adapter.mkdir(IDENTITY_DIR);
  await adapter.write(IDENTITY_TMP_FILE, text);
  try {
    await adapter.remove(IDENTITY_BACKUP_FILE);
  } catch {
    // Missing backup is the common case; ignore.
  }
  try {
    await adapter.rename(IDENTITY_FILE, IDENTITY_BACKUP_FILE);
  } catch {
    // No previous file on first write; ignore.
  }
  await adapter.rename(IDENTITY_TMP_FILE, IDENTITY_FILE);
  lastSerializedByVault.set(vaultId, text);
}
