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
        fileId = await this.markdownFileId(file);
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

  private async markdownFileId(file: TFile): Promise<string> {
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const existing = frontmatter?.[FILE_ID_PROPERTY];
    if (typeof existing === 'string' && existing.trim()) return existing.trim();
    const id = newFileId();
    await this.writeMarkdownFileId(file, id);
    return id;
  }

  private async writeMarkdownFileId(file: TFile, id: string): Promise<void> {
    this.beforeFrontmatterWrite(file.path);
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      frontmatter[FILE_ID_PROPERTY] = id;
    });
  }
}
