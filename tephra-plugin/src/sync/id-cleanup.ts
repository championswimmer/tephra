import type { App } from 'obsidian';
import { extractFrontmatterFileId, FILE_ID_PROPERTY, stripFrontmatterFileId } from './scanner';

export interface FileIdEntry {
  path: string;
  id: string;
}

export interface RemoveFileIdsOptions {
  /** Files processed per chunk before yielding back to the event loop. Defaults to 25. */
  chunkSize?: number;
  onProgress?: (done: number, total: number) => void;
  /** Suppression hook (e.g. beforeFrontmatterWrite) invoked before every vault write. */
  beforeWrite?: (path: string) => void;
}

export interface RemoveFileIdsFailure {
  path: string;
  reason: string;
}

export interface RemoveFileIdsResult {
  removed: number;
  skipped: number;
  failed: RemoveFileIdsFailure[];
}

const DEFAULT_CHUNK_SIZE = 25;

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Preview sweep: find every Markdown file that currently carries a
 * `tephra-file-id`. Covers all Markdown files, including ones the sync
 * manifest excludes, so an uninstall leaves nothing behind. Prefers the
 * already-parsed metadataCache frontmatter, falling back to a raw read.
 */
export async function scanForFileIds(app: App): Promise<FileIdEntry[]> {
  const found: FileIdEntry[] = [];
  for (const file of app.vault.getMarkdownFiles()) {
    let id: string | undefined;
    try {
      const frontmatter = app.metadataCache.getFileCache(file)?.frontmatter;
      const cached = frontmatter?.[FILE_ID_PROPERTY];
      if (typeof cached === 'string' && cached.trim()) id = cached.trim();
    } catch {
      // Obsidian cache lookup failed; fall through to the raw content read.
    }
    if (!id) {
      try {
        const content = await app.vault.read(file);
        id = extractFrontmatterFileId(content);
      } catch {
        continue;
      }
    }
    if (id) found.push({ path: file.path, id });
  }
  return found;
}

/**
 * Remove the `tephra-file-id` property from every listed file. Processed in
 * chunks with a yield between chunks so mobile stays responsive. One file's
 * failure never aborts the batch; failures are collected in the result.
 */
export async function removeFileIds(
  app: App,
  files: readonly FileIdEntry[],
  opts: RemoveFileIdsOptions = {},
): Promise<RemoveFileIdsResult> {
  const chunkSize = Math.max(1, opts.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const result: RemoveFileIdsResult = { removed: 0, skipped: 0, failed: [] };
  const total = files.length;
  for (let start = 0; start < files.length; start += chunkSize) {
    const chunk = files.slice(start, start + chunkSize);
    for (const entry of chunk) {
      const outcome = await removeSingleFileId(app, entry, opts);
      if (outcome === 'removed') result.removed += 1;
      else if (outcome === 'skipped') result.skipped += 1;
      else result.failed.push(outcome);
    }
    opts.onProgress?.(Math.min(start + chunk.length, total), total);
    if (start + chunkSize < files.length) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    }
  }
  return result;
}

async function removeSingleFileId(
  app: App,
  entry: FileIdEntry,
  opts: RemoveFileIdsOptions,
): Promise<'removed' | 'skipped' | RemoveFileIdsFailure> {
  try {
    const file = app.vault.getFileByPath(entry.path);
    if (!file) return 'skipped';
    try {
      opts.beforeWrite?.(entry.path);
      await app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
        delete frontmatter[FILE_ID_PROPERTY];
      });
      return 'removed';
    } catch {
      // processFrontMatter throws on invalid YAML (e.g. Templater
      // placeholders) — fall back to a raw text strip of the property.
      let stripped: string | undefined;
      try {
        stripped = stripFrontmatterFileId(await app.vault.read(file));
      } catch (readError) {
        return { path: entry.path, reason: reasonOf(readError) };
      }
      if (stripped === undefined) return 'skipped';
      try {
        opts.beforeWrite?.(entry.path);
        await app.vault.modify(file, stripped);
        return 'removed';
      } catch (writeError) {
        return { path: entry.path, reason: reasonOf(writeError) };
      }
    }
  } catch (error) {
    return { path: entry.path, reason: reasonOf(error) };
  }
}
