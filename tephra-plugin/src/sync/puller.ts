import type { App } from 'obsidian';
import {
  isCanonicalVaultPath,
  type ChangeEntry,
  type ChangesResponse,
} from '@tephra/protocol';
import { TephraHttpError, type TephraClientLike } from '../api/client';
import type { TephraPluginState } from '../state/plugin-state';
import { sha256Hex } from './hasher';

/** Page size for the pull walk; the server caps at 500. */
export const PULL_PAGE_LIMIT = 200;

/** Minimal vault surface the pull phase needs — faked wholesale in tests. */
export interface PullFileInfo {
  path: string;
  extension: string;
  size: number;
  mtime: number;
}

export interface PullVault {
  /** File at `path`, falling back to a case-insensitive path match. */
  getFile(path: string): PullFileInfo | null;
  exists(path: string): boolean;
  readText(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  /** Creates or overwrites a note; suppresses the vault echo via the adapter. */
  writeText(path: string, text: string): Promise<void>;
  /** Creates or overwrites an attachment, binary-safe. */
  writeBinary(path: string, bytes: Uint8Array): Promise<void>;
  /** Trash (falling back to delete) an existing file. */
  remove(path: string): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
}

export type PullOutcome =
  | { outcome: 'ok'; applied: number; toRevision: number }
  | { outcome: 'full-resync' }
  | { outcome: 'legacy' }
  | { outcome: 'skipped-first-sync' };

export interface PullDeps {
  app: App;
  client: TephraClientLike;
  state: TephraPluginState;
  saveState: () => Promise<void>;
  suppressPath?: ((path: string) => void) | undefined;
  /** YYYY-MM-DD stamp for conflicted copies; defaults to today (UTC). */
  conflictedDate?: string | undefined;
  /** Injected in tests; defaults to the live Obsidian adapter. */
  vault?: PullVault | undefined;
}

interface PullContext {
  client: TephraClientLike;
  state: TephraPluginState;
  vault: PullVault;
  conflictedDate: string;
}

function sanitizeCursor(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isNotFound(error: unknown): boolean {
  return error instanceof TephraHttpError && error.status === 404;
}

/**
 * Pull phase (plan 017, Phase 4): apply the server `/changes` feed before
 * the push. The server manifest is fetched once for fresh kind truth; pages
 * walk forward from `lastPulledRevision` (default 0, full history walk) and
 * the cursor persists after every successfully applied page — never on
 * full-resync-required. A 404 from `/changes` means a pre-pull server:
 * fall back to the legacy full-manifest reconcile.
 */
export async function pullRemoteChanges(deps: PullDeps): Promise<PullOutcome> {
  const { client, state } = deps;
  if (state.lastRemoteRevision === undefined) return { outcome: 'skipped-first-sync' };
  const vault = deps.vault ?? obsidianPullVault(deps.app, deps.suppressPath ?? (() => undefined));
  const ctx: PullContext = {
    client,
    state,
    vault,
    conflictedDate: deps.conflictedDate ?? new Date().toISOString().slice(0, 10),
  };
  const manifest = await client.listFiles();
  const serverKind = new Map(manifest.files.map((file) => [file.fileId, file.kind] as const));
  let cursor = sanitizeCursor(state.lastPulledRevision);
  let applied = 0;
  // Single-file pull loop: entries apply sequentially, never concurrently
  // for the same path — the set turns a programming error into a loud failure.
  const inFlight = new Set<string>();
  for (;;) {
    let page: ChangesResponse;
    try {
      page = await client.changes(cursor, PULL_PAGE_LIMIT);
    } catch (error) {
      if (isNotFound(error)) return { outcome: 'legacy' };
      throw error;
    }
    if (page.status === 'full-resync-required') {
      state.identityRepairNeeded = true;
      return { outcome: 'full-resync' };
    }
    for (const entry of page.changes) {
      if (inFlight.has(entry.path))
        throw new Error(`Concurrent pull for the same path: ${entry.path}`);
      inFlight.add(entry.path);
      try {
        if (await applyEntry(ctx, entry, serverKind)) applied += 1;
      } finally {
        inFlight.delete(entry.path);
      }
    }
    cursor = page.toRevision;
    state.lastPulledRevision = cursor;
    await deps.saveState();
    if (!page.truncated) break;
  }
  return { outcome: 'ok', applied, toRevision: cursor };
}

async function applyEntry(
  ctx: PullContext,
  entry: ChangeEntry,
  serverKind: Map<string, 'markdown' | 'attachment'>,
): Promise<boolean> {
  // (a) Canonical path rules mirror the push validation: anything else is
  // skipped with a warning, never written.
  if (!isCanonicalVaultPath(entry.path)) {
    console.warn(`[tephra] Skipping server change with non-canonical path: ${entry.path}`);
    return false;
  }
  const local = ctx.vault.getFile(entry.path);
  const kind = classifyKind(entry, local, serverKind);
  if (entry.changeType === 'delete') return applyDelete(ctx, entry, local);
  if (entry.changeType === 'rename' && entry.previousPath) {
    const moved = await applyRename(ctx, entry);
    if (moved) return true;
    // Fell through: previous path missing or diverged — upsert at the new path.
  }
  return applyUpsert(ctx, entry, local, kind, serverKind);
}

/**
 * Four-way kind rule: 1) deletes trust the entry kind (no bytes to fetch);
 * 2) a local file at the path wins via its own extension (the adapter
 * matches case-insensitively, so case-only collisions classify locally);
 * 3) the manifest fetched once per pull is the freshest server truth;
 * 4) the entry kind, else the `.md` extension rule defaulting to attachment.
 */
function classifyKind(
  entry: ChangeEntry,
  local: PullFileInfo | null,
  serverKind: ReadonlyMap<string, 'markdown' | 'attachment'>,
): 'markdown' | 'attachment' {
  if (entry.changeType === 'delete') return entry.kind;
  if (local) return local.extension.toLowerCase() === 'md' ? 'markdown' : 'attachment';
  const fromManifest = serverKind.get(entry.fileId);
  if (fromManifest) return fromManifest;
  if (entry.kind) return entry.kind;
  return entry.path.toLowerCase().endsWith('.md') ? 'markdown' : 'attachment';
}

/** Blob hash is authoritative; mtime is never consulted (clock skew). */
async function localHash(ctx: PullContext, info: PullFileInfo): Promise<string> {
  // scanCache mtime+size fast path: reuse the hash without re-reading.
  const cached = ctx.state.scanCache[info.path];
  if (cached && cached.size === info.size && cached.mtime === info.mtime) return cached.hash;
  const bytes =
    info.extension.toLowerCase() === 'md'
      ? new TextEncoder().encode(await ctx.vault.readText(info.path))
      : await ctx.vault.readBinary(info.path);
  return sha256Hex(bytes);
}

/**
 * Integrity failure carrying both hashes so the pull loop can tell a
 * superseded changelog entry (the file moved on server-side) from a
 * genuinely unreadable blob.
 */
export class BlobIntegrityError extends Error {
  constructor(
    readonly path: string,
    readonly advertised: string,
    readonly actual: string,
  ) {
    super(
      `Blob hash mismatch for ${path}: changelog advertised ${advertised}, downloaded ${actual}.`,
    );
    this.name = 'BlobIntegrityError';
  }
}

/** Verify the downloaded bytes against the advertised hash before touching the vault. */
async function downloadVerified(ctx: PullContext, entry: ChangeEntry): Promise<Uint8Array> {
  const remoteHash = entry.blobHash;
  if (!remoteHash) throw new Error(`Server change without blob hash: ${entry.path}`);
  const bytes = await ctx.client.readContent(entry.fileId);
  const actual = await sha256Hex(bytes);
  if (actual !== remoteHash) throw new BlobIntegrityError(entry.path, remoteHash, actual);
  return bytes;
}

/**
 * Self-healing download: a changelog entry can advertise a hash the content
 * endpoint no longer serves — the file was modified again after the page was
 * read, so `/content` (current bytes by file id) disagrees with the
 * historical entry. Aborting the whole sync over that wedges the plugin on
 * every run; instead refresh the server manifest once and:
 * - superseded (or server-deleted) entry → warn and skip it; the newer
 *   entry later in the walk (or the next sync) carries the current state;
 * - otherwise retry once (mid-commit race / truncated download), then warn
 *   and skip so the sync still completes. The vault is never written with
 *   unverified bytes; the following push phase reconverges the ledger.
 * Returns `null` when the entry was skipped. Non-integrity failures
 * (offline, auth, …) and an unreachable manifest refresh rethrow — the
 * sync must retry those, never silently advance past them.
 */
async function downloadResilient(
  ctx: PullContext,
  entry: ChangeEntry,
  serverKind: Map<string, 'markdown' | 'attachment'>,
): Promise<Uint8Array | null> {
  try {
    return await downloadVerified(ctx, entry);
  } catch (error) {
    if (!(error instanceof BlobIntegrityError) && !isNotFound(error)) throw error;
    const advertised = entry.blobHash ?? '(missing)';
    const actual = error instanceof BlobIntegrityError ? error.actual : undefined;
    let fresh: Awaited<ReturnType<PullContext['client']['listFiles']>>;
    try {
      fresh = await ctx.client.listFiles();
    } catch {
      throw error;
    }
    for (const file of fresh.files) serverKind.set(file.fileId, file.kind);
    const current = fresh.files.find((file) => file.fileId === entry.fileId);
    if (!current) {
      console.warn(
        `[tephra] Skipping change for ${entry.path}: file is gone from the server (advertised ${advertised}).`,
      );
      return null;
    }
    if (actual !== undefined && current.blobHash === actual) {
      console.warn(
        `[tephra] Skipping superseded change for ${entry.path} at revision ${String(entry.revision)}: server is already at ${current.blobHash}.`,
      );
      return null;
    }
    if (current.blobHash !== entry.blobHash) {
      // The server moved on but the single download matches neither hash
      // (race between the page read and the download) — a newer entry in
      // this walk (or the next sync) carries the state.
      console.warn(
        `[tephra] Skipping superseded change for ${entry.path} at revision ${String(entry.revision)}: server is at ${current.blobHash}, downloaded ${actual ?? '(unavailable)'}.`,
      );
      return null;
    }
    // Not superseded: the server still advertises this hash, so retry once
    // before giving up (mid-commit race or truncated download).
    try {
      return await downloadVerified(ctx, entry);
    } catch (retryError) {
      if (!(retryError instanceof BlobIntegrityError) && !isNotFound(retryError))
        throw retryError;
      console.warn(
        `[tephra] Skipping change for ${entry.path}: downloaded bytes do not match advertised ${advertised}; sync continues and the push phase reconverges.`,
      );
      return null;
    }
  }
}

async function applyUpsert(
  ctx: PullContext,
  entry: ChangeEntry,
  local: PullFileInfo | null,
  kind: 'markdown' | 'attachment',
  serverKind: Map<string, 'markdown' | 'attachment'>,
): Promise<boolean> {
  const remoteHash = entry.blobHash;
  if (!remoteHash) {
    console.warn(`[tephra] Skipping server change without blob hash: ${entry.path}`);
    return false;
  }
  if (!local) {
    const bytes = await downloadResilient(ctx, entry, serverKind);
    if (!bytes) return false;
    await writeKindBytes(ctx, entry.path, bytes, kind);
    setStateEntry(ctx, entry, kind, bytes);
    return true;
  }
  const current = await localHash(ctx, local);
  // Hash-equal entries just advance the cursor — even when mtimes lie.
  if (current === remoteHash) {
    refreshManifestBaseline(ctx, entry, kind);
    return false;
  }
  const previous = ctx.state.manifest[entry.path]?.hash;
  const bytes = await downloadResilient(ctx, entry, serverKind);
  if (!bytes) return false;
  if (previous !== undefined && current === previous) {
    // Untouched since the last pull/push: safe to overwrite. Markdown goes
    // through UTF-8 decode, byte-compare, then modify, binary-safe.
    if (kind === 'markdown') {
      const text = decodeMarkdown(bytes, entry.path);
      const localBytes = new TextEncoder().encode(await ctx.vault.readText(entry.path));
      if (!bytesEqual(localBytes, bytes)) await ctx.vault.writeText(entry.path, text);
    } else {
      await ctx.vault.writeBinary(entry.path, bytes);
    }
    setStateEntry(ctx, entry, kind, bytes);
    return true;
  }
  // Conflict rule (§8.4): the local file diverged since the last pull/push.
  // Last-write-wins for the bytes, but local bytes are never silently
  // destroyed — the server version lands in a conflicted copy instead.
  const copyPath = allocateConflictedCopy(ctx, entry.path, kind);
  await writeKindBytes(ctx, copyPath, bytes, kind);
  return true;
}

async function applyRename(ctx: PullContext, entry: ChangeEntry): Promise<boolean> {
  const remoteHash = entry.blobHash;
  const previousPath = entry.previousPath;
  if (!remoteHash || !previousPath) return false;
  const atPath = ctx.vault.getFile(entry.path);
  if (atPath && (await localHash(ctx, atPath)) === remoteHash) {
    refreshManifestBaseline(ctx, entry, entry.kind);
    return true;
  }
  const atPrevious = ctx.vault.getFile(previousPath);
  // Only carry the rename over when the local file is untouched; a diverged
  // previous path stays put and the caller upserts at the new path.
  if (!atPath && atPrevious && (await localHash(ctx, atPrevious)) === remoteHash) {
    await ctx.vault.rename(previousPath, entry.path);
    const previousManifest = ctx.state.manifest[previousPath];
    ctx.state.manifest[entry.path] = {
      fileId: entry.fileId,
      path: entry.path,
      hash: remoteHash,
      size: entry.size ?? previousManifest?.size ?? 0,
      mtime: entry.mtime ?? previousManifest?.mtime ?? Date.now(),
      kind: entry.kind,
    };
    if (previousManifest) delete ctx.state.manifest[previousPath];
    const previousCache = ctx.state.scanCache[previousPath];
    if (previousCache) {
      ctx.state.scanCache[entry.path] = previousCache;
      delete ctx.state.scanCache[previousPath];
    }
    return true;
  }
  return false;
}

async function applyDelete(
  ctx: PullContext,
  entry: ChangeEntry,
  local: PullFileInfo | null,
): Promise<boolean> {
  if (!local) return false;
  const current = await localHash(ctx, local);
  // The tombstoned blob is the last-synced hash: delete only when the local
  // file still matches it; a diverged file wins and stays put.
  const tombstoned = ctx.state.manifest[entry.path]?.hash;
  if (tombstoned !== undefined && current === tombstoned) {
    await ctx.vault.remove(entry.path);
    delete ctx.state.manifest[entry.path];
    delete ctx.state.scanCache[entry.path];
    return true;
  }
  console.warn(`[tephra] Keeping locally modified file over server delete: ${entry.path}`);
  return false;
}

function decodeMarkdown(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`Server blob for ${path} is not valid UTF-8.`);
  }
}

