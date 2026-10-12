import type { App, TFile } from 'obsidian';
import type { SyncManifestEntry } from '@tephra/protocol';
import { extractFrontmatterFileId, FILE_ID_PROPERTY, injectFrontmatterFileId } from './frontmatter-id';
import type { IdentityMode } from '../state/plugin-state';
import { sha256Hex } from './hasher';
import { sortManifest } from './manifest';
import { shouldSyncPath } from './syncable-path';
import { mintFileId, randomFileId } from './identity/id-mint';
import { matchIdentities } from './identity/matcher';
import type { CurrEntry, PrevEntry } from './identity/types';

function mimeType(file: TFile): string | undefined {
  if (file.extension.toLowerCase() === 'md') return 'text/markdown';
  const known: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    pdf: 'application/pdf',
    mp3: 'audio/mpeg',
    mp4: 'video/mp4',
    wav: 'audio/wav',
  };
  return known[file.extension.toLowerCase()];
}

export interface ScanCacheEntry {
  hash: string;
  size: number;
  mtime: number;
}

/**
 * Identity inputs for the mode-driven scanner (plan 010, §§7–8).
 *
 * `sidecar`, `scanCache`, and `pendingRenames` are held by reference and —
 * for `scanCache` — updated eagerly in place during `scan()`. The coordinator
 * owns these objects and mutates `pendingRenames` in place (never replacing
 * the array) so the reference stays live. `identityMode` and `vaultId` are
 * re-synced from settings by the coordinator before every scan.
 */
export interface ScannerIdentity {
  identityMode: IdentityMode;
  vaultId: string;
  sidecar: ReadonlyMap<string, string>;
  scanCache: Record<string, ScanCacheEntry>;
  pendingRenames: ReadonlyArray<readonly [string, string]>;
}

export interface ScanResult {
  files: SyncManifestEntry[];
  /** Paths present in both prev and curr whose id differs — churn-guard input. */
  identityChanged: string[];
  /** Complete resolved path → id map; the coordinator persists it when changed. */
  sidecarUpdates: Map<string, string>;
}

interface ScannedFile {
  file: TFile;
  path: string;
  kind: CurrEntry['kind'];
  hash: string;
  size: number;
  mtime: number;
  /** Raw text when the file was read this scan (hash fast-path miss). */
  text?: string | undefined;
}

export class VaultScanner {
  public identityMode: IdentityMode;
  public vaultId: string;
  private readonly sidecar: ReadonlyMap<string, string>;
  private readonly scanCache: Record<string, ScanCacheEntry>;
  private readonly pendingRenames: ReadonlyArray<readonly [string, string]>;
  /** Current-scan entries, retained so the coordinator can re-resolve against the server list. */
  private lastCurr: CurrEntry[] = [];
  private lastMimeTypes = new Map<string, string>();
  private lastFrontmatterIds = new Map<string, string>();

  constructor(
    private readonly app: App,
    identity: ScannerIdentity,
    private readonly beforeFrontmatterWrite: (path: string) => void = () => undefined,
  ) {
    this.identityMode = identity.identityMode;
    this.vaultId = identity.vaultId;
    this.sidecar = identity.sidecar;
    this.scanCache = identity.scanCache;
    this.pendingRenames = identity.pendingRenames;
  }

  /**
   * Scan the vault and resolve identities for the configured mode.
   *
   * - Mode A (`frontmatter`): Markdown ids live in frontmatter and are
   *   written when missing — the only mode that ever writes to a note.
   * - Mode B (`sidecar`): frontmatter ids are read (Stage 1b) but never
   *   written; everything else resolves through the matcher.
   * - Mode C (`path`): every file mints `mintFileId(path)` fresh.
   *
   * Attachments are no longer special: their kind comes from the extension
   * and their ids from the same resolution pipeline as Markdown files.
   */
  async scan(): Promise<ScanResult> {
    const scanned = await this.readFiles();
    // Eager scanCache prune: drop hashes for paths that no longer exist.
    const seen = new Set(scanned.map((entry) => entry.path));
    for (const cachedPath of Object.keys(this.scanCache)) {
      if (!seen.has(cachedPath)) delete this.scanCache[cachedPath];
    }
    const curr: CurrEntry[] = scanned.map(({ path, kind, hash, size, mtime }) => ({
      path,
      kind,
      hash,
      size,
      mtime,
    }));
    const mimeTypes = new Map<string, string>();
    for (const entry of scanned) {
      const type = mimeType(entry.file);
      if (type !== undefined) mimeTypes.set(entry.path, type);
    }
    const frontmatterIds = this.collectFrontmatterIds(scanned);
    this.lastCurr = curr;
    this.lastMimeTypes = mimeTypes;
    this.lastFrontmatterIds = frontmatterIds;

    if (this.identityMode === 'path') {
      return this.resolvePathIdentity(curr, mimeTypes);
    }
    if (this.identityMode === 'frontmatter') {
      await this.ensureFrontmatterIds(scanned, frontmatterIds);
    }
    const prev = this.sidecarPrev();
    const matched = await matchIdentities(prev, curr, {
      hints: this.normalizedHints(),
      frontmatterIds,
      vaultId: this.vaultId,
    });
    return this.toScanResult(matched.resolved, matched.identityChanged, mimeTypes);
  }

