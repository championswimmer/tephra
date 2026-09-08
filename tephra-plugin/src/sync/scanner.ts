import type { App, TFile } from 'obsidian';
import type { SyncManifestEntry } from '@tephra/protocol';
import type { LocalFileState } from '../state/plugin-state';
import { sha256Hex } from './hasher';
import { sortManifest } from './manifest';

export const FILE_ID_PROPERTY = 'tephra-file-id';
const TEMP_SUFFIXES = ['~', '.tmp', '.temp', '.swp', '.swo', '.part'];

export function shouldSyncPath(path: string): boolean {
  if (!path || path.includes('\\') || path.startsWith('/')) return false;
  const segments = path.split('/');
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) return false;
  if (segments.some((segment) => segment.startsWith('.'))) return false;
  const name = segments.at(-1)?.toLowerCase() ?? '';
  return !name.startsWith('~$') && !TEMP_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function newFileId(): string {
  return `file_${globalThis.crypto.randomUUID()}`;
}

async function deterministicAttachmentId(path: string): Promise<string> {
  return `file_attachment_${await sha256Hex(new TextEncoder().encode(path))}`;
}

export function extractFrontmatterFileId(content: string): string | undefined {
  const match = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
  if (!match) return undefined;
  const prop = new RegExp(`^${FILE_ID_PROPERTY}:\\s*(?:["']?)([^"'\r\n#]+)(?:["']?)`, 'm').exec(
    match[1] ?? '',
  );
  const id = prop?.[1]?.trim();
  return id || undefined;
}

export function injectFrontmatterFileId(content: string, id: string): string {
  const crlf = content.includes('\r\n');
  const newline = crlf ? '\r\n' : '\n';

  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/.exec(content);
  if (frontmatterMatch) {
    const rawFm = frontmatterMatch[1] ?? '';
    const propRegex = new RegExp(`^${FILE_ID_PROPERTY}:.*$`, 'm');
    if (propRegex.test(rawFm)) {
      const updatedFm = rawFm.replace(propRegex, `${FILE_ID_PROPERTY}: ${id}`);
      return content.replace(rawFm, updatedFm);
    }
  }

  if (content.startsWith('---\r\n')) {
    return `---\r\n${FILE_ID_PROPERTY}: ${id}\r\n${content.slice(5)}`;
  }
  if (content.startsWith('---\n')) {
    return `---\n${FILE_ID_PROPERTY}: ${id}\n${content.slice(4)}`;
  }

  return `---${newline}${FILE_ID_PROPERTY}: ${id}${newline}---${newline}${newline}${content}`;
}

export function stripFrontmatterFileId(content: string): string | undefined {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n(?:---|\.\.\.))(\r?\n|$)/.exec(content);
  if (!match) return undefined;
  const open = match[1] ?? '';
  const rawFm = match[2] ?? '';
  const close = match[3] ?? '';
  const trailing = match[4] ?? '';
  const newline = content.includes('\r\n') ? '\r\n' : '\n';

  const lines = rawFm.split(/\r?\n/);
  const idx = lines.findIndex((line) =>
    new RegExp(`^${FILE_ID_PROPERTY}\\s*:.*$`).test(line),
  );
  if (idx === -1) return undefined;

  const rest = lines.filter((_, i) => i !== idx);
  if (rest.some((line) => line.trim() !== '')) {
    return `${open}${rest.join(newline)}${close}${trailing}${content.slice(match[0].length)}`;
  }
  // The property was the only key: drop the whole block and one following blank line.
  let body = content.slice(match[0].length);
  if (body.startsWith('\r\n')) body = body.slice(2);
  else if (body.startsWith('\n')) body = body.slice(1);
  return body;
}

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

export interface ScanResult {
  files: SyncManifestEntry[];
  attachmentIds: Record<string, string>;
}

export class VaultScanner {
  constructor(
    private readonly app: App,
    private readonly beforeFrontmatterWrite: (path: string) => void = () => undefined,
  ) {}

  async scan(
    previous: Readonly<Record<string, LocalFileState>>,
    attachmentIds: Readonly<Record<string, string>>,
  ): Promise<ScanResult> {
    const entries: SyncManifestEntry[] = [];
    const nextAttachmentIds: Record<string, string> = {};
    const claimedIds = new Set<string>();

    for (const file of this.app.vault.getFiles()) {
      if (!shouldSyncPath(file.path)) continue;
      const markdown = file.extension.toLowerCase() === 'md';
      let fileId: string;
      if (markdown) {
        fileId = await this.markdownFileId(file, previous, attachmentIds, nextAttachmentIds);
      } else {
        fileId =
          attachmentIds[file.path] ??
          previous[file.path]?.fileId ??
          (await deterministicAttachmentId(file.path));
        nextAttachmentIds[file.path] = fileId;
      }
      if (claimedIds.has(fileId)) {
        // Duplicate copied frontmatter must not make an invalid manifest.
        fileId = newFileId();
        if (markdown) await this.writeMarkdownFileId(file, fileId);
        else nextAttachmentIds[file.path] = fileId;
      }
      claimedIds.add(fileId);

      const saved = previous[file.path];
      const type = mimeType(file);
      if (
        saved &&
        saved.fileId === fileId &&
        saved.mtime === file.stat.mtime &&
        saved.size === file.stat.size
      ) {
        entries.push({ ...saved, ...(type === undefined ? {} : { mimeType: type }) });
        continue;
      }
      const bytes = markdown
        ? new TextEncoder().encode(await this.app.vault.read(file))
        : new Uint8Array(await this.app.vault.readBinary(file));
      entries.push({
        fileId,
        path: file.path,
        hash: await sha256Hex(bytes),
        size: bytes.byteLength,
        mtime: file.stat.mtime,
        ...(type === undefined ? {} : { mimeType: type }),
        kind: markdown ? 'markdown' : 'attachment',
      });
    }
    return { files: sortManifest(entries), attachmentIds: nextAttachmentIds };
  }

  private async markdownFileId(
    file: TFile,
    previous: Readonly<Record<string, LocalFileState>>,
    attachmentIds: Readonly<Record<string, string>>,
    nextAttachmentIds: Record<string, string>,
  ): Promise<string> {
    try {
      const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
      const existing = frontmatter?.[FILE_ID_PROPERTY];
      if (typeof existing === 'string' && existing.trim()) return existing.trim();
    } catch {
      // Obsidian cache lookup failed; continue to direct content read
    }

    let content: string | undefined;
    try {
      content = await this.app.vault.read(file);
      const rawId = extractFrontmatterFileId(content);
      if (rawId) return rawId;
    } catch {
      // Direct file read failed; continue to ID write
    }

    const id = newFileId();
    const written = await this.writeMarkdownFileId(file, id, content);
    if (written) return id;

    const fallbackId =
      attachmentIds[file.path] ??
      previous[file.path]?.fileId ??
      (await deterministicAttachmentId(file.path));
    nextAttachmentIds[file.path] = fallbackId;
    return fallbackId;
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