async function writeKindBytes(
  ctx: PullContext,
  path: string,
  bytes: Uint8Array,
  kind: 'markdown' | 'attachment',
): Promise<void> {
  if (kind === 'markdown') await ctx.vault.writeText(path, decodeMarkdown(bytes, path));
  else await ctx.vault.writeBinary(path, bytes);
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function allocateConflictedCopy(
  ctx: PullContext,
  path: string,
  kind: 'markdown' | 'attachment',
): string {
  const slash = path.lastIndexOf('/');
  const dir = slash >= 0 ? path.slice(0, slash) : '';
  const base = slash >= 0 ? path.slice(slash + 1) : path;
  const dot = base.lastIndexOf('.');
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = kind === 'markdown' ? '.md' : dot > 0 ? base.slice(dot) : '';
  const prefix = dir ? `${dir}/` : '';
  let candidate = `${prefix}${stem} (server conflicted copy, ${ctx.conflictedDate})${ext}`;
  let counter = 2;
  while (ctx.vault.exists(candidate)) {
    candidate = `${prefix}${stem} (server conflicted copy, ${ctx.conflictedDate}) (${String(counter)})${ext}`;
    counter += 1;
  }
  return candidate;
}

function refreshManifestBaseline(
  ctx: PullContext,
  entry: ChangeEntry,
  kind: 'markdown' | 'attachment',
): void {
  if (!entry.blobHash) return;
  ctx.state.manifest[entry.path] = {
    fileId: entry.fileId,
    path: entry.path,
    hash: entry.blobHash,
    size: entry.size ?? ctx.state.manifest[entry.path]?.size ?? 0,
    mtime: entry.mtime ?? ctx.state.manifest[entry.path]?.mtime ?? Date.now(),
    kind,
  };
}

function setStateEntry(
  ctx: PullContext,
  entry: ChangeEntry,
  kind: 'markdown' | 'attachment',
  bytes: Uint8Array,
): void {
  if (!entry.blobHash) return;
  ctx.state.manifest[entry.path] = {
    fileId: entry.fileId,
    path: entry.path,
    hash: entry.blobHash,
    size: entry.size ?? bytes.byteLength,
    mtime: entry.mtime ?? Date.now(),
    kind,
  };
  const restated = ctx.vault.getFile(entry.path);
  if (restated)
    ctx.state.scanCache[entry.path] = {
      hash: entry.blobHash,
      size: restated.size,
      mtime: restated.mtime,
    };
}

/**
 * Live Obsidian adapter. Duck-types vault files (no `TFile` value import,
 * so the shim-based unit tests never touch the real module): anything with
 * a string `extension` counts as a file.
 */
export function obsidianPullVault(
  app: App,
  suppress: (path: string) => void,
): PullVault {
  const vault = app.vault;
  const isFile = (value: unknown): value is { path: string; extension: string } =>
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { path?: unknown }).path === 'string' &&
    typeof (value as { extension?: unknown }).extension === 'string';

  const fileAt = (path: string): { path: string; extension: string } | null => {
    const direct = vault.getAbstractFileByPath(path);
    if (isFile(direct)) return direct;
    // Case-insensitive fallback for the kind-classification rule.
    const lowered = path.toLowerCase();
    for (const file of vault.getFiles()) {
      if (file.path.toLowerCase() === lowered && isFile(file)) return file;
    }
    return null;
  };

  const statOf = (path: string): PullFileInfo | null => {
    const file = fileAt(path);
    if (!file) return null;
    const sized = file as { stat?: { size?: number; mtime?: number } };
    return {
      path: file.path,
      extension: file.extension,
      size: sized.stat?.size ?? 0,
      mtime: sized.stat?.mtime ?? 0,
    };
  };

  const ensureParent = async (path: string): Promise<void> => {
    const slash = path.lastIndexOf('/');
    if (slash <= 0) return;
    const parent = path.slice(0, slash);
    if (vault.getAbstractFileByPath(parent)) return;
    try {
      await vault.createFolder(parent);
    } catch {
      // Raced with another writer; the write below proves existence.
    }
  };

  return {
    getFile: (path) => statOf(path),
    exists: (path) => vault.getAbstractFileByPath(path) !== null,
    readText: async (path) => {
      const file = fileAt(path);
      if (!file) throw new Error(`File disappeared during pull: ${path}`);
      return vault.read(file as never);
    },
    readBinary: async (path) => {
      const file = fileAt(path);
      if (!file) throw new Error(`File disappeared during pull: ${path}`);
      return new Uint8Array(await vault.readBinary(file as never));
    },
    writeText: async (path, text) => {
      suppress(path);
      const file = fileAt(path);
      if (file) await vault.modify(file as never, text);
      else {
        await ensureParent(path);
        await vault.create(path, text);
      }
    },
    writeBinary: async (path, bytes) => {
      suppress(path);
      const file = fileAt(path);
      const buffer = Uint8Array.from(bytes).buffer as ArrayBuffer;
      if (file) await vault.adapter.writeBinary(file.path, buffer);
      else {
        await ensureParent(path);
        await vault.createBinary(path, buffer);
      }
    },
    remove: async (path) => {
      const file = fileAt(path);
      if (!file) return;
      suppress(path);
      try {
        await vault.trash(file as never, false);
      } catch {
        await vault.delete(file as never, false);
      }
    },
    rename: async (oldPath, newPath) => {
      const file = fileAt(oldPath);
      if (!file) throw new Error(`File disappeared during pull: ${oldPath}`);
      suppress(oldPath);
      suppress(newPath);
      await ensureParent(newPath);
      await vault.rename(file as never, newPath);
    },
  };
}