  /**
   * Re-resolve the last scan's entries against the server file list
   * (`hash = blobHash`), for coordinator repair (plan 010, §9.3). Mode C
   * still mints fresh — the server list is only used for churn accounting.
   */
  async resolveWithServerPrev(serverPrev: readonly PrevEntry[]): Promise<ScanResult> {
    if (this.lastCurr.length === 0) throw new Error('No scan has been performed yet.');
    if (this.identityMode === 'path') {
      return this.resolvePathIdentity(this.lastCurr, this.lastMimeTypes);
    }
    const matched = await matchIdentities(serverPrev, this.lastCurr, {
      hints: this.normalizedHints(),
      frontmatterIds: this.lastFrontmatterIds,
      vaultId: this.vaultId,
    });
    return this.toScanResult(matched.resolved, matched.identityChanged, this.lastMimeTypes);
  }

  /**
   * Read every syncable file, NFC-normalizing paths at the boundary (plan
   * 010, §14.1) and reusing hashes via the scanCache mtime/size fast path.
   */
  private async readFiles(): Promise<ScannedFile[]> {
    const scanned: ScannedFile[] = [];
    for (const file of this.app.vault.getFiles()) {
      // NFC first: the normalized path enters the manifest, the sidecar, and
      // the mint input, so a macOS (NFD) vault stays syncable and converges
      // with Linux/Windows devices.
      const path = file.path.normalize('NFC');
      if (!shouldSyncPath(path)) continue;
      const kind: CurrEntry['kind'] = file.extension.toLowerCase() === 'md' ? 'markdown' : 'attachment';
      const { size, mtime } = file.stat;
      const cached = this.scanCache[path];
      if (cached && cached.size === size && cached.mtime === mtime) {
        scanned.push({ file, path, kind, hash: cached.hash, size, mtime });
        continue;
      }
      let hash: string;
      let text: string | undefined;
      if (kind === 'markdown') {
        text = await this.app.vault.read(file);
        hash = await sha256Hex(new TextEncoder().encode(text));
      } else {
        const bytes = new Uint8Array(await this.app.vault.readBinary(file));
        hash = await sha256Hex(bytes);
      }
      this.scanCache[path] = { hash, size, mtime };
      scanned.push({ file, path, kind, hash, size, mtime, text });
    }
    return scanned;
  }

  /** Sidecar ∪ scanCache as matcher prev (plan 010, §8): ids from the sidecar, hashes from the cache. */
  private sidecarPrev(): PrevEntry[] {
    const prev: PrevEntry[] = [];
    for (const [rawPath, fileId] of this.sidecar) {
      const path = rawPath.normalize('NFC');
      const cached = this.scanCache[path];
      prev.push(cached ? { path, fileId, hash: cached.hash } : { path, fileId });
    }
    return prev;
  }

  private normalizedHints(): Array<[string, string]> {
    return this.pendingRenames.map(
      ([oldPath, newPath]): [string, string] => [oldPath.normalize('NFC'), newPath.normalize('NFC')],
    );
  }

  /**
   * Read-only frontmatter id collection (matcher Stage 1b). Sources in
   * order: Obsidian's parsed `metadataCache` (no I/O), then text already
   * loaded for hashing this scan. Files on the hash fast path without a
   * cache entry are skipped rather than re-read.
   */
  private collectFrontmatterIds(scanned: readonly ScannedFile[]): Map<string, string> {
    const ids = new Map<string, string>();
    for (const entry of scanned) {
      if (entry.kind !== 'markdown') continue;
      try {
        const frontmatter = this.app.metadataCache.getFileCache(entry.file)?.frontmatter;
        const existing = frontmatter?.[FILE_ID_PROPERTY];
        if (typeof existing === 'string' && existing.trim()) {
          ids.set(entry.path, existing.trim());
          continue;
        }
      } catch {
        // Obsidian cache lookup failed; fall through to the raw read.
      }
      if (entry.text !== undefined) {
        const rawId = extractFrontmatterFileId(entry.text);
        if (rawId) ids.set(entry.path, rawId);
      }
    }
    return ids;
  }

