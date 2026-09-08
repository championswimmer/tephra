import type { App } from 'obsidian';
import type { IdentityMode } from '../../state/plugin-state';
import {
  FILE_ID_PROPERTY,
  extractFrontmatterFileId,
  injectFrontmatterFileId,
} from '../scanner';
import { mintFileId } from './id-mint';
import type { VaultFileKind } from './types';

/**
 * Mode-switch dry runs and vault-writing migration steps (plan 010, §12).
 *
 * The dry run is pure (no Obsidian imports at runtime, no I/O): the caller
 * supplies one entry per syncable file and gets back the
 * preserved/changed/rewrites/bytes/links report. Every switch starts with a
 * dry run; `changed > 0` requires explicit confirmation.
 *
 * Identity model for the dry run: `currentId` is the server-known identity
 * approximation (the sidecar map); `frontmatterId` is harvestable identity
 * living inside the note. The effective current identity is
 * `currentId ?? frontmatterId`, so an A vault with an empty sidecar still
 * reports correctly.
 *
 * Target identity per direction:
 * - to `sidecar` (A→B harvest, C→B adopt): `effective ?? mint` — zero churn.
 * - to `frontmatter` (B→A): same ids, but rewritten into notes.
 * - to `path` (anything→C): always `mint` — changed unless the vault was
 *   already path-seeded with no renames (the pleasant no-op case).
 */

export interface MigrationEntry {
  path: string;
  kind: VaultFileKind;
  /** Byte size of the note, for the re-upload estimate. Defaults to 0. */
  size?: number | undefined;
  /** Server-known identity approximation (sidecar binding). */
  currentId?: string | undefined;
  /** `tephra-file-id` readable from the note's frontmatter. */
  frontmatterId?: string | undefined;
}

export interface MigrationDryRun {
  from: IdentityMode;
  to: IdentityMode;
  /** Files whose identity survives the switch (including brand-new files). */
  preserved: number;
  /** Files whose identity changes — confirmation gating input. */
  changed: number;
  /** Notes that must be rewritten in the vault (B→A only). */
  rewrites: number;
  /** Approximate bytes to re-upload (sum of rewritten note sizes). */
  bytesToUpload: number;
  /** Shared links that will break. Always equals `changed`. */
  linksBreaking: number;
  changedPaths: string[];
  rewritePaths: string[];
}

export interface DryRunOptions {
  vaultId: string;
}

/** Explicit confirmation is required exactly when `changed > 0` (§12). */
export function migrationNeedsConfirmation(report: MigrationDryRun): boolean {
  return report.changed > 0;
}

function emptyReport(from: IdentityMode, to: IdentityMode, total: number): MigrationDryRun {
  return {
    from,
    to,
    preserved: total,
    changed: 0,
    rewrites: 0,
    bytesToUpload: 0,
    linksBreaking: 0,
    changedPaths: [],
    rewritePaths: [],
  };
}

export async function dryRunIdentityMigration(
  from: IdentityMode,
  to: IdentityMode,
  entries: readonly MigrationEntry[],
  opts: DryRunOptions,
): Promise<MigrationDryRun> {
  if (from === to) return emptyReport(from, to, entries.length);
  const changedPaths: string[] = [];
  const rewritePaths: string[] = [];
  let preserved = 0;
  let bytesToUpload = 0;
  for (const entry of entries) {
    const effective = entry.currentId ?? entry.frontmatterId;
    const target =
      to === 'path'
        ? await mintFileId(opts.vaultId, entry.path, entry.kind)
        : (effective ?? (await mintFileId(opts.vaultId, entry.path, entry.kind)));
    // Files with no recorded identity are new, not changed: nothing breaks.
    if (effective === undefined || target === effective) preserved += 1;
    else changedPaths.push(entry.path);
    if (to === 'frontmatter' && entry.kind === 'markdown' && entry.frontmatterId !== target) {
      rewritePaths.push(entry.path);
      bytesToUpload += entry.size ?? 0;
    }
  }
  changedPaths.sort();
  rewritePaths.sort();
  return {
    from,
    to,
    preserved,
    changed: changedPaths.length,
    rewrites: rewritePaths.length,
    bytesToUpload,
    linksBreaking: changedPaths.length,
    changedPaths,
    rewritePaths,
  };
}

/**
 * A→B harvest step: read every `tephra-file-id` from `metadataCache`
 * (already parsed — no extra I/O), falling back to a raw content read for
 * files the cache does not cover. Read-only; never writes to a note.
 */
export async function harvestFrontmatterIds(app: App): Promise<Map<string, string>> {
  const harvested = new Map<string, string>();
  for (const file of app.vault.getMarkdownFiles()) {
    try {
      const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
      const cached = frontmatter?.[FILE_ID_PROPERTY];
      if (typeof cached === 'string' && cached.trim()) {
        harvested.set(file.path, cached.trim());
        continue;
      }
    } catch {
      // Obsidian cache lookup failed; fall through to the raw content read.
    }
    try {
      const id = extractFrontmatterFileId(await app.vault.read(file));
      if (id) harvested.set(file.path, id);
    } catch {
      // Unreadable files simply contribute nothing to the harvest.
    }
  }
  return harvested;
}

export interface FrontmatterWriteResult {
  written: string[];
  failed: Array<{ path: string; reason: string }>;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * B→A write step: write each sidecar id into the file's frontmatter via
 * `processFrontMatter`, with the raw-injection fallback for invalid YAML
 * (mirroring the scanner's mode-A write path). Failures keep their sidecar
 * id — the caller must retain the sidecar — and are listed in the result.
 */
export async function writeSidecarIdsToFrontmatter(
  app: App,
  targets: ReadonlyMap<string, string>,
  opts: { beforeWrite?: (path: string) => void } = {},
): Promise<FrontmatterWriteResult> {
  const written: string[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  for (const [path, id] of targets) {
    try {
      const file = app.vault.getFileByPath(path);
      if (!file) {
        failed.push({ path, reason: 'file not found in vault' });
        continue;
      }
      try {
        opts.beforeWrite?.(path);
        await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          frontmatter[FILE_ID_PROPERTY] = id;
        });
        written.push(path);
      } catch {
        // Invalid YAML (e.g. Templater placeholders) — raw fallback.
        let content: string;
        try {
          content = await app.vault.read(file);
        } catch (readError) {
          failed.push({ path, reason: reasonOf(readError) });
          continue;
        }
        try {
          opts.beforeWrite?.(path);
          await app.vault.modify(file, injectFrontmatterFileId(content, id));
          written.push(path);
        } catch (writeError) {
          failed.push({ path, reason: reasonOf(writeError) });
        }
      }
    } catch (error) {
      failed.push({ path, reason: reasonOf(error) });
    }
  }
  written.sort();
  return { written, failed };
}
