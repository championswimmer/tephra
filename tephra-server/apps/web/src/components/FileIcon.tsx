import { memo } from 'react';
import {
  File,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileText,
  FileType,
  FileVideo,
  type LucideIcon,
} from 'lucide-react';
import type { VaultFile } from '../api/types';

const CODE_EXTENSIONS = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'json',
  'css',
  'scss',
  'less',
  'html',
  'htm',
  'xml',
  'yml',
  'yaml',
  'toml',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'c',
  'h',
  'cpp',
  'hpp',
  'cs',
  'php',
  'swift',
  'kt',
  'sh',
  'bash',
  'sql',
  'graphql',
  'vue',
  'svelte',
]);

const ARCHIVE_EXTENSIONS = new Set(['zip', 'tar', 'gz', 'tgz', 'rar', '7z', 'bz2']);

function extensionOf(path: string): string {
  const base = path.split('/').pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLocaleLowerCase() : '';
}

/**
 * Pure mapper from a vault file to its Lucide file-type icon. Exported for
 * unit testing; the component below is the memoized render wrapper.
 */
export function fileIconForFile(file: Pick<VaultFile, 'kind' | 'mimeType' | 'path'>): LucideIcon {
  if (file.kind === 'markdown') return FileText;
  const mime = file.mimeType?.toLocaleLowerCase() ?? '';
  if (mime.startsWith('image/')) return FileImage;
  if (mime.startsWith('video/')) return FileVideo;
  if (mime.startsWith('audio/')) return FileAudio;
  if (mime === 'application/pdf') return FileType;
  if (mime.startsWith('text/') && mime !== 'text/plain') return FileCode;
  if (mime.includes('zip') || mime.includes('tar') || mime.includes('compressed')) {
    return FileArchive;
  }
  const ext = extensionOf(file.path);
  if (ext === 'pdf') return FileType;
  if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(ext)) return FileImage;
  if (['mp4', 'webm', 'mov', 'mkv', 'avi'].includes(ext)) return FileVideo;
  if (['mp3', 'wav', 'ogg', 'flac', 'm4a'].includes(ext)) return FileAudio;
  if (CODE_EXTENSIONS.has(ext)) return FileCode;
  if (ARCHIVE_EXTENSIONS.has(ext)) return FileArchive;
  return File;
}

export const FileIcon = memo(function FileIcon({
  file,
  size = 14,
}: {
  file: Pick<VaultFile, 'kind' | 'mimeType' | 'path'>;
  size?: number;
}) {
  const Icon = fileIconForFile(file);
  return <Icon size={size} aria-hidden="true" focusable="false" className="icon" />;
});