  /**
   * Mode A only: mint ids for Markdown files lacking one and write them into
   * frontmatter (with the raw-injection fallback for invalid YAML). Minting
   * goes against the claimed set with a random-UUID fallback on collision,
   * mirroring matcher Stage 4.
   */
  private async ensureFrontmatterIds(
    scanned: readonly ScannedFile[],
    frontmatterIds: Map<string, string>,
  ): Promise<void> {
    const claimed = new Set<string>([...this.sidecar.values(), ...frontmatterIds.values()]);
    for (const entry of scanned) {
      if (entry.kind !== 'markdown' || frontmatterIds.has(entry.path)) continue;
      // A sidecar binding means the id was already written (or adopted) on
      // an earlier scan — reusing it keeps identity stable when the
      // frontmatter is unreadable this scan (hash fast path, no cache entry)
      // instead of minting a colliding id and rewriting the note.
      const sidecarId = this.sidecar.get(entry.path);
      if (sidecarId) {
        frontmatterIds.set(entry.path, sidecarId);
        continue;
      }
      let id = await mintFileId(this.vaultId, entry.path, entry.kind);
      while (claimed.has(id)) id = randomFileId();
      claimed.add(id);
      const written = await this.writeMarkdownFileId(entry.file, id, entry.text);
      // Even when the write fails the id is adopted for this scan (and the
      // sidecar), so the manifest stays valid; the write is retried next scan.
      frontmatterIds.set(entry.path, id);
      void written;
    }
  }

  private async resolvePathIdentity(
    curr: readonly CurrEntry[],
    mimeTypes: ReadonlyMap<string, string>,
  ): Promise<ScanResult> {
    // Mode C: always mint fresh, never remember — but still account churn
    // against the sidecar so the coordinator's guard sees the full blast.
    const claimed = new Set<string>();
    const resolved = new Array<CurrEntry & { fileId: string }>();
    for (const entry of curr) {
      let fileId = await mintFileId(this.vaultId, entry.path, entry.kind);
      while (claimed.has(fileId)) fileId = randomFileId();
      claimed.add(fileId);
      resolved.push({ ...entry, fileId });
    }
    const prevByPath = new Map<string, string>();
    for (const [rawPath, fileId] of this.sidecar) prevByPath.set(rawPath.normalize('NFC'), fileId);
    const identityChanged = resolved
      .filter((entry) => {
        const before = prevByPath.get(entry.path);
        return before !== undefined && before !== entry.fileId;
      })
      .map((entry) => entry.path)
      .sort();
    return this.toScanResult(resolved, identityChanged, mimeTypes);
  }

  private toScanResult(
    resolved: ReadonlyArray<CurrEntry & { fileId: string }>,
    identityChanged: string[],
    mimeTypes: ReadonlyMap<string, string>,
  ): ScanResult {
    const files: SyncManifestEntry[] = resolved.map((entry) => {
      const type = mimeTypes.get(entry.path);
      return {
        fileId: entry.fileId,
        path: entry.path,
        hash: entry.hash,
        size: entry.size,
        mtime: entry.mtime,
        ...(type === undefined ? {} : { mimeType: type }),
        kind: entry.kind,
      };
    });
    const sidecarUpdates = new Map<string, string>(
      resolved.map((entry): [string, string] => [entry.path, entry.fileId]),
    );
    return { files: sortManifest(files), identityChanged, sidecarUpdates };
  }

  private async writeMarkdownFileId(
    file: TFile,
    id: string,
    existingContent?: string,
  ): Promise<boolean> {
    try {
      this.beforeFrontmatterWrite(file.path);
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter[FILE_ID_PROPERTY] = id;
      });
      return true;
    } catch {
      // processFrontMatter fails when YAML syntax is invalid (e.g. Templater {{VALUE:tags}} or syntax errors).
      // Fall back to direct content modification to avoid crashing the sync coordinator.
      try {
        const content = existingContent ?? (await this.app.vault.read(file));
        const updated = injectFrontmatterFileId(content, id);
        this.beforeFrontmatterWrite(file.path);
        await this.app.vault.modify(file, updated);
        return true;
      } catch (writeError) {
        console.warn(
          `[tephra] Could not write frontmatter ID for ${file.path}:`,
          writeError instanceof Error ? writeError.message : writeError,
        );
        return false;
      }
    }
  }
}
